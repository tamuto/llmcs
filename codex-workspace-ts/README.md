# codex-workspace-ts

[codex-workspace](../codex-workspace) の TypeScript 版です。`codex app-server` を、渡した作業場所だけを
マウントした Docker のコンテナの中で動かし、Node から操ります。コンテナを囲いにするので、Codex には
囲いなし（`danger-full-access`）でコマンドの実行とファイルの書き込みを許します。コンテナから見えるのは、
作業場所（`/workspace`）と認証情報のファイル1つ（`/codex/auth.json`）だけです。

Python 版と同じ Dockerfile・同じイメージ（`llmcs-codex-workspace:local`）を使うので、どちらで作った
イメージも共有できます（Dockerfile が同じであることはテストで確かめています）。

## 使い方

pnpm の git 依存で、llmcs リポジトリの `codex-workspace-ts/` を参照します。タグで版を固定してください。
タグはパッケージ名を頭に付けた `codex-workspace-ts-v<版>` です。

```json
{
  "dependencies": {
    "@llmcs/codex-workspace": "github:tamuto/llmcs#codex-workspace-ts-v0.1.0&path:/codex-workspace-ts"
  }
}
```

ビルド結果（`dist/`）をコミットしているので、入れるときにスクリプトは動きません（pnpm の `allowBuilds` は不要）。
npm はサブディレクトリの git 依存を扱えないので、pnpm を使ってください。手元で同時に直すときは
一時的に `"link:../llmcs/codex-workspace-ts"` へ向けます。

```ts
import { WorkspaceSession, dockerCommand, ensureImage, UsageLimitError } from "@llmcs/codex-workspace";

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

TypeScript 版だけにあるもの:

- `runTurn(text, { signal })` — `AbortSignal` で中止すると `turn/interrupt` を送り、`status: "interrupted"` の結果を返す
- `DOCKER_CONTEXT` — 同梱の Dockerfile のあるフォルダ

例外は `WorkspaceError`、使用量の上限に当たったターンはその派生の `UsageLimitError` です
（待てば戻るが、すぐに頼み直しても同じように失敗するので、続けて頼むのをやめる）。

## 開発

```bash
pnpm install
pnpm test        # 偽の app-server (test/fake-app-server.mjs) で JSON-RPC のやりとりを確かめる
pnpm check       # 型検査・テスト・ビルドをして、コミットした dist/ が最新か確かめる
```

ライブラリは Node 22 以上。テストは `.ts` をそのまま動かし `await using` を使うので Node 24 以上。

版を上げるときは `package.json` の `version` と `src/session.ts` の `CLIENT_VERSION` を揃え、
`pnpm check` を通してから `codex-workspace-ts-vX.Y.Z` のタグを打ちます。
Python 版の振る舞いを変えたときは、こちらにも同じ変更を入れます。
