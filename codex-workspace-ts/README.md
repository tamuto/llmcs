# codex-workspace-ts

[codex-workspace](../codex-workspace) の TypeScript 版です。`codex app-server` を、渡した作業場所だけを
マウントした Docker のコンテナの中で動かし、Node から操ります。コンテナを囲いにするので、Codex には
囲いなし（`danger-full-access`）でコマンドの実行とファイルの書き込みを許します。コンテナから見えるのは、
作業場所（`/workspace`）と認証情報のファイル1つ（`/codex/auth.json`）だけです。

Python 版と同じ Dockerfile・同じイメージ（`llmcs-codex-workspace:local`）を使うので、どちらで作った
イメージも共有できます（Dockerfile が同じであることはテストで確かめています）。

## 使い方

npm レジストリから入れます。

```bash
npm install @infodb/codex-workspace   # pnpm add / yarn add でもよい
```

npm に公開した版だけを使います（git の URL や `link:` では参照しません）。
ビルド結果（`dist/`）はコミットせず、公開するときに `prepublishOnly` で作ります。

```ts
import { WorkspaceSession, dockerCommand, ensureImage, UsageLimitError } from "@infodb/codex-workspace";

await ensureImage(); // 無いか1日より古ければ作り直す (最新の Codex を入れる)
const command = dockerCommand("/mnt/usb/assets/kotonoha/graph", { authVolume: "denv-cc-remote_codex-state" });
await using session = await WorkspaceSession.open(command, {
  model: "gpt-6.1-sol",
  effort: "medium",
  onEvent: (e) => console.log(e.type), // commandExecution / fileChange / agentMessage ...
});

const usage = await session.usage(); // 5時間 (300分) と週 (10080分) の窓の使用率
if (usage.reached) throw new Error("使用量の上限です");

await session.startThread("作業の決まり (developer instructions)");
const result = await session.runTurn("inbox/a.md を取り込んでください");
console.log(result.changed, result.usage); // 書き換えたファイルと、使ったトークン
await session.runTurn("次の誤りを直してください …"); // 同じスレッドに続けて頼む
```

| Python 版 | TypeScript 版 |
| --- | --- |
| `ensure_image(max_age=timedelta(days=1))` | `await ensureImage({ maxAgeMs })` |
| `docker_command(ws, auth_volume=..., config_overrides=(...))` | `dockerCommand(ws, { authVolume, configOverrides })` |
| `with WorkspaceSession(cmd) as s:` | `await using s = await WorkspaceSession.open(cmd)` |
| `s.start_thread(...)` / `s.run_turn(...)` / `s.usage()` | `await s.startThread(...)` / `await s.runTurn(...)` / `await s.usage()` |
| `TurnResult.commands[].exit_code` | `TurnResult.commands[].exitCode` |
| `turn_timeout` / `request_timeout`（秒） | `turnTimeoutMs` / `requestTimeoutMs`（ミリ秒） |
| `docker_command(ws, access_token_env=ACCESS_TOKEN_ENV)` / `chatgpt_plan_overrides()` | `dockerCommand(ws, { accessTokenEnv: ACCESS_TOKEN_ENV })` / `chatgptPlanOverrides()` |
| `WorkspaceSession(cmd, env=..., client_info=...)` | `WorkspaceSession.open(cmd, { env, clientInfo })` |
| `s.restart(env=...)` / `s.resume_thread(id)` | `await s.restart({ env })` / `await s.resumeThread(id)` |
| `s.run_turn(text, cancel=threading.Event())` | `await s.runTurn(text, { signal })`（`AbortSignal`） |
| `with docker_context() as path:` | `DOCKER_CONTEXT` |

例外は `WorkspaceError`、使用量の上限に当たったターンはその派生の `UsageLimitError` です
（待てば戻るが、すぐに頼み直しても同じように失敗するので、続けて頼むのをやめる）。

## Sign in with ChatGPT（プラン利用）で動かす

[公式の Codex app-server の手順](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)のとおり、
呼ぶ側が Sign in with ChatGPT で得た access token を環境変数で渡し、Codex 自身のサインイン（auth.json）を使わずに動かせます。
サインイン・トークンの保存と更新は呼ぶ側が行います（このパッケージはトークンを扱わない）。

```ts
import { ACCESS_TOKEN_ENV, WorkspaceSession, dockerCommand } from "@infodb/codex-workspace";

// 認証のファイルはマウントしない。-e ACCESS_TOKEN（名前だけ）と、プラン利用の provider の設定（-c）を付ける
const command = dockerCommand("/path/to/workspace", { accessTokenEnv: ACCESS_TOKEN_ENV });
await using session = await WorkspaceSession.open(command, {
  env: { [ACCESS_TOKEN_ENV]: accessToken }, // 値はプロセスの環境で渡す（引数・ログ・例外には出さない）
  clientInfo: { name: "my_app", title: "My App", version: "1.2.3" }, // name は登録のときの agent_name_hint と同じに
});
const thread = await session.startThread("…");
await session.runTurn("…");

// トークンを更新したら、起動し直してスレッドを続ける（記録を残すスレッドのとき）
await session.restart({ env: { [ACCESS_TOKEN_ENV]: renewed } });
await session.resumeThread(thread);
```

- `chatgptPlanOverrides(envKey)` — プラン利用の provider の設定（`model_provider="openai_chatgpt_plan"` ほか）。`dockerCommand` が付ける
- 使用量の上限（`subscription_sharing_usage_limit_exceeded`）も `UsageLimitError` にする
- `usage()`（`account/rateLimits/read`）は Codex 自身のサインインが前提なので、この方式では呼ばない（使用量を読む公式の API は無い）
- `startThread` は記録を残さない（`ephemeral`）スレッドで、`--rm` のコンテナは終わると消えるため、起動し直した後に
  `resumeThread` できるのは記録を残す使い方をしたときだけ。そうでなければ、頼む前に1ターンより長く使えるトークンにしておく

## 開発

```bash
pnpm install
pnpm test        # 偽の app-server (test/fake-app-server.mjs) で JSON-RPC のやりとりを確かめる
pnpm lint        # oxlint
pnpm check       # 型検査・Lint・テスト・ビルド
```

ライブラリは Node 22 以上。テストは `.ts` をそのまま動かし `await using` を使うので Node 24 以上。

版を上げるときは `package.json` の `version` と `src/session.ts` の `CLIENT_VERSION` を揃え、
`pnpm check` を通してから `codex-workspace-ts-vX.Y.Z` のタグを打ち、手で npm に公開します。

```bash
npm login              # @infodb に公開できるアカウントで
npm publish            # prepublishOnly で pnpm check が走る。publishConfig.access は public
```

Python 版の振る舞いを変えたときは、こちらにも同じ変更を入れます。片方にだけ入れたものは
[codex-workspace/DIFFERENCES.md](../codex-workspace/DIFFERENCES.md) に書き足します。
