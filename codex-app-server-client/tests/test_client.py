import json
import stat
import sys
from pathlib import Path

import pytest

from codex_app_server_client import CodexAppServerClient, LLMError

FAKE = Path(__file__).with_name("fake_codex.py")
PNG = b"\x89PNG\r\n\x1a\nfake"


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """偽 codex を起動するコマンドを用意し、受け取った要求を読めるようにする。"""
    command = tmp_path / "codex"
    command.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE} "$@"\n')
    command.chmod(command.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "requests.jsonl"
    image = tmp_path / "out.png"
    image.write_bytes(PNG)
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_IMAGE", str(image))

    def requests(method: str) -> list[dict]:
        lines = log.read_text().splitlines() if log.exists() else []
        return [m for m in map(json.loads, lines) if m.get("method") == method]

    return str(command), requests


def client(command: str) -> CodexAppServerClient:
    return CodexAppServerClient(command=command, timeout=10, max_retries=0)


def test_generate_json(fake, monkeypatch):
    command, requests = fake
    monkeypatch.setenv("FAKE_SCENARIO", "json")
    schema = {"type": "object"}
    with client(command) as c:
        assert c.generate_json(instructions="i", prompt="p", schema=schema) == {"answer": 42}
        assert c.resolved_model == "fake-model"
    assert requests("turn/start")[0]["params"]["outputSchema"] == schema


def test_generate_image(fake, monkeypatch):
    command, requests = fake
    monkeypatch.setenv("FAKE_SCENARIO", "image")
    ref = {"type": "image", "url": "data:image/png;base64,AAAA"}
    with client(command) as c:
        images = c.generate_image(instructions="i", prompt="p", extra_input=(ref,))
        assert c.last_message == "Done."
    assert [i.data for i in images] == [PNG]
    assert images[0].revised_prompt == "a revised prompt"
    params = requests("turn/start")[0]["params"]
    # 画像生成では出力を JSON に拘束しない
    assert "outputSchema" not in params
    assert params["input"][1] == ref


def test_generate_image_without_image_is_error(fake, monkeypatch):
    command, _ = fake
    monkeypatch.setenv("FAKE_SCENARIO", "no_image")
    with client(command) as c, pytest.raises(LLMError) as exc:
        c.generate_image(instructions="i", prompt="p")
    assert exc.value.kind == "no-image"


def test_image_generation_is_not_allowed_in_generate_json(fake, monkeypatch):
    command, _ = fake
    monkeypatch.setenv("FAKE_SCENARIO", "image")
    with client(command) as c, pytest.raises(LLMError, match="imageGeneration"):
        c.generate_json(instructions="i", prompt="p", schema={"type": "object"})


def test_shell_aborts_turn(fake, monkeypatch):
    command, _ = fake
    monkeypatch.setenv("FAKE_SCENARIO", "shell")
    with client(command) as c, pytest.raises(LLMError, match="commandExecution"):
        c.generate_image(instructions="i", prompt="p")


def test_local_image_input_is_refused(fake):
    command, _ = fake
    with client(command) as c, pytest.raises(LLMError, match="localImage"):
        c.generate_image(
            instructions="i", prompt="p", extra_input=({"type": "localImage", "path": "/x"},)
        )
