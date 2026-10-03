"""テスト用の偽 `codex`。

`codex mcp list --json` と `codex app-server` だけを真似る。app-server では
turn/start を受けると、環境変数 FAKE_SCENARIO に応じたイベントを流す。
受け取った要求は FAKE_LOG に 1 行 1 件で書き出すので、テスト側で中身を確かめられる。
"""

import json
import os
import sys


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def notify(method: str, params: dict) -> None:
    send({"jsonrpc": "2.0", "method": method, "params": params})


def completed(item: dict) -> None:
    notify("item/completed", {"item": item, "turnId": "u1"})


def run_turn(scenario: str) -> None:
    notify("turn/started", {"turn": {"id": "u1"}})
    if scenario == "json":
        completed({"type": "agentMessage", "id": "m1", "text": '{"answer": 42}'})
    elif scenario == "image":
        item = {"type": "imageGeneration", "id": "i1", "status": "completed"}
        notify("item/started", {"item": item, "turnId": "u1"})
        completed(
            {
                **item,
                "savedPath": os.environ["FAKE_IMAGE"],
                "revisedPrompt": "a revised prompt",
                "result": "",
            }
        )
        completed({"type": "agentMessage", "id": "m1", "text": "Done."})
    elif scenario == "no_image":
        completed({"type": "agentMessage", "id": "m1", "text": "I can't do that."})
    elif scenario == "shell":
        notify("item/started", {"item": {"type": "commandExecution", "id": "c1"}, "turnId": "u1"})
        return
    notify("turn/completed", {"turn": {"id": "u1", "status": "completed"}})


def app_server() -> None:
    scenario = os.environ.get("FAKE_SCENARIO", "json")
    log = open(os.environ["FAKE_LOG"], "a")  # noqa: SIM115
    for line in sys.stdin:
        message = json.loads(line)
        log.write(json.dumps(message) + "\n")
        log.flush()
        method = message.get("method")
        if "id" not in message:
            continue
        if method == "thread/start":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "result": {"thread": {"id": "t1"}, "model": "fake-model"},
                }
            )
        elif method == "turn/start":
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"turn": {"id": "u1"}}})
            run_turn(scenario)
        else:
            send({"jsonrpc": "2.0", "id": message["id"], "result": {}})


if __name__ == "__main__":
    if sys.argv[1:3] == ["mcp", "list"]:
        print("[]")
    elif sys.argv[1:2] == ["app-server"]:
        app_server()
