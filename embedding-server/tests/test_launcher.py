"""イメージの作成と、コンテナの起動・待機・停止。docker は偽のコマンドで差し替える。"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

import embedding_server as es


@pytest.fixture
def docker(tmp_path):
    """呼ばれた引数を1行ずつ記録する偽の docker。振る舞いは環境変数で決める。"""
    log = tmp_path / "docker.log"
    script = tmp_path / "docker"
    script.write_text(
        f"""#!/bin/sh
echo "$*" >> "{log}"
case "$1" in
  image) exit "${{FAKE_IMAGE_EXIT:-0}}" ;;
  build) exit 0 ;;
  run) [ -n "$FAKE_RUN_FAIL" ] && {{ echo "no such network" >&2; exit 125; }}; echo cid; exit 0 ;;
  port) echo "127.0.0.1:49153"; exit 0 ;;
  inspect) echo "${{FAKE_RUNNING:-true}}"; exit 0 ;;
  logs) echo "OSError: out of memory"; exit 0 ;;
  rm) exit 0 ;;
esac
exit 1
"""
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)

    def calls():
        return [line.split() for line in log.read_text().splitlines()] if log.exists() else []

    return str(script), calls


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def test_イメージは無いときだけ作る(docker, monkeypatch):
    path, calls = docker
    assert es.ensure_image("img:1", docker=path) is False
    assert [c[0] for c in calls()] == ["image"]
    monkeypatch.setenv("FAKE_IMAGE_EXIT", "1")
    assert es.ensure_image("img:1", docker=path) is True
    build = calls()[-1]
    assert build[:4] == ["build", "-q", "-t", "img:1"]
    assert (Path(build[4]) / "Dockerfile").is_file()
    assert (Path(build[4]) / "models.json").is_file()


def test_既定のイメージはパッケージの版をタグにする():
    assert es.DEFAULT_IMAGE == f"llmcs-embedding-server:{es.__version__}"


def test_ネットワークに入れて名前で呼び_抜けたら消す(docker):
    path, calls = docker
    probes = []
    with es.running(
        ["bge-m3"],
        image="img:1",
        network="net",
        docker=path,
        probe=lambda u: probes.append(u) or True,
    ) as url:
        run = calls()[0]
        name = run[run.index("--name") + 1]
        assert url == f"http://{name}:8080"
        assert run[run.index("--network") + 1] == "net"
        assert "MODELS=bge-m3" in run and "llmcs-embedding-models:/models" in run
        assert "-p" not in run and "--rm" not in run
        assert calls()[-1][0] != "rm"
    assert probes == [url]
    assert calls()[-1] == ["rm", "-f", name]


def test_ネットワークが無ければホストの空いたポートに公開する(docker):
    path, calls = docker
    with es.running(image="img:1", docker=path, probe=lambda u: True) as url:
        assert url == "http://127.0.0.1:49153"
    run = calls()[0]
    assert run[run.index("-p") + 1] == "127.0.0.1::8080"
    assert "MODELS=" in run


def test_okになるまで待つ(docker):
    path, _calls = docker
    clock = Clock()
    answers = iter([False, False, True])
    with es.running(
        image="img:1", network="n", docker=path, probe=lambda u: next(answers),
        sleep=clock.sleep, clock=clock,
    ):  # fmt: skip
        pass
    assert clock.now == 4.0


def test_待ち切れなければ失敗にして消す(docker):
    path, calls = docker
    clock = Clock()
    with pytest.raises(es.EmbeddingServerError, match="ok を返しません"), es.running(
        image="img:1", network="n", docker=path, probe=lambda u: False,
        start_timeout=10, sleep=clock.sleep, clock=clock,
    ):  # fmt: skip
        pytest.fail("中に入ってはいけない")
    assert calls()[-1][:2] == ["rm", "-f"]


def test_起動の途中で止まったらログを添えて失敗にする(docker, monkeypatch):
    path, calls = docker
    monkeypatch.setenv("FAKE_RUNNING", "false")
    starting = es.running(image="img:1", network="n", docker=path, probe=lambda u: False)
    with pytest.raises(es.EmbeddingServerError, match="out of memory"), starting:
        pass
    assert calls()[-1][:2] == ["rm", "-f"]


def test_中で失敗しても消す(docker):
    path, calls = docker
    starting = es.running(image="img:1", network="n", docker=path, probe=lambda u: True)
    with pytest.raises(RuntimeError), starting:
        raise RuntimeError("呼ぶ側の失敗")
    assert calls()[-1][:2] == ["rm", "-f"]


def test_起動できなければ理由を出して消す(docker, monkeypatch):
    path, calls = docker
    monkeypatch.setenv("FAKE_RUN_FAIL", "1")
    starting = es.running(image="img:1", network="n", docker=path, probe=lambda u: True)
    with pytest.raises(es.EmbeddingServerError, match="no such network"), starting:
        pass
    assert calls()[-1][:2] == ["rm", "-f"]  # 作りかけのコンテナを残さない


def test_dockerが無ければ理由を出す(tmp_path):
    with pytest.raises(es.EmbeddingServerError, match="docker のコマンドがありません"):
        es.ensure_image("img:1", docker=str(tmp_path / "no-docker"))


def test_同梱したモデルの一覧を読める():
    with es.docker_context() as directory:
        names = [m["name"] for m in json.loads((directory / "models.json").read_text())["models"]]
    assert "bge-m3" in names
    assert os.path.exists(directory / "server.py")
