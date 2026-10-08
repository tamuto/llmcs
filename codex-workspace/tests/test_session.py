import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from codex_workspace import UsageLimitError, WorkspaceError, WorkspaceSession, docker_command
from codex_workspace.session import parse_created

FAKE = [sys.executable, str(Path(__file__).with_name("fake_app_server.py"))]


def requests(log):
    return [json.loads(line) for line in log.read_text().splitlines()]


def test_作業場所と認証情報だけをマウントする():
    command = docker_command("/mnt/usb/assets/kotonoha/graph", auth_volume="codex-state")
    assert command[:4] == ["docker", "run", "-i", "--rm"]
    mounts = [command[i + 1] for i, a in enumerate(command) if a == "--mount"]
    assert mounts == [
        "type=bind,src=/mnt/usb/assets/kotonoha/graph,dst=/workspace",
        "type=volume,src=codex-state,dst=/codex/auth.json,volume-subpath=auth.json",
    ]
    file_based = docker_command("/w", auth_file="/root/.codex/auth.json", config_overrides=("a=1",))
    assert "type=bind,src=/root/.codex/auth.json,dst=/codex/auth.json" in file_based
    assert file_based[-2:] == ["-c", "a=1"]
    with pytest.raises(ValueError):
        docker_command("/w")


def test_スレッドは作業場所で囲いなし_承認なしで立てる(tmp_path, monkeypatch):
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_LOG", str(log))
    with WorkspaceSession(FAKE, model="gpt-x", effort="low") as session:
        session.start_thread("記事を取り込む")
        first = session.run_turn("1件目")
        second = session.run_turn("2件目")
    assert first.changed == ["documents/a.yaml", "concepts/aws.yaml"]
    assert first.commands == [{"command": "rg -l AWS concepts", "exit_code": 0}]
    # 1回の頼みごとの中の問い合わせを全部足した量 (累計の差) にする。
    assert first.usage == {"totalTokens": 1234}
    assert second.usage == {"totalTokens": 1000}
    assert first.message == "書きました"
    sent = requests(log)
    start = next(m for m in sent if m.get("method") == "thread/start")["params"]
    assert start == {
        "cwd": "/workspace",
        "sandbox": "danger-full-access",
        "approvalPolicy": "never",
        "ephemeral": True,
        "model": "gpt-x",
        "developerInstructions": "記事を取り込む",
    }
    turns = [m["params"] for m in sent if m.get("method") == "turn/start"]
    # 同じスレッドに続けて頼む。
    assert [t["threadId"] for t in turns] == ["t1", "t1"] and turns[0]["effort"] == "low"
    # 承認の要求は断る。
    assert {"jsonrpc": "2.0", "id": 900, "result": {"decision": "decline"}} in sent


def test_失敗したターンは例外にする(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "log.jsonl"))
    monkeypatch.setenv("FAKE_SCENARIO", "fail")
    with WorkspaceSession(FAKE) as session, pytest.raises(WorkspaceError, match="失敗"):
        session.run_turn("x")


def test_使用量の上限に当たったターンは_それと分かる例外にする(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "log.jsonl"))
    monkeypatch.setenv("FAKE_SCENARIO", "usage")
    with WorkspaceSession(FAKE) as session, pytest.raises(UsageLimitError, match="上限"):
        session.run_turn("x")


def test_アカウントの使用量を窓の長さごとに読む(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "log.jsonl"))
    monkeypatch.setenv("FAKE_USAGE", "72,15")
    with WorkspaceSession(FAKE) as session:
        usage = session.usage()
    assert usage.windows == {300: 72, 10080: 15}
    assert usage.used(300) == 72 and usage.used(60) is None
    assert usage.allowed is True and usage.reached is None


def test_Dockerの作成日時を読む():
    assert parse_created("2026-10-03T08:26:51.123456789Z") == datetime(
        2026, 10, 3, 8, 26, 51, 123456, tzinfo=UTC
    )
    assert parse_created("2026-10-03T08:26:51Z") == datetime(2026, 10, 3, 8, 26, 51, tzinfo=UTC)
    assert parse_created("") is None


def test_スレッドを立て直したらトークンの累計を数え直す(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "log.jsonl"))
    with WorkspaceSession(FAKE) as session:
        session.start_thread()
        session.run_turn("1件目")
        session.run_turn("2件目")
        session.start_thread()
        third = session.run_turn("3件目")
    # 新しいスレッドの1件目は、そのスレッドの累計そのもの (前のスレッドの累計と差を取らない)。
    assert third.usage == {"totalTokens": 1234}
