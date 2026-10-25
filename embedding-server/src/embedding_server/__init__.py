"""文をベクトルにするサーバ (docker/server.py) を、使う間だけコンテナで動かす部品。

ベクトルを作るのが1日に数分なら、モデル (bge-m3 で重みだけ約2GB) をメモリに載せたまま常駐させる
理由が無い。呼ぶ側は `running()` の中でだけサーバを使い、抜ければコンテナは止まって消える。

    from embedding_server import ensure_image, running

    ensure_image()  # 無ければ作る (この版のイメージ)
    with running(["bge-m3"], network="denv-cc-remote_default") as url:
        ...  # url の /v1/embeddings を呼ぶ

- イメージはパッケージに同梱した Dockerfile から作り、パッケージの版をタグにする
  (`llmcs-embedding-server:<版>`)。models.json (モデルの版の固定) を変えたら版を上げるので、
  古いイメージを使い続けることは無い。
- モデルは名前付きボリューム (既定 `llmcs-embedding-models`) に置き、起動のたびに取り直さない。
  初回だけ取得を待つ。
- 呼ぶ側がコンテナの中にいるなら、そのコンテナがいる Docker のネットワークを `network` で渡す。
  サーバはそのネットワークにコンテナ名で入り、`http://<名前>:8080` で届く。渡さなければホストの
  127.0.0.1 の空いたポートに公開する (呼ぶ側がホストにいるとき)。
- health が ok になるまで待つ。待つ間にコンテナが止まったら、ログの末尾を添えて失敗にする。
  抜けるときは、成功でも失敗でも止めて消す。
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from importlib import metadata, resources
from pathlib import Path

try:
    __version__ = metadata.version("embedding-server")
except metadata.PackageNotFoundError:  # pragma: no cover - 入れずに読んだとき
    __version__ = "0.0.0"

DEFAULT_IMAGE = f"llmcs-embedding-server:{__version__}"
DEFAULT_VOLUME = "llmcs-embedding-models"
PORT = 8080
START_TIMEOUT = 900.0
"""初回はモデルの取得 (bge-m3 で約2GB) を待つ。2回目からは読み込みだけ。"""

__all__ = [
    "DEFAULT_IMAGE",
    "DEFAULT_VOLUME",
    "EmbeddingServerError",
    "docker_context",
    "ensure_image",
    "running",
]


class EmbeddingServerError(Exception):
    """イメージを作れない、コンテナを起動できない、health が ok にならない。"""


@contextmanager
def docker_context() -> Iterator[Path]:
    """パッケージに同梱した Dockerfile のあるフォルダ (compose.yaml も同じものを使う)。"""
    with resources.as_file(resources.files(__package__) / "docker") as path:
        yield Path(path)


def _run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise EmbeddingServerError(f"docker のコマンドがありません: {command[0]}") from exc
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-1000:]
        raise EmbeddingServerError(f"{' '.join(command[:3])} が失敗しました: {detail}")
    return result


def ensure_image(image: str = DEFAULT_IMAGE, *, docker: str = "docker") -> bool:
    """イメージが無ければ作る。作ったら True。"""
    if _run([docker, "image", "inspect", image], check=False).returncode == 0:
        return False
    with docker_context() as directory:
        _run([docker, "build", "-q", "-t", image, str(directory)])
    return True


def _healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(url + "/health", timeout=5) as response:
            return json.loads(response.read()).get("status") == "ok"
    except (OSError, ValueError, urllib.error.URLError):
        return False


@contextmanager
def running(
    models: Iterable[str] = (),
    *,
    image: str = DEFAULT_IMAGE,
    volume: str = DEFAULT_VOLUME,
    network: str | None = None,
    docker: str = "docker",
    start_timeout: float = START_TIMEOUT,
    probe: Callable[[str], bool] = _healthy,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Iterator[str]:
    """サーバのコンテナを起動し、health が ok になったら根の URL を返す。抜けると止める。

    models はサーバに読み込ませるモデル (models.json の name)。空なら全部。
    """
    name = f"llmcs-embedding-{uuid.uuid4().hex[:12]}"
    command = [docker, "run", "-d", "--name", name, "-v", f"{volume}:/models"]
    command += ["-e", f"MODELS={','.join(models)}"]
    command += ["--network", network] if network else ["-p", f"127.0.0.1::{PORT}"]
    try:
        # 起動に失敗しても (知らないネットワークなど)、作りかけのコンテナが残るので消す。
        _run([*command, image])
        url = f"http://{name}:{PORT}" if network else _published(docker, name)
        _wait(docker, name, url, start_timeout, probe, sleep, clock)
        yield url
    finally:
        # --rm にしないのは、起動の途中で止まったときにログを読めるようにするため。
        _run([docker, "rm", "-f", name], check=False)


def _published(docker: str, name: str) -> str:
    output = _run([docker, "port", name, f"{PORT}/tcp"]).stdout.strip().splitlines()
    if not output:
        raise EmbeddingServerError(f"{name} の公開したポートが分かりません")
    host, _, port = output[0].rpartition(":")
    return f"http://{host.strip('[]') or '127.0.0.1'}:{port}"


def _wait(docker, name, url, timeout, probe, sleep, clock) -> None:
    deadline = clock() + timeout
    while True:
        if probe(url):
            return
        state = _run([docker, "inspect", "--format", "{{.State.Running}}", name], check=False)
        if state.returncode != 0 or state.stdout.strip() != "true":
            logs = _run([docker, "logs", "--tail", "30", name], check=False)
            tail = (logs.stdout + logs.stderr).strip()[-2000:]
            raise EmbeddingServerError(f"{name} が起動の途中で止まりました:\n{tail}")
        if clock() >= deadline:
            raise EmbeddingServerError(f"{name} が {timeout:.0f}秒たっても ok を返しません ({url})")
        sleep(2.0)
