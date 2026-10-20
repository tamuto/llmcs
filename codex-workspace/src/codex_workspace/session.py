"""コンテナの中の codex app-server を、作業場所を渡して動かす。

作業場所 (ホストのフォルダ) を /workspace にマウントしたコンテナで app-server を起こし、
`docker run -i` の標準入出力を JSON-RPC の経路にする。コンテナが囲いになるので、Codex には
danger-full-access でコマンドの実行とファイルの書き込みを許し、承認は求めさせない。
コンテナに入れるのは作業場所と認証情報のファイル1つだけで、ホストのほかの場所は見えない。

スレッドを1つ立て、同じスレッドに続けて頼める (前のやり取りの文脈とキャッシュが続く)。
頼むたびに、Codex が書き換えたファイル、動かしたコマンド、使ったトークンを返すので、
呼ぶ側はその結果を確かめて、崩れていれば作業場所を元に戻せばよい。

認証は2通り。Codex の初期設定でサインインした auth.json をマウントするか、Sign in with ChatGPT で
呼ぶ側が得た access token を環境変数で渡す (chatgpt_plan_overrides)。後者ではファイルをマウントせず、
トークンの値はコマンドの引数に入れない。

作業場所のパスは、Docker のデーモンから見た場所 (ホストの場所) で渡す。開発環境の
コンテナの中から動かすときは、そのコンテナの中の場所とは違うことがある。
"""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from importlib import resources
from pathlib import Path
from typing import Any, Self

DEFAULT_IMAGE = "llmcs-codex-workspace:local"
CONTAINER_WORKSPACE = "/workspace"
CONTAINER_AUTH = "/codex/auth.json"
CLIENT_NAME = "codex_workspace"
CLIENT_VERSION = "0.3.1"

ACCESS_TOKEN_ENV = "ACCESS_TOKEN"
"""Sign in with ChatGPT の access token を app-server に渡す環境変数の既定の名前。"""
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def chatgpt_plan_overrides(env_key: str = ACCESS_TOKEN_ENV) -> list[str]:
    """Sign in with ChatGPT のプラン利用で app-server を動かす設定 (公式の Codex app-server の手順のとおり)。

    Codex は環境変数 env_key の値を `Authorization: Bearer` で /v1/responses に送る。
    Codex 自身のサインインは要らない。
    """
    p = "model_providers.openai_chatgpt_plan"
    return [
        'model_provider="openai_chatgpt_plan"',
        f'{p}.name="ChatGPT plan"',
        f'{p}.base_url="https://api.openai.com/v1"',
        f'{p}.env_key="{env_key}"',
        f'{p}.wire_api="responses"',
        f"{p}.requires_openai_auth=false",
        f"{p}.supports_websockets=false",
    ]


class WorkspaceError(RuntimeError):
    pass


class UsageLimitError(WorkspaceError):
    """Codex の使用量の上限 (5時間や週の窓) に当たって、ターンが失敗した。

    待てば戻るが、すぐに頼み直しても同じように失敗する。呼び出し側は、続けて頼むのをやめる。
    """


# codexErrorInfo のうち、使用量の上限に当たったもの。
USAGE_LIMIT_ERRORS = frozenset({"usageLimitExceeded", "rateLimitExceeded"})
# Sign in with ChatGPT のプラン利用で、使用量の上限に当たったときの Responses のエラーコード。
PLAN_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded"


def _is_usage_limit(error: object) -> bool:
    info = error.get("codexErrorInfo") if isinstance(error, dict) else None
    if isinstance(info, str) and info in USAGE_LIMIT_ERRORS:
        return True
    if isinstance(info, dict) and any(key in USAGE_LIMIT_ERRORS for key in info):
        return True
    # 独自の provider では、API のエラーが本文のまま届く。
    return PLAN_USAGE_LIMIT_CODE in json.dumps(error, ensure_ascii=False)


@dataclass
class Usage:
    """アカウントの使用量 (account/rateLimits/read)。

    windows は、窓の長さ (分) から、使った割合 (%) への対応。ChatGPT のプランでは、
    5時間 (300分) と週 (10080分) の2つ。allowed は、ふつうに使ってよいかの、
    サーバー側の判断 (分からなければ None)。reached は、上限に当たっていればその種類。
    """

    windows: dict[int, int]
    allowed: bool | None
    reached: str | None

    def used(self, minutes: int) -> int | None:
        return self.windows.get(minutes)


def parse_usage(result: dict[str, Any]) -> Usage:
    limits = result.get("rateLimits") or {}
    windows = {}
    for name in ("primary", "secondary"):
        window = limits.get(name) or {}
        if window.get("windowDurationMins") is not None:
            windows[int(window["windowDurationMins"])] = int(window.get("usedPercent") or 0)
    return Usage(
        windows=windows,
        allowed=result.get("ordinaryUsageAllowed"),
        reached=limits.get("rateLimitReachedType"),
    )


@dataclass
class TurnResult:
    status: str
    message: str | None
    """最後の応答の文。"""

    changed: list[str] = field(default_factory=list)
    """書き換えたファイル。作業場所からの相対パス。"""

    commands: list[dict[str, Any]] = field(default_factory=list)
    """動かしたコマンドと終了コード。"""

    usage: dict[str, Any] | None = None
    """このターンで使ったトークン。

    1回の頼みごとの中では、ファイルを読む、書くといった手順ごとにモデルへの問い合わせが
    重なる。app-server の tokenUsage.last は最後の1回分だけなので、スレッドの累計
    (tokenUsage.total) の、頼む前と後の差を取る。"""

    seconds: float = 0.0


@contextmanager
def docker_context() -> Iterator[Path]:
    """パッケージに同梱した Dockerfile のあるフォルダ (TypeScript 版と同じ内容)。

    `with docker_context() as path:` の中で使う (パッケージが zip のときは一時的に取り出す)。
    """
    with resources.as_file(resources.files(__package__) / "docker") as path:
        yield Path(path)


def ensure_image(
    image: str = DEFAULT_IMAGE,
    *,
    max_age: timedelta = timedelta(days=1),
    docker: str = "docker",
    now: datetime | None = None,
) -> str:
    """イメージが無いか、max_age より古ければ作り直す。返すのは中の Codex の版。

    Codex の版は固定しない。作り直すたびにその時点の最新を入れる。毎回作り直すと
    取得に時間がかかるので、作ってからの日数で決める。
    """
    moment = now or datetime.now(UTC)
    created = _image_created(image, docker)
    if created is None or moment - created > max_age:
        with docker_context() as directory:
            subprocess.run(
                [docker, "build", "-q", "-t", image,
                 "--build-arg", f"CODEX_REFRESH={moment.isoformat(timespec='seconds')}",
                 str(directory)],
                check=True, capture_output=True, text=True,
            )  # fmt: skip
    result = subprocess.run(
        [docker, "run", "--rm", "--entrypoint", "codex", image, "--version"],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    return result.stdout.strip()


def _image_created(image: str, docker: str) -> datetime | None:
    result = subprocess.run(
        [docker, "image", "inspect", "--format", "{{.Created}}", image],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    if result.returncode != 0:
        return None
    return parse_created(result.stdout.strip())


def parse_created(value: str) -> datetime | None:
    """Docker の作成日時 (2026-10-03T08:26:51.123456789Z)。ナノ秒は Python が読める桁に切る。"""
    if not value:
        return None
    value = value.removesuffix("Z")
    head, _, fraction = value.partition(".")
    if fraction:
        head += "." + fraction[:6]
    moment = datetime.fromisoformat(head)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def docker_command(
    workspace: str,
    *,
    image: str = DEFAULT_IMAGE,
    auth_volume: str | None = None,
    auth_subpath: str = "auth.json",
    auth_file: str | None = None,
    access_token_env: str | None = None,
    docker: str = "docker",
    config_overrides: tuple[str, ...] = (),
) -> list[str]:
    """app-server を起こす docker run。認証は、ボリュームの中のファイル・ホストのファイル・
    access token の環境変数のどれか1つ。

    認証情報のファイルは読み書きできるようにマウントする。Codex がトークンを更新したときに書き戻すため。

    access_token_env には、Sign in with ChatGPT の access token を入れた環境変数の名前を渡す。
    認証のファイルはマウントせず、`-e <名前>` で docker を起こしたプロセスの環境から値を引き継ぎ、
    chatgpt_plan_overrides の設定で app-server を起こす。値は引数に入らない
    (WorkspaceSession の env で渡す)。Codex はトークンを更新しないので、更新したら起動し直す
    (→ WorkspaceSession.restart)。
    """
    if [auth_volume, auth_file, access_token_env].count(None) != 2:
        raise ValueError("auth_volume・auth_file・access_token_env のどれか1つを渡してください")
    if access_token_env is not None and not ENV_NAME.fullmatch(access_token_env):
        raise ValueError(f"環境変数の名前ではありません: {access_token_env}")
    if access_token_env is not None:
        auth = ["-e", access_token_env]
    elif auth_volume is not None:
        mount = f"type=volume,src={auth_volume},dst={CONTAINER_AUTH},volume-subpath={auth_subpath}"
        auth = ["--mount", mount]
    else:
        auth = ["--mount", f"type=bind,src={auth_file},dst={CONTAINER_AUTH}"]
    command = [
        docker, "run", "-i", "--rm",
        "--mount", f"type=bind,src={workspace},dst={CONTAINER_WORKSPACE}",
        *auth,
        image,
    ]  # fmt: skip
    overrides = [*(chatgpt_plan_overrides(access_token_env) if access_token_env else ()),
                 *config_overrides]  # fmt: skip
    for override in overrides:
        command += ["-c", override]
    return command


class WorkspaceSession:
    def __init__(
        self,
        command: list[str],
        *,
        model: str | None = None,
        effort: str | None = None,
        env: Mapping[str, str] | None = None,
        client_info: Mapping[str, str] | None = None,
        turn_timeout: float = 1800.0,
        request_timeout: float = 120.0,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        """env は app-server (docker) のプロセスに足す環境変数 (Sign in with ChatGPT の access token など)。
        今のプロセスの環境に重ねて渡す。値はログや例外に出さない。

        client_info は initialize で名乗るアプリ ({"name", "title", "version"})。既定は codex_workspace。
        Sign in with ChatGPT では、name を登録のときの agent_name_hint と同じにする。
        """
        self._command = command
        self._model = model
        self._effort = effort
        self._env = dict(env) if env is not None else None
        self._client_info = dict(client_info or {"name": CLIENT_NAME, "version": CLIENT_VERSION})
        self._turn_timeout = turn_timeout
        self._request_timeout = request_timeout
        self._on_event = on_event or (lambda _event: None)
        self._proc: subprocess.Popen[str] | None = None
        self._lines: queue.Queue[str | None] = queue.Queue()
        self._next_id = 0
        self.thread_id: str | None = None
        self.model: str | None = None
        self._total: dict[str, Any] = {}
        """スレッドで使ったトークンの累計。"""

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def start(self) -> None:
        env = {**os.environ, **self._env} if self._env is not None else None
        try:
            self._proc = subprocess.Popen(
                self._command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
                env=env,
            )
        except OSError as exc:
            raise WorkspaceError(f"起動できません: {self._command[0]}") from exc
        # 起動し直したとき、前のプロセスの残りの行を読まない。
        self._lines = queue.Queue()
        threading.Thread(target=self._pump, args=(self._proc, self._lines), daemon=True).start()
        self._request("initialize", {"clientInfo": self._client_info})
        self._notify("initialized", None)

    def restart(self, *, env: Mapping[str, str] | None = None) -> None:
        """起動し直す (Sign in with ChatGPT の access token を更新したとき)。env を渡すと置き換える。

        スレッドを続けるには、このあと resume_thread を呼ぶ (記録を残さないスレッドや、
        消えたコンテナのスレッドは続けられない)。
        """
        self.close()
        if env is not None:
            self._env = dict(env)
        self.start()

    def resume_thread(self, thread_id: str) -> str:
        """保存してあるスレッドを続ける (thread/resume)。"""
        result = self._request("thread/resume", {"threadId": thread_id})
        self.thread_id = (result.get("thread") or {}).get("id") or thread_id
        self._total = {}
        if isinstance(result.get("model"), str):
            self.model = result["model"]
        return self.thread_id

    def start_thread(self, developer_instructions: str | None = None) -> str:
        params: dict[str, Any] = {
            "cwd": CONTAINER_WORKSPACE,
            "sandbox": "danger-full-access",
            "approvalPolicy": "never",
            "ephemeral": True,
        }
        if self._model:
            params["model"] = self._model
        if developer_instructions:
            params["developerInstructions"] = developer_instructions
        result = self._request("thread/start", params)
        self.thread_id = result["thread"]["id"]
        # トークンの累計はスレッドごとに数え直される。前のスレッドの累計と差を取らない。
        self._total = {}
        self.model = result.get("model")
        return self.thread_id

    def run_turn(self, text: str, *, cancel: threading.Event | None = None) -> TurnResult:
        """1回頼んで、終わるまで待つ。

        cancel を set すると turn/interrupt を送り、status が "interrupted" の結果を返す。
        """
        if self.thread_id is None:
            self.start_thread()
        started = time.monotonic()
        params: dict[str, Any] = {
            "threadId": self.thread_id,
            "input": [{"type": "text", "text": text, "text_elements": []}],
        }
        if self._effort:
            params["effort"] = self._effort
        request_id = self._send("turn/start", params)
        result = TurnResult(status="unknown", message=None)
        before = dict(self._total)
        deadline = started + self._turn_timeout
        turn_id: str | None = None
        interrupted = False

        def interrupt() -> None:
            # turn の id が分かってから送る (turn/start の応答より先に中止したとき)。
            nonlocal interrupted
            if cancel is not None and cancel.is_set() and turn_id and not interrupted:
                interrupted = True
                self._send("turn/interrupt", {"threadId": self.thread_id, "turnId": turn_id})

        tick = 0.05 if cancel is not None else 5.0
        for message in self._messages(deadline, on_idle=interrupt, tick=tick):
            if message.get("id") == request_id:
                if "error" in message:
                    raise WorkspaceError(f"turn/start が失敗しました: {message['error']}")
                turn_id = ((message.get("result") or {}).get("turn") or {}).get("id")
                interrupt()
                continue
            interrupt()
            method = message.get("method")
            params = message.get("params") or {}
            if method == "item/completed":
                self._collect(result, params.get("item") or {})
            elif method == "thread/tokenUsage/updated":
                total = (params.get("tokenUsage") or {}).get("total") or {}
                result.usage = _difference(total, before)
                self._total = total
            elif method == "error":
                self._on_event({"type": "error", "error": params})
            elif method == "turn/completed":
                turn = params.get("turn") or {}
                result.status = turn.get("status", "completed")
                if result.status == "failed":
                    error = turn.get("error")
                    if _is_usage_limit(error):
                        raise UsageLimitError(f"使用量の上限に当たりました: {error}")
                    raise WorkspaceError(f"ターンが失敗しました: {error}")
                break
        else:
            raise WorkspaceError(f"1回の頼みごとが {self._turn_timeout:.0f} 秒を超えました")
        result.seconds = round(time.monotonic() - started, 1)
        return result

    def usage(self) -> Usage:
        """アカウントの今の使用量。頼む前に見て、上限に近ければ頼まないために使う。"""
        return parse_usage(self._request("account/rateLimits/read", None))

    def _collect(self, result: TurnResult, item: dict[str, Any]) -> None:
        kind = item.get("type")
        if kind == "agentMessage":
            result.message = item.get("text")
        elif kind == "fileChange":
            for change in item.get("changes") or []:
                path = _relative(change.get("path", ""))
                if path not in result.changed:
                    result.changed.append(path)
        elif kind == "commandExecution":
            result.commands.append(
                {"command": item.get("command"), "exit_code": item.get("exitCode")}
            )
        self._on_event({"type": kind, "item": item})

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._proc = None

    # JSON-RPC ---------------------------------------------------------------

    @staticmethod
    def _pump(proc: subprocess.Popen[str], lines: queue.Queue[str | None]) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    def _messages(
        self,
        deadline: float,
        *,
        on_idle: Callable[[], None] | None = None,
        tick: float = 5.0,
    ) -> Iterator[dict[str, Any]]:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                line = self._lines.get(timeout=min(remaining, tick))
            except queue.Empty:
                if on_idle is not None:
                    on_idle()
                continue
            if line is None:
                raise WorkspaceError("app-server が終わりました")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "method" in message and "id" in message:
                # 承認は求めさせない設定なので、要求が来たら断る。
                self._write(
                    {"jsonrpc": "2.0", "id": message["id"], "result": {"decision": "decline"}}
                )
                continue
            yield message

    def _request(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        request_id = self._send(method, params)
        for message in self._messages(time.monotonic() + self._request_timeout):
            if message.get("id") == request_id:
                if "error" in message:
                    raise WorkspaceError(f"{method} が失敗しました: {message['error']}")
                return message.get("result") or {}
        raise WorkspaceError(f"{method} の応答がありません")

    def _send(self, method: str, params: dict[str, Any] | None) -> int:
        self._next_id += 1
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": self._next_id, "method": method}
        if params is not None:
            payload["params"] = params
        self._write(payload)
        return self._next_id

    def _notify(self, method: str, params: dict[str, Any] | None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._write(payload)

    def _write(self, payload: dict[str, Any]) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise WorkspaceError("app-server が動いていません")
        try:
            self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, ValueError) as exc:
            raise WorkspaceError("app-server が終わりました") from exc


def _difference(after: dict[str, Any], before: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value - before.get(key, 0) if isinstance(value, int) else value
        for key, value in after.items()
    }


def _relative(path: str) -> str:
    prefix = CONTAINER_WORKSPACE.rstrip("/") + "/"
    return path.removeprefix(prefix)
