// テスト用の偽 app-server (Python 版 tests/fake_app_server.py と同じ振る舞い)。
// turn/start を受けると、ファイルの変更とコマンドとトークンを報せる。受け取った要求は FAKE_LOG に1行1件で書き出す。
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_SCENARIO;
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function runTurn(turn, inThread) {
  notify("turn/started", { turn: { id: turn } });
  if (scenario === "fail" || scenario === "usage" || scenario === "plan-usage") {
    const error =
      scenario === "usage"
        ? { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" }
        : scenario === "plan-usage"
          ? { message: 'unexpected status 429: {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}', codexErrorInfo: "other" }
          : { message: "x" };
    notify("turn/completed", { turn: { id: turn, status: "failed", error } });
    return;
  }
  if (scenario === "slow") return; // turn/interrupt が来るまで終わらない
  // 承認は求めない設定でも、要求が来たら断られることを確かめる。
  send({ jsonrpc: "2.0", id: 900, method: "item/fileChange/requestApproval", params: {} });
  notify("item/completed", { item: { type: "commandExecution", id: "c1", command: "rg -l AWS concepts", exitCode: 0 } });
  notify("item/completed", {
    item: {
      type: "fileChange",
      id: "p1",
      status: "completed",
      changes: [
        { path: "/workspace/documents/a.yaml", kind: "add" },
        { path: "/workspace/concepts/aws.yaml", kind: "update" },
      ],
    },
  });
  notify("item/completed", { item: { type: "agentMessage", id: "m1", text: "書きました" } });
  // 累計はスレッドごとに数え直す (本物の app-server と同じ)。
  const used = 1000 * inThread;
  notify("thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 1 }, total: { totalTokens: used + 200 } } });
  notify("thread/tokenUsage/updated", { tokenUsage: { last: { totalTokens: 1 }, total: { totalTokens: used + 234 } } });
  notify("turn/completed", { turn: { id: turn, status: "completed" } });
}

let turns = 0;
let inThread = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(message)}\n`);
  if (!("id" in message) || !("method" in message)) continue;
  const { id, method, params } = message;
  if (method === "initialize") {
    // 受け取った環境変数を記録する (access token が環境で渡っているか確かめるため)
    appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ env: { ACCESS_TOKEN: process.env.ACCESS_TOKEN ?? null } })}\n`);
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "thread/resume") {
    send({ jsonrpc: "2.0", id, result: { thread: { id: params.threadId }, model: "fake" } });
  } else if (method === "thread/start") {
    inThread = 0;
    send({ jsonrpc: "2.0", id, result: { thread: { id: "t1" }, model: "fake" } });
  } else if (method === "turn/start") {
    turns += 1;
    inThread += 1;
    send({ jsonrpc: "2.0", id, result: { turn: { id: `u${turns}` } } });
    runTurn(`u${turns}`, inThread);
  } else if (method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id, result: {} });
    notify("turn/completed", { turn: { id: params.turnId, status: "interrupted" } });
  } else if (method === "account/rateLimits/read") {
    const [fiveHour, weekly] = (process.env.FAKE_USAGE ?? "8,1").split(",").map(Number);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        rateLimits: {
          primary: { usedPercent: fiveHour, windowDurationMins: 300 },
          secondary: { usedPercent: weekly, windowDurationMins: 10080 },
          rateLimitReachedType: null,
        },
        ordinaryUsageAllowed: true,
      },
    });
  } else {
    send({ jsonrpc: "2.0", id, result: {} });
  }
}
