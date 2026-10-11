import json
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest

from codex_workspace import (
    UsageLimitError,
    WorkspaceError,
    WorkspaceSession,
    chatgpt_plan_overrides,
    docker_command,
    docker_context,
    parse_created,
)

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
    with pytest.raises(ValueError):
        docker_command("/w", auth_volume="v", auth_file="f")


def test_access_tokenを環境変数で渡すときは_認証をマウントせずプラン利用の設定で起こし_値は引数に入れない():
    command = docker_command("/w", access_token_env="ACCESS_TOKEN", config_overrides=('model="x"',))
    mounts = [command[i + 1] for i, a in enumerate(command) if a == "--mount"]
    assert mounts == ["type=bind,src=/w,dst=/workspace"]
    e = command.index("-e")
    assert command[e + 1] == "ACCESS_TOKEN"  # 名前だけ。値は docker を起こすプロセスの環境から
    assert e < command.index("llmcs-codex-workspace:local")
    overrides = [command[i + 1] for i, a in enumerate(command) if a == "-c"]
    assert overrides == [*chatgpt_plan_overrides("ACCESS_TOKEN"), 'model="x"']
    assert 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"' in overrides
    assert "model_providers.openai_chatgpt_plan.requires_openai_auth=false" in overrides
    with pytest.raises(ValueError):
        docker_command("/w", access_token_env="A", auth_volume="v")
    with pytest.raises(ValueError):
        docker_command("/w", access_token_env="A=secret")


def test_環境変数とアプリの名乗りを渡し_トークンを替えて起動し直してスレッドを続ける(
    tmp_path, monkeypatch
):
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_LOG", str(log))
    client_info = {"name": "infodb_p3", "title": "infodb p3", "version": "1.2.3"}
    with WorkspaceSession(
        FAKE, env={"ACCESS_TOKEN": "token-1"}, client_info=client_info
    ) as session:
        thread = session.start_thread()
        session.run_turn("1件目")
        session.restart(env={"ACCESS_TOKEN": "token-2"})
        assert session.resume_thread(thread) == thread
        second = session.run_turn("2件目")
    assert second.status == "completed"
    sent = requests(log)
    assert [m["env"]["ACCESS_TOKEN"] for m in sent if "env" in m] == ["token-1", "token-2"]
    inits = [m for m in sent if m.get("method") == "initialize"]
    assert len(inits) == 2 and inits[0]["params"]["clientInfo"] == client_info
    resume = next(m for m in sent if m.get("method") == "thread/resume")
    assert resume["params"] == {"threadId": thread}
    # トークンは JSON-RPC のメッセージには載らない。
    assert not any("token-" in json.dumps(m) for m in sent if "method" in m)


def test_既定ではパッケージの名前と版で名乗る(tmp_path, monkeypatch):
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_LOG", str(log))
    with WorkspaceSession(FAKE):
        pass
    init = next(m for m in requests(log) if m.get("method") == "initialize")
    assert init["params"]["clientInfo"] == {"name": "codex_workspace", "version": "0.3.0"}


def test_プラン利用の使用量の上限もUsageLimitErrorにする(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "log.jsonl"))
    monkeypatch.setenv("FAKE_SCENARIO", "plan-usage")
    with WorkspaceSession(FAKE) as session, pytest.raises(UsageLimitError):
        session.run_turn("x")


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
    assert turns[0]["input"] == [{"type": "text", "text": "1件目", "text_elements": []}]
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


def test_中止するとturn_interruptを送り_interruptedで返す(tmp_path, monkeypatch):
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_SCENARIO", "slow")
    cancel = threading.Event()
    threading.Timer(0.05, cancel.set).start()
    with WorkspaceSession(FAKE) as session:
        result = session.run_turn("x", cancel=cancel)
    assert result.status == "interrupted"
    interrupt = next(m for m in requests(log) if m.get("method") == "turn/interrupt")
    assert interrupt["params"] == {"threadId": "t1", "turnId": "u1"}


def test_中止してから頼んでも_turnのidが分かってから送る(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "log.jsonl"))
    monkeypatch.setenv("FAKE_SCENARIO", "slow")
    cancel = threading.Event()
    cancel.set()
    with WorkspaceSession(FAKE) as session:
        assert session.run_turn("x", cancel=cancel).status == "interrupted"


def test_1回の頼みごとが上限の時間を超えたら例外にする(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "log.jsonl"))
    monkeypatch.setenv("FAKE_SCENARIO", "slow")
    with (
        WorkspaceSession(FAKE, turn_timeout=0.1) as session,
        pytest.raises(WorkspaceError, match="超えました"),
    ):
        session.run_turn("x")


def test_起動できないコマンドはWorkspaceErrorにする():
    with pytest.raises(WorkspaceError, match="起動できません"):
        WorkspaceSession(["/nonexistent/codex"]).start()


def test_app_serverが途中で終わったら例外にする():
    with pytest.raises(WorkspaceError, match="終わりました"):
        WorkspaceSession([sys.executable, "-c", "pass"]).start()


def test_同梱のDockerfileはDockerfileだけのフォルダにありTypeScript版と同じ():
    with docker_context() as path:
        assert sorted(p.name for p in path.iterdir()) == ["Dockerfile"]
        dockerfile = (path / "Dockerfile").read_text()
    ts = Path(__file__).parents[2] / "codex-workspace-ts" / "docker" / "Dockerfile"
    if not ts.exists():
        pytest.skip("TypeScript 版が無い")
    assert dockerfile == ts.read_text()
