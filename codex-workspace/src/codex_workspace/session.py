"""コンテナの中の codex app-server を、作業場所を渡して動かす。

作業場所 (ホストのフォルダ) を /workspace にマウントしたコンテナで app-server を起こし、
`docker run -i` の標準入出力を JSON-RPC の経路にする。コンテナが囲いになるので、Codex には
danger-full-access でコマンドの実行とファイルの書き込みを許し、承認は求めさせない。
コンテナに入れるのは作業場所と認証情報のファイル1つだけで、ホストのほかの場所は見えない。

スレッドを1つ立て、同じスレッドに続けて頼める (前のやり取りの文脈とキャッシュが続く)。
頼むたびに、Codex が書き換えたファイル、動かしたコマンド、使ったトークンを返すので、
呼ぶ側はその結果を確かめて、崩れていれば作業場所を元に戻せばよい。

作業場所のパスは、Docker のデーモンから見た場所 (ホストの場所) で渡す。開発環境の
コンテナの中から動かすときは、そのコンテナの中の場所とは違うことがある。
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from importlib import resources
from typing import Any, Self

DEFAULT_IMAGE = "llmcs-codex-workspace:local"
CONTAINER_WORKSPACE = "/workspace"
CONTAINER_AUTH = "/codex/auth.json"
CLIENT_NAME = "codex_workspace"


class WorkspaceError(RuntimeError):
    pass


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
        context = resources.files(__package__)
        with resources.as_file(context) as directory:
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
    docker: str = "docker",
    config_overrides: tuple[str, ...] = (),
) -> list[str]:
    """app-server を起こす docker run。認証情報はボリュームの中のファイルか、ホストのファイルで渡す。

    認証情報は読み書きできるようにマウントする。Codex がトークンを更新したときに書き戻すため。
    """
    if (auth_volume is None) == (auth_file is None):
        raise ValueError("auth_volume か auth_file のどちらか一方を渡してください")
    if auth_volume is not None:
        auth = f"type=volume,src={auth_volume},dst={CONTAINER_AUTH},volume-subpath={auth_subpath}"
    else:
        auth = f"type=bind,src={auth_file},dst={CONTAINER_AUTH}"
    command = [
        docker, "run", "-i", "--rm",
        "--mount", f"type=bind,src={workspace},dst={CONTAINER_WORKSPACE}",
        "--mount", auth,
        image,
    ]  # fmt: skip
    for override in config_overrides:
        command += ["-c", override]
    return command


class WorkspaceSession:
    def __init__(
        self,
        command: list[str],
        *,
        model: str | None = None,
        effort: str | None = None,
        turn_timeout: float = 1800.0,
        request_timeout: float = 120.0,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._command = command
        self._model = model
        self._effort = effort
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
        try:
            self._proc = subprocess.Popen(
                self._command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except FileNotFoundError as exc:
            raise WorkspaceError(f"起動できません: {self._command[0]}") from exc
        threading.Thread(target=self._pump, daemon=True).start()
        self._request("initialize", {"clientInfo": {"name": CLIENT_NAME, "version": "0.1.0"}})
        self._notify("initialized", None)

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
        self.model = result.get("model")
        return self.thread_id

    def run_turn(self, text: str) -> TurnResult:
        """1回頼んで、終わるまで待つ。"""
        if self.thread_id is None:
            self.start_thread()
        started = time.monotonic()
        params: dict[str, Any] = {
            "threadId": self.thread_id,
            "input": [{"type": "text", "text": text}],
        }
        if self._effort:
            params["effort"] = self._effort
        request_id = self._send("turn/start", params)
        result = TurnResult(status="unknown", message=None)
        before = dict(self._total)
        deadline = started + self._turn_timeout
        for message in self._messages(deadline):
            if message.get("id") == request_id:
                if "error" in message:
                    raise WorkspaceError(f"turn/start が失敗しました: {message['error']}")
                continue
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
                    raise WorkspaceError(f"ターンが失敗しました: {turn.get('error')}")
                break
        else:
            raise WorkspaceError(f"1回の頼みごとが {self._turn_timeout:.0f} 秒を超えました")
        result.seconds = round(time.monotonic() - started, 1)
        return result

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

    def _pump(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for line in self._proc.stdout:
            self._lines.put(line)
        self._lines.put(None)

    def _messages(self, deadline: float) -> Iterator[dict[str, Any]]:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                line = self._lines.get(timeout=min(remaining, 5.0))
            except queue.Empty:
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
        self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()


def _difference(after: dict[str, Any], before: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value - before.get(key, 0) if isinstance(value, int) else value
        for key, value in after.items()
    }


def _relative(path: str) -> str:
    prefix = CONTAINER_WORKSPACE.rstrip("/") + "/"
    return path.removeprefix(prefix)
