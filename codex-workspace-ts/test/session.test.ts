import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DOCKER_CONTEXT,
  UsageLimitError,
  chatgptPlanOverrides,
  WorkspaceError,
  WorkspaceSession,
  dockerCommand,
  parseCreated,
} from "../src/index.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

/** 偽の app-server を起こす command と、受け取った要求のログ */
function fake(env: Record<string, string> = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "codex-workspace-")), "log.jsonl");
  const vars = Object.entries({ FAKE_LOG: log, ...env }).map(([k, v]) => `${k}=${v}`);
  return {
    command: ["env", ...vars, process.execPath, FAKE_SERVER],
    requests: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>),
  };
}

test("作業場所と認証情報だけをマウントする", () => {
  const command = dockerCommand("/mnt/usb/assets/kotonoha/graph", { authVolume: "codex-state" });
  assert.deepEqual(command.slice(0, 4), ["docker", "run", "-i", "--rm"]);
  const mounts = command.flatMap((a, i) => (a === "--mount" ? [command[i + 1]] : []));
  assert.deepEqual(mounts, [
    "type=bind,src=/mnt/usb/assets/kotonoha/graph,dst=/workspace",
    "type=volume,src=codex-state,dst=/codex/auth.json,volume-subpath=auth.json",
  ]);
  const fileBased = dockerCommand("/w", { authFile: "/root/.codex/auth.json", configOverrides: ["a=1"] });
  assert.ok(fileBased.includes("type=bind,src=/root/.codex/auth.json,dst=/codex/auth.json"));
  assert.deepEqual(fileBased.slice(-2), ["-c", "a=1"]);
  assert.throws(() => dockerCommand("/w"), TypeError);
  assert.throws(() => dockerCommand("/w", { authVolume: "v", authFile: "f" }), TypeError);
});

test("access token を環境変数で渡すときは、認証をマウントせずプラン利用の設定で起こし、値は引数に入れない", () => {
  const command = dockerCommand("/w", { accessTokenEnv: "ACCESS_TOKEN", configOverrides: ["model=\"x\""] });
  const mounts = command.flatMap((a, i) => (a === "--mount" ? [command[i + 1]] : []));
  assert.deepEqual(mounts, ["type=bind,src=/w,dst=/workspace"]);
  const e = command.indexOf("-e");
  assert.equal(command[e + 1], "ACCESS_TOKEN"); // 名前だけ。値は docker を起こすプロセスの環境から
  assert.ok(e < command.indexOf("llmcs-codex-workspace:local"));
  const overrides = command.flatMap((a, i) => (a === "-c" ? [command[i + 1]] : []));
  assert.deepEqual(overrides, [...chatgptPlanOverrides("ACCESS_TOKEN"), 'model="x"']);
  assert.ok(overrides.includes('model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"'));
  assert.ok(overrides.includes("model_providers.openai_chatgpt_plan.requires_openai_auth=false"));
  assert.throws(() => dockerCommand("/w", { accessTokenEnv: "A", authVolume: "v" }), TypeError);
  assert.throws(() => dockerCommand("/w", { accessTokenEnv: "A=secret" }), TypeError);
});

test("環境変数とアプリの名乗りを渡し、トークンを替えて起動し直してスレッドを続ける", async () => {
  const { command, requests } = fake();
  await using session = await WorkspaceSession.open(command, {
    env: { ACCESS_TOKEN: "token-1" },
    clientInfo: { name: "infodb_p3", title: "infodb p3", version: "1.2.3" },
  });
  const thread = await session.startThread();
  await session.runTurn("1件目");
  await session.restart({ env: { ACCESS_TOKEN: "token-2" } });
  assert.equal(await session.resumeThread(thread), thread);
  const second = await session.runTurn("2件目");
  await session.close();
  assert.equal(second.status, "completed");

  const log = requests();
  assert.deepEqual(log.filter((m) => m.env).map((m) => m.env.ACCESS_TOKEN), ["token-1", "token-2"]);
  const inits = log.filter((m) => m.method === "initialize");
  assert.equal(inits.length, 2);
  assert.deepEqual(inits[0].params.clientInfo, { name: "infodb_p3", title: "infodb p3", version: "1.2.3" });
  assert.deepEqual(log.find((m) => m.method === "thread/resume")?.params, { threadId: thread });
  // トークンは JSON-RPC のメッセージには載らない
  assert.ok(!log.filter((m) => m.method).some((m) => JSON.stringify(m).includes("token-")));
});

test("プラン利用の使用量の上限 (subscription_sharing_usage_limit_exceeded) も UsageLimitError にする", async () => {
  await using session = await WorkspaceSession.open(fake({ FAKE_SCENARIO: "plan-usage" }).command);
  await assert.rejects(session.runTurn("x"), UsageLimitError);
});

test("スレッドは作業場所で囲いなし・承認なしで立てる", async () => {
  const { command, requests } = fake();
  const events: string[] = [];
  await using session = await WorkspaceSession.open(command, {
    model: "gpt-x",
    effort: "low",
    onEvent: (e) => events.push(e.type),
  });
  await session.startThread("記事を取り込む");
  const first = await session.runTurn("1件目");
  const second = await session.runTurn("2件目");
  await session.close();

  assert.equal(first.status, "completed");
  assert.deepEqual(first.changed, ["documents/a.yaml", "concepts/aws.yaml"]);
  assert.deepEqual(first.commands, [{ command: "rg -l AWS concepts", exitCode: 0 }]);
  // 1回の頼みごとの中の問い合わせを全部足した量 (累計の差) にする。
  assert.deepEqual(first.usage, { totalTokens: 1234 });
  assert.deepEqual(second.usage, { totalTokens: 1000 });
  assert.equal(first.message, "書きました");
  assert.equal(session.model, "fake");
  assert.deepEqual(events.slice(0, 3), ["commandExecution", "fileChange", "agentMessage"]);

  const sent = requests();
  assert.deepEqual(sent.find((m) => m.method === "thread/start")?.params, {
    cwd: "/workspace",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    ephemeral: true,
    model: "gpt-x",
    developerInstructions: "記事を取り込む",
  });
  const turns = sent.filter((m) => m.method === "turn/start").map((m) => m.params);
  // 同じスレッドに続けて頼む。
  assert.deepEqual(turns.map((t) => t.threadId), ["t1", "t1"]);
  assert.equal(turns[0].effort, "low");
  // 承認の要求は断る。
  assert.ok(sent.some((m) => m.id === 900 && m.result?.decision === "decline"));
});

test("失敗したターンは例外にする", async () => {
  await using session = await WorkspaceSession.open(fake({ FAKE_SCENARIO: "fail" }).command);
  await assert.rejects(session.runTurn("x"), (e) => e instanceof WorkspaceError && !(e instanceof UsageLimitError) && /失敗/.test(e.message));
});

test("使用量の上限に当たったターンは、それと分かる例外にする", async () => {
  await using session = await WorkspaceSession.open(fake({ FAKE_SCENARIO: "usage" }).command);
  await assert.rejects(session.runTurn("x"), (e) => e instanceof UsageLimitError && /上限/.test(e.message));
});

test("アカウントの使用量を窓の長さごとに読む", async () => {
  await using session = await WorkspaceSession.open(fake({ FAKE_USAGE: "72,15" }).command);
  const usage = await session.usage();
  assert.deepEqual(usage.windows, { 300: 72, 10080: 15 });
  assert.equal(usage.used(300), 72);
  assert.equal(usage.used(60), null);
  assert.equal(usage.allowed, true);
  assert.equal(usage.reached, null);
});

test("スレッドを立て直したらトークンの累計を数え直す", async () => {
  await using session = await WorkspaceSession.open(fake().command);
  await session.startThread();
  await session.runTurn("1件目");
  await session.runTurn("2件目");
  await session.startThread();
  const third = await session.runTurn("3件目");
  // 新しいスレッドの1件目は、そのスレッドの累計そのもの (前のスレッドの累計と差を取らない)。
  assert.deepEqual(third.usage, { totalTokens: 1234 });
});

test("中止すると turn/interrupt を送り、interrupted で返す", async () => {
  const { command, requests } = fake({ FAKE_SCENARIO: "slow" });
  await using session = await WorkspaceSession.open(command);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await session.runTurn("x", { signal: controller.signal });
  assert.equal(result.status, "interrupted");
  assert.deepEqual(requests().find((m) => m.method === "turn/interrupt")?.params, { threadId: "t1", turnId: "u1" });
});

test("1回の頼みごとが上限の時間を超えたら例外にする", async () => {
  await using session = await WorkspaceSession.open(fake({ FAKE_SCENARIO: "slow" }).command, { turnTimeoutMs: 100 });
  await assert.rejects(session.runTurn("x"), /超えました/);
});

test("起動できないコマンドは WorkspaceError にする", async () => {
  await assert.rejects(WorkspaceSession.open(["/nonexistent/codex"]), (e) => e instanceof WorkspaceError && /起動できません/.test(e.message));
});

test("app-server が途中で終わったら例外にする", async () => {
  await assert.rejects(
    WorkspaceSession.open([process.execPath, "-e", "process.exit(0)"]),
    (e) => e instanceof WorkspaceError && /終わりました/.test(e.message),
  );
});

test("Docker の作成日時を読む", () => {
  assert.equal(parseCreated("2026-10-03T08:26:51.123456789Z")?.toISOString(), "2026-10-03T08:26:51.123Z");
  assert.equal(parseCreated("2026-10-03T08:26:51Z")?.toISOString(), "2026-10-03T08:26:51.000Z");
  assert.equal(parseCreated(""), null);
});

test("Dockerfile は Python 版と同じものを使う (同じイメージを共有するため)", (t) => {
  const python = fileURLToPath(new URL("../../codex-workspace/src/codex_workspace/Dockerfile", import.meta.url));
  if (!existsSync(python)) return t.skip("Python 版が無い");
  assert.equal(readFileSync(join(DOCKER_CONTEXT, "Dockerfile"), "utf8"), readFileSync(python, "utf8"));
});
