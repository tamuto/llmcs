# chatgpt-plan-ts

[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) のプラン利用で、
利用者自身の ChatGPT プランを使って **Responses API を直接呼ぶ**ための TypeScript の部品です（`@infodb/chatgpt-plan`）。

- サインイン（OAuth + PKCE、`127.0.0.1` でのコールバック待ち受け、ID トークンの検証）と、トークンの保存・更新・解除
- Responses API（`POST /v1/responses`）の呼び出しと、モデルの一覧（`GET /v1/models`）

サインインの部分は p3（`docs/chatgpt-sign-in.md`）の実装を、アプリ名と保存先を引数にして切り出したものです。
Codex app-server でプランを使う場合は [codex-workspace-ts](../codex-workspace-ts) の `accessTokenEnv` と組み合わせます
（トークンは `account.accessToken(35 * 60_000)` のように長めに取ります）。

依存はありません（Node の `crypto` と `fetch` だけ）。Node 22 以上。

npm に公開した版だけを使います（git の URL や `link:` では参照しません）。
ビルド結果（`dist/`）はコミットせず、公開するときに `prepublishOnly` で作ります。

> 公式の前提: プラン利用はオープンソースのアプリと、利用者の手元（自分の PC や自分の VM）で動かすアプリ向けです。
> 有料のアプリや、リモートでホストするアプリで使う場合は OpenAI の申請フォームが必要です。

## 使い方

```ts
import { ChatGptAccount, createResponse, listModels, UsageLimitError } from "@infodb/chatgpt-plan";
import { homedir } from "node:os";

const account = new ChatGptAccount({
  file: `${homedir()}/.config/myapp/chatgpt.json`, // 0600 で保存する。アプリの他の設定とは別のファイルに
  appName: "infodb_myapp", // 初回の登録で送る agent_name_hint
  appLabel: "MyApp",
});

// サインイン: 127.0.0.1:1455（使えなければ空いているポート）で待ち受け、URL をブラウザで開いてもらう
const attempt = await account.startLogin();
console.log(attempt.url);
await attempt.done; // ブラウザがコールバックに届かない環境では attempt.submit(アドレスバーの URL)

// 推論（access token は期限が近ければ自動で更新される）
const models = await listModels({ accessToken: () => account.accessToken() });
const r = await createResponse(
  {
    model: models[0]!.slug,
    instructions: "日本語で簡潔に答える",
    input: [{ role: "user", content: "こんにちは" }],
  },
  { accessToken: () => account.accessToken(), onDelta: (d) => process.stdout.write(d) },
);
console.log(r.text, r.usage);
```

JSON Schema で形を決めた応答は `createJsonResponse()`（`text.format` に `json_schema`）。パースまで行い、中身の検証は呼ぶ側で行います。

## 公式の決まりの守り方

| 決まり | この部品での扱い |
| --- | --- |
| `store: false`・`stream: true` が必須 | 常に付ける（変えられない）。イベントの流れを最後まで読み、`response.completed` だけを成功とする |
| `system` ロールは拒否される | 型に入れない。指示は `instructions` か `developer` ロール |
| `temperature`・`max_output_tokens`・`previous_response_id`・`metadata` などは送れない | 型に入れない。会話を続けるときは履歴を `input` に入れて送り直す |
| 画像生成・ファイル検索・Code Interpreter・`tool_search` などは使えない | ツールは扱わない |
| 使用量の上限（`subscription_sharing_usage_limit_exceeded` など） | `UsageLimitError`（HTTP の 429 でも、流れの途中の `response.failed` でも） |
| `response.incomplete`・流れが途中で切れる | `IncompleteResponseError`（途中までのテキストつき）・`ResponsesError("stream_interrupted")` |
| モデルはアカウントごと | `listModels()` は `visibility: "list"` のものを、サーバの並び順のまま返す |

トークンや状態の扱い（0600 での保存、更新の排他、`invalid_grant` などでの破棄、解除時の revoke、別アカウントでのサインインの拒否）は p3 と同じです。
`status()` が返すのはアカウントの email・プラン利用の可否・期限・登録の有無だけで、トークンは含めません。

## 検証

```bash
cd chatgpt-plan-ts
pnpm install
pnpm check   # 型チェック・Lint（oxlint）・テスト・ビルド
```
