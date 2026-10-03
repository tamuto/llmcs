"""codex app-server を LLM バックエンドとして使う。

`codex app-server` は stdio 上の JSON-RPC サーバ。手順は次の通り:

    initialize (request)
    initialized (notification)
    thread/start (request)      -> threadId
    turn/start  (request)       -> 以降イベントが notification で流れてくる
      item/completed (type=agentMessage)  <- 最終回答
      turn/completed                      <- ターン終了

`turn/start` の `outputSchema` に JSON Schema を渡すと最終メッセージが
その形の JSON に拘束されるので、こちらでのパース補正は不要。

会話ごとに新しいスレッドを張り、前の会話の内容を持ち越さない。
"""

from __future__ import annotations

import base64
import hashlib
import json
import queue
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self

from .base import LLMError

CLIENT_NAME = "codex_app_server_client"

ACTIVITY_INTERVAL = 60.0
"""1回の応答が長引いたときに様子を報せる間隔 (秒)。"""

# 解析中に現れてよい item の型。
#
# codex app-server には「ツール無し」で動かす方法が無く、シェル実行・Web
# アクセス・サブエージェント起動などが常に有効になっている。利用側が
# 渡すのは**他人が書いたかもしれない文章**なので、その中の一節を
# 指示と解釈してモデルが動き出す余地がある。
#
# baseInstructions で「ツールを使うな」と書いてはいるが、あれは強制力の無い
# お願いにすぎない。ここに無い型が出てきたら、解析ではない何かが始まって
# いるということなので、ターンごと打ち切る。
ALLOWED_ITEM_TYPES = frozenset(
    {
        "userMessage",
        "agentMessage",
        "reasoning",
        "contextCompaction",
    }
)

RESEARCH_DECLINE_TYPES = frozenset({"commandExecution"})
"""始めてもよいが、実行はさせない型。

調べる対象がこの端末に入っているツールだと、モデルが手元の版を見に行こうとして
シェルを使い始めることがある。そこでターンごと打ち切ると、web検索へ切り替えて
やり直す余地まで潰れてしまう。プロトコルには「断ったうえでターンは続ける」決定
(decline) があるので、開始は通し、承認要求を断って続けさせる。

**実行そのものは許さない。** 断る前に実行まで進んだ場合はターンを打ち切る。
"""

RESEARCH_ITEM_TYPES = ALLOWED_ITEM_TYPES | {"webSearch"}
"""検索して調べる用途で許す型。

既定 (ALLOWED_ITEM_TYPES) との違いは webSearch だけ。こちらを渡しても、
シェル実行・ファイル変更・サブエージェント起動は従来どおり打ち切る。
利用者自身が入力した語を調べさせる場合のように、**入力が未信頼でない**
ことを呼び出し側が確かめたときにだけ使う。
"""

IMAGE_ITEM_TYPES = ALLOWED_ITEM_TYPES | {"imageGeneration"}
"""画像を作らせる用途で許す型。

既定 (ALLOWED_ITEM_TYPES) との違いは imageGeneration だけ。シェル実行・
ファイル変更・web 検索は従来どおり打ち切る。
"""

EXTRA_INPUT_TYPES = frozenset({"text", "image"})
"""ターンの入力に足してよい項目の型。

app-server の入力には、この端末のファイルを指す型 (localImage, localAudio,
mention, skill) もある。それらを通すと、呼び出し側が渡したパスを codex が
読みに行く。**中身を渡す型だけ**に限り、パスを渡す型は受け取らない。
画像は data: URL で渡せるので、これで足りる。
"""

# 待てば直る種類の失敗。codex が codexErrorInfo で返す分類のうち、
# 混雑・一時的な接続断にあたるもの。認証エラーや入力が長すぎるといった、
# 待っても直らないものは含めない。
RETRYABLE_ERRORS = frozenset(
    {
        "serverOverloaded",
        "internalServerError",
        "httpConnectionFailed",
        "responseStreamConnectionFailed",
        "responseStreamDisconnected",
        "responseStreamRetryLimit",
    }
)

# 分類が付かないことがあるので、本文からも判定する。
RETRYABLE_PHRASES = (
    "at capacity",
    "overloaded",
    "temporarily unavailable",
    "try again",
    "rate limit",
)

# 起動時に足す config 上書き。MCP の無効化は _mcp_overrides() が組み立てる。
DEFAULT_CONFIG_OVERRIDES: tuple[str, ...] = ()


@dataclass(frozen=True)
class GeneratedImage:
    """imageGeneration で作られた 1 枚。"""

    data: bytes
    """画像のバイト列 (PNG)。"""

    saved_path: str | None
    """codex が保存した場所。codex の作業領域なので、残したいなら呼び出し側で写す。"""

    revised_prompt: str | None
    """画像モデルに実際に渡ったプロンプト。codex が書き直すことがある。"""


class CodexAppServerClient:
    """`codex app-server` プロセスを1つ抱えて使い回す。"""

    def __init__(
        self,
        *,
        command: str = "codex",
        model: str | None = None,
        cwd: str | None = None,
        timeout: float = 300.0,
        config_overrides: tuple[str, ...] = DEFAULT_CONFIG_OVERRIDES,
        turn_timeout: float = 600.0,
        max_output_chars: int = 100_000,
        max_retries: int = 3,
        max_runaway_retries: int = 1,
        retry_delay: float = 20.0,
        web_search: str | None = None,
        allowed_item_types: frozenset[str] = ALLOWED_ITEM_TYPES,
        decline_item_types: frozenset[str] = frozenset(),
        max_declines: int = 3,
        on_activity: Callable[[float, int], None] | None = None,
        on_retry: Callable[[int, int, float, str], None] | None = None,
    ) -> None:
        self._command = command
        self._model = model
        self._cwd = cwd
        self._timeout = timeout
        self._config_overrides = config_overrides
        self._turn_timeout = turn_timeout
        self._max_output_chars = max_output_chars
        self._max_retries = max_retries
        self._max_runaway_retries = max_runaway_retries
        self._retry_delay = retry_delay
        self._web_search = web_search
        self._allowed_item_types = allowed_item_types
        self._decline_item_types = decline_item_types
        self._max_declines = max_declines
        self._declined_items: set[str] = set()
        self._on_activity = on_activity or (lambda *_: None)
        self._on_retry = on_retry or (lambda *_: None)

        self._denied: list[str] = []
        self._mcp_override_cache: list[str] | None = None
        self._proc: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._next_id = 0
        self._lock = threading.Lock()
        self.resolved_model: str | None = None
        """実際に使われたモデル名。thread/start の応答で判明する。"""

        self.last_token_usage: dict[str, Any] | None = None

        self.last_declined: list[dict[str, Any]] = []
        """断ったツール利用。何を試そうとしたかを残す。"""

        self.last_images: list[GeneratedImage] = []
        """直近の応答で作られた画像。generate_image を呼んだときだけ入る。"""

        self.last_message: str | None = None
        """直近の応答の最終メッセージ。画像生成では断り文句などが入る。"""

        self.last_web_searches: list[dict[str, Any]] = []
        """直近の応答で実際に検索した内容。web検索を許したときだけ入る。

        何を調べた結果なのかを呼び出し側が記録に残せるようにする。
        """

    # ------------------------------------------------------------------ 公開API

    @property
    def fingerprint(self) -> str:
        """recipe ハッシュに混ぜる識別子。

        設定値のみから決まる。実際に使われたモデル名 (resolved_model) は
        混ぜない。プロセスを起動しないと分からない値を混ぜると、
        `status` と `build` で fingerprint がずれてしまうため。
        codex 側の既定モデル変更を再生成のきっかけにしたい場合は、
        呼び出し側で `model` を明示的に渡す。
        """
        base = f"codex-app-server:{self._model or 'default'}"
        if self._web_search:
            # 検索の有無で答えが変わるので、同じモデルでも別物として扱う。
            base += f":web-{self._web_search}"
        if not self._config_overrides:
            return base
        config_hash = hashlib.sha256(json.dumps(self._config_overrides).encode()).hexdigest()[:16]
        return f"{base}:{config_hash}"

    def generate_json(
        self,
        *,
        instructions: str,
        prompt: str,
        schema: dict,
        extra_input: tuple[dict, ...] = (),
    ) -> dict:
        """一時的な失敗は待って投げ直す。

        実データで 40 件のタグノートを作った際、2 件が
        「Selected model is at capacity」で落ちた。数百件を流す運用では
        この種の失敗は必ず起きるので、呼び出し側に投げる前にここで粘る。
        """
        last: LLMError | None = None
        runaway_attempts = 0

        for attempt in range(self._max_retries + 1):
            try:
                return self._generate_once(
                    instructions=instructions,
                    prompt=prompt,
                    schema=schema,
                    extra_input=extra_input,
                )
            except LLMError as exc:
                if not exc.retryable or attempt == self._max_retries:
                    raise
                if exc.kind == "runaway":
                    # 暴走は混雑と違い、同じプロンプトで再現しやすい。
                    # 何度も投げ直すのは相手にも自分にも無駄なので、
                    # 混雑とは別に少ない回数で見切る。
                    runaway_attempts += 1
                    if runaway_attempts > self._max_runaway_retries:
                        raise
                last = exc
                # 混雑が理由なので、間隔を空けながら待つ。
                delay = self._retry_delay * (2**attempt)
                self._on_retry(attempt + 1, self._max_retries, delay, str(exc))
                time.sleep(delay)

        raise last if last else LLMError("LLM 呼び出しに失敗しました。")

    def _generate_once(
        self,
        *,
        instructions: str,
        prompt: str,
        schema: dict,
        extra_input: tuple[dict, ...] = (),
    ) -> dict:
        with self._lock:
            self._reset_last()
            self._ensure_started()
            thread_id = self._start_thread(instructions)
            text = self._run_turn(thread_id, prompt, schema, extra_input)
        if not text:
            raise LLMError("codex から最終メッセージが返りませんでした。")

        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:  # outputSchema があるので通常起きない
            raise LLMError(f"LLM の応答を JSON として解釈できません: {text[:200]}") from exc

    def generate_image(
        self,
        *,
        instructions: str,
        prompt: str,
        extra_input: tuple[dict, ...] = (),
    ) -> list[GeneratedImage]:
        """codex の画像生成ツールで画像を作らせる。

        参照画像は extra_input に `{"type": "image", "url": "data:image/png;base64,..."}`
        で渡す。許すツールは imageGeneration だけで、それ以外が始まれば打ち切る。
        一時的な失敗の扱いは generate_json と同じ。
        """
        last: LLMError | None = None
        for attempt in range(self._max_retries + 1):
            try:
                with self._lock:
                    self._reset_last()
                    self._ensure_started()
                    thread_id = self._start_thread(instructions)
                    self._run_turn(
                        thread_id,
                        prompt,
                        None,
                        extra_input,
                        allowed_item_types=self._allowed_item_types | {"imageGeneration"},
                    )
                if not self.last_images:
                    # 画像を作らずに文章だけ返すことがある (断り・質問返し)。
                    raise LLMError(
                        "画像が作られませんでした: " + (self.last_message or "(応答なし)")[:300],
                        kind="no-image",
                    )
                return list(self.last_images)
            except LLMError as exc:
                if not exc.retryable or attempt == self._max_retries:
                    raise
                last = exc
                delay = self._retry_delay * (2**attempt)
                self._on_retry(attempt + 1, self._max_retries, delay, str(exc))
                time.sleep(delay)

        raise last if last else LLMError("画像生成に失敗しました。")

    def _reset_last(self) -> None:
        self.last_token_usage = None
        self.last_web_searches = []
        self.last_declined = []
        self.last_images = []
        self.last_message = None
        self._declined_items = set()

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        self._reader = None
        if proc is None:
            return
        try:
            proc.stdin.close()  # type: ignore[union-attr]
        except (OSError, ValueError):
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # --------------------------------------------------------------- プロセス

    def _mcp_overrides(self) -> list[str]:
        """設定済みの MCP サーバを無効にする上書きを組み立てる。

        このクライアントは文章を解析させるだけでツールを使わせない。MCP サーバは
        トークンとレイテンシを食うだけで役に立たない。

        **これは最適化ではなく必須の処理。** codex は会話 (thread) ごとに
        MCP サーバを起動し、thread が終わっても落とさない。1会話1スレッド、
        長い会話は分割ぶんだけスレッドを張る作りなので、放っておくと
        LLM 呼び出しの数だけプロセスが残る。実際に 1 回の build で 26 個の
        MCP サーバが残り、3.6GB を占有して処理が這うほど遅くなった。

        `-c mcp_servers={}` では消えない (上書きはテーブルに**マージ**される)。
        サーバ名を列挙して1つずつ `enabled=false` にする必要がある。
        """
        if self._mcp_override_cache is not None:
            return self._mcp_override_cache

        overrides: list[str] = []
        try:
            result = subprocess.run(
                [self._command, "mcp", "list", "--json"],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            for entry in json.loads(result.stdout or "[]"):
                name = entry.get("name")
                if name:
                    overrides.append(f"mcp_servers.{name}.enabled=false")
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            # 列挙できなくても解析自体はできる。処理を止めるほどではない。
            overrides = []

        self._mcp_override_cache = overrides
        return overrides

    def _ensure_started(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return

        args = [self._command, "app-server"]
        for override in [*self._mcp_overrides(), *self._config_overrides]:
            args += ["-c", override]

        try:
            self._proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except FileNotFoundError as exc:
            raise LLMError(
                f"{self._command!r} が見つかりません。codex CLI をインストールしてください。"
            ) from exc

        # stdout を専用スレッドで読む。こうしないとタイムアウトが効かず、
        # codex 側が黙り込んだときに永久にブロックする。
        self._lines = queue.Queue()
        self._reader = threading.Thread(
            target=self._pump_stdout, args=(self._proc, self._lines), daemon=True
        )
        self._reader.start()

        self._request(
            "initialize",
            {"clientInfo": {"name": CLIENT_NAME, "version": _version()}},
        )
        self._notify("initialized", None)

    def _start_thread(self, instructions: str) -> str:
        params: dict[str, Any] = {
            "sandbox": "read-only",
            # "never" だと承認を求めずに実行してしまう。"untrusted" にすると
            # 承認要求が飛んでくるので、それを cancel で断てる。
            "approvalPolicy": "untrusted",
            "ephemeral": True,
            "baseInstructions": instructions,
        }
        if self._cwd:
            params["cwd"] = self._cwd
        if self._model:
            params["model"] = self._model
        if self._web_search:
            # 既定 (None) では何も足さない。検索を許していない呼び出し側の
            # 振る舞いは変わらない。
            params["config"] = {"web_search": self._web_search}

        result = self._request("thread/start", params)
        self.resolved_model = result.get("model") or self.resolved_model
        return result["thread"]["id"]

    def _run_turn(
        self,
        thread_id: str,
        prompt: str,
        schema: dict | None,
        extra_input: tuple[dict, ...] = (),
        *,
        allowed_item_types: frozenset[str] | None = None,
    ) -> str | None:
        """1 ターン回して最終メッセージを返す。schema が None なら出力を拘束しない。"""
        allowed = allowed_item_types or self._allowed_item_types
        params: dict[str, Any] = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": prompt}, *_checked_input(extra_input)],
        }
        if schema is not None:
            params["outputSchema"] = schema
        request_id = self._send_request("turn/start", params)

        answer: str | None = None
        turn_id: str | None = None
        streamed = 0
        started = time.monotonic()
        deadline = started + self._turn_timeout
        next_report = started + ACTIVITY_INTERVAL

        for message in self._read_messages():
            if message.get("id") == request_id:
                # turn/start 自体の応答。エラーならここで落ちる。
                _raise_if_error(message, "turn/start")
                continue

            method = message.get("method")
            params = message.get("params") or {}
            turn_id = turn_id or (params.get("turn") or {}).get("id") or params.get("turnId")

            if method == "item/agentMessage/delta":
                # 応答が止まらなくなることがある。文字数で早めに見切る。
                streamed += len(params.get("delta") or "")
                if streamed > self._max_output_chars:
                    self._abort(thread_id, turn_id)
                    raise LLMError(
                        f"応答が {streamed:,} 文字を超えました。生成が止まらなくなっています。",
                        retryable=True,
                        kind="runaway",
                    )
            elif method == "item/started":
                item = params.get("item") or {}
                kind = item.get("type") or "?"
                if kind in self._decline_item_types:
                    # 開始は通す。承認要求を断って続けさせる (→ _reject_server_request)。
                    self.last_declined.append(
                        {"type": kind, "id": item.get("id"), "command": item.get("command")}
                    )
                    if len(self.last_declined) > self._max_declines:
                        # 断っても切り替わらない。粘っても予算を使うだけなので止める。
                        self._abort(thread_id, turn_id)
                        raise LLMError(
                            f"{kind} を {len(self.last_declined)} 回試みました。"
                            "web検索へ切り替わらないため中断します。",
                        )
                elif kind not in allowed:
                    # 会話ログの中の文章を指示と解釈して動き出している。
                    self._abort(thread_id, turn_id)
                    raise LLMError(
                        f"解析中に {kind} が始まりました。会話ログの内容を"
                        "指示として実行しようとした可能性があります。",
                    )
            elif method == "item/completed":
                item = params.get("item") or {}
                if (
                    item.get("type") in self._decline_item_types
                    and item.get("id") not in self._declined_items
                ):
                    # 断る前に実行まで進んだ。この用途では実行を許していない。
                    self._abort(thread_id, turn_id)
                    raise LLMError(
                        f"{item.get('type')} が断る前に実行されました。"
                        "この用途では実行を許していません。",
                    )
                if item.get("type") == "webSearch":
                    self.last_web_searches.append(
                        {"query": item.get("query"), "action": item.get("action")}
                    )
                if item.get("type") == "imageGeneration":
                    self._collect_image(item)
                if item.get("type") == "agentMessage":
                    # 途中経過のメッセージが挟まることがあるので最後のものを採る。
                    answer = item.get("text") or answer
                    self.last_message = answer
            elif method == "thread/tokenUsage/updated":
                self.last_token_usage = (params.get("tokenUsage") or {}).get("last")
            elif method == "error":
                if not params.get("willRetry"):
                    # codex 自身が再試行する分 (willRetry) はここで止めない。
                    raise _turn_error(params.get("error"))
            elif method == "turn/completed":
                turn = params.get("turn") or {}
                if turn.get("status") != "completed":
                    raise _turn_error(turn.get("error"), turn.get("status"))
                break

            now = time.monotonic()
            if now > next_report:
                # 何も出さないと「止まった」のか「時間がかかっている」のか
                # 区別が付かない。長引いたときだけ様子を報せる。
                self._on_activity(now - started, streamed)
                next_report = now + ACTIVITY_INTERVAL

            if now > deadline:
                # 文字数の上限に達しない遅い暴走に対する歯止め。
                self._abort(thread_id, turn_id)
                raise LLMError(
                    f"1回の応答に {self._turn_timeout:.0f} 秒以上かかっています。",
                    retryable=True,
                    kind="runaway",
                )

        return answer

    def _collect_image(self, item: dict) -> None:
        """imageGeneration の完了 item から画像を取り出す。

        失敗した生成 (failure あり) は捨てる。画像の中身は savedPath のファイルか、
        result の base64 のどちらかにある。
        """
        if item.get("failure"):
            return
        saved = item.get("savedPath")
        data: bytes | None = None
        if saved and Path(saved).is_file():
            data = Path(saved).read_bytes()
        elif item.get("result"):
            raw = str(item["result"])
            if raw.startswith("data:"):
                raw = raw.split(",", 1)[1]
            try:
                data = base64.b64decode(raw, validate=True)
            except ValueError:
                data = None
        if data:
            self.last_images.append(
                GeneratedImage(
                    data=data, saved_path=saved, revised_prompt=item.get("revisedPrompt")
                )
            )

    def _abort(self, thread_id: str, turn_id: str | None) -> None:
        """暴走したターンを止める。

        interrupt を投げたうえでプロセスごと畳む。中途半端な状態の
        スレッドを抱えたまま次の会話に進むより、起動し直す方が確実で、
        起動は1秒ほどしかかからない。
        """
        if turn_id:
            try:
                self._notify_interrupt(thread_id, turn_id)
            except LLMError:
                pass
        self.close()

    def _notify_interrupt(self, thread_id: str, turn_id: str) -> None:
        self._send_request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})

    # ------------------------------------------------------------- JSON-RPC

    def _request(self, method: str, params: dict | None) -> dict:
        request_id = self._send_request(method, params)
        for message in self._read_messages():
            if message.get("id") == request_id:
                _raise_if_error(message, method)
                return message.get("result") or {}
        raise LLMError(f"{method} の応答が返る前に codex app-server が終了しました。")

    def _send_request(self, method: str, params: dict | None) -> int:
        self._next_id += 1
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
        }
        if params is not None:
            payload["params"] = params
        self._write(payload)
        return self._next_id

    def _notify(self, method: str, params: dict | None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._write(payload)

    def _write(self, payload: dict) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise LLMError("codex app-server が起動していません。")
        try:
            proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, ValueError) as exc:
            raise LLMError("codex app-server への書き込みに失敗しました。") from exc

    @staticmethod
    def _pump_stdout(proc: subprocess.Popen[str], sink: queue.Queue[str | None]) -> None:
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                sink.put(line)
        finally:
            sink.put(None)  # EOF

    def _read_messages(self) -> Iterator[dict]:
        """サーバからの1行1メッセージを読む。

        timeout は「無出力が続いた時間」に対して効く。ターン全体の長さではなく、
        イベントが途絶えてからの秒数なので、長い応答でも誤って打ち切らない。

        サーバ発の request (承認要求など) は sandbox=read-only /
        approvalPolicy=never のため通常来ないが、来た場合に黙って詰まると
        原因が分からないので明示的に断る。
        """
        if self._proc is None:
            raise LLMError("codex app-server が起動していません。")

        while True:
            try:
                line = self._lines.get(timeout=self._timeout)
            except queue.Empty:
                # 応答が来ないのは詰まりであって、内容の問題ではない。
                # 投げ直せば通ることがある。
                raise LLMError(
                    f"codex app-server が {self._timeout:.0f} 秒応答しませんでした。",
                    retryable=True,
                ) from None

            if line is None:
                return

            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue

            if "method" in message and "id" in message:
                self._reject_server_request(message)
                continue
            yield message

    def _reject_server_request(self, message: dict) -> None:
        """サーバからの要求はすべて断る。

        承認要求は「エラー」ではなく**正式な拒否**として返す。エラーで返すと
        codex 側が失敗として扱い、別の手段を試すことがある。`cancel` は
        「拒否したうえでターンも中断する」という意味なので、
        解析以外のことを始めた時点で確実に止まる。
        """
        method = message.get("method", "")
        params = message.get("params") or {}
        if "commandExecution" in method and self._decline_item_types:
            # decline は cancel と違い、断ってもターンが続く。モデルは別の手段
            # (web検索) へ切り替えられる。
            item_id = params.get("itemId")
            if item_id:
                self._declined_items.add(item_id)
            for record in self.last_declined:
                if record.get("id") == item_id and not record.get("command"):
                    record["command"] = params.get("command")
            self._write({"jsonrpc": "2.0", "id": message["id"], "result": {"decision": "decline"}})
            self._denied.append(method)
            return
        if "requestApproval" in method or "Approval" in method:
            self._write({"jsonrpc": "2.0", "id": message["id"], "result": {"decision": "cancel"}})
            self._denied.append(method)
            return

        self._write(
            {
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {
                    "code": -32601,
                    "message": f"codex-app-server-client は {method} に対応していません。",
                },
            }
        )


def _checked_input(items: tuple[dict, ...]) -> list[dict]:
    """追加の入力項目を、渡してよい型だけに絞る。

    通すのは中身をそのまま持つ型 (text, image) だけ。ファイルのパスを渡す型は
    codex がその場所を読みに行くので、呼び出し側から使えないようにする。
    間違った型は黙って捨てずに断る。捨てると、渡したつもりのものが
    モデルに届かないまま答えが返る。
    """
    checked = []
    for item in items:
        kind = (item or {}).get("type")
        if kind not in EXTRA_INPUT_TYPES:
            raise LLMError(
                f"入力に足せるのは {'/'.join(sorted(EXTRA_INPUT_TYPES))} だけです: {kind}"
            )
        checked.append(dict(item))
    return checked


def _raise_if_error(message: dict, method: str) -> None:
    if "error" in message:
        error = message["error"] or {}
        raise LLMError(f"{method} が失敗しました: {error.get('message') or error}")


def _turn_error(error: object, status: str | None = None) -> LLMError:
    """codex のエラーを、待てば直るかどうかの判断つきで包む。"""
    message = ""
    info: object = None

    if isinstance(error, dict):
        message = str(error.get("message") or "")
        info = error.get("codexErrorInfo")
    elif error:
        message = str(error)

    prefix = (
        f"ターンが完了しませんでした ({status}): " if status else "codex がエラーを返しました: "
    )
    return LLMError(prefix + (message or "詳細不明"), retryable=_is_retryable(info, message))


def _is_retryable(info: object, message: str) -> bool:
    # codexErrorInfo は文字列のこともオブジェクトのこともある。
    if isinstance(info, str) and info in RETRYABLE_ERRORS:
        return True
    if isinstance(info, dict) and any(key in RETRYABLE_ERRORS for key in info):
        return True

    lowered = message.lower()
    return any(phrase in lowered for phrase in RETRYABLE_PHRASES)


def _version() -> str:
    from . import __version__

    return __version__
