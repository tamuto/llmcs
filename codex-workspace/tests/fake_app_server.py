"""テスト用の偽 app-server。turn/start を受けると、ファイルの変更とコマンドとトークンを報せる。

受け取った要求は FAKE_LOG に1行1件で書き出す。
"""

import json
import os
import sys


def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def run_turn(turn, in_thread):
    notify("turn/started", {"turn": {"id": turn}})
    if os.environ.get("FAKE_SCENARIO") in ("fail", "usage"):
        error = {"message": "x"}
        if os.environ.get("FAKE_SCENARIO") == "usage":
            error = {
                "message": "You've hit your usage limit",
                "codexErrorInfo": "usageLimitExceeded",
            }
        notify("turn/completed", {"turn": {"id": turn, "status": "failed", "error": error}})
        return
    # 承認は求めない設定でも、要求が来たら断られることを確かめる。
    send({"jsonrpc": "2.0", "id": 900, "method": "item/fileChange/requestApproval", "params": {}})
    item = {"type": "commandExecution", "id": "c1", "command": "rg -l AWS concepts", "exitCode": 0}
    notify("item/completed", {"item": item})
    change = {
        "type": "fileChange",
        "id": "p1",
        "status": "completed",
        "changes": [
            {"path": "/workspace/documents/a.yaml", "kind": "add"},
            {"path": "/workspace/concepts/aws.yaml", "kind": "update"},
        ],
    }
    notify("item/completed", {"item": change})
    notify("item/completed", {"item": {"type": "agentMessage", "id": "m1", "text": "書きました"}})
    # 累計はスレッドごとに数え直す (本物の app-server と同じ)。
    used = 1000 * in_thread
    notify(
        "thread/tokenUsage/updated",
        {"tokenUsage": {"last": {"totalTokens": 1}, "total": {"totalTokens": used + 200}}},
    )
    notify(
        "thread/tokenUsage/updated",
        {"tokenUsage": {"last": {"totalTokens": 1}, "total": {"totalTokens": used + 234}}},
    )
    notify("turn/completed", {"turn": {"id": turn, "status": "completed"}})


def main():
    log = open(os.environ["FAKE_LOG"], "a")  # noqa: SIM115
    turns = 0
    in_thread = 0
    for line in sys.stdin:
        message = json.loads(line)
        log.write(json.dumps(message) + "\n")
        log.flush()
        if "id" not in message or "method" not in message:
            continue
        method = message["method"]
        if method == "thread/start":
            in_thread = 0
            send(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "result": {"thread": {"id": "t1"}, "model": "fake"},
                }
            )
        elif method == "turn/start":
            turns += 1
            in_thread += 1
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"turn": {"id": f"u{turns}"}}})
            run_turn(f"u{turns}", in_thread)
        elif method == "account/rateLimits/read":
            five_hour, weekly = (int(v) for v in os.environ.get("FAKE_USAGE", "8,1").split(","))
            limits = {
                "primary": {"usedPercent": five_hour, "windowDurationMins": 300},
                "secondary": {"usedPercent": weekly, "windowDurationMins": 10080},
                "rateLimitReachedType": None,
            }
            result = {"rateLimits": limits, "ordinaryUsageAllowed": True}
            send({"jsonrpc": "2.0", "id": message["id"], "result": result})
        else:
            send({"jsonrpc": "2.0", "id": message["id"], "result": {}})


if __name__ == "__main__":
    main()
