import assert from "node:assert/strict";
import { test } from "node:test";
import { createJsonResponse, createResponse, IncompleteResponseError, listModels, ResponsesError, UsageLimitError } from "../src/index.ts";

/** SSE の本文を、わざと細切れのチャンクで返す */
function sse(events: object[], chunk = 7): ReadableStream<Uint8Array> {
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { f, calls };
}

const completed = (text: string) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    model: "gpt-test",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  },
});

test("差分を流しながら読み、completed の出力を返す。store: false と stream: true を必ず送る", async () => {
  const { f, calls } = fakeFetch(() =>
    new Response(sse([{ type: "response.created" }, { type: "response.output_text.delta", delta: "こん" }, { type: "response.output_text.delta", delta: "にちは" }, completed("こんにちは")])),
  );
  const deltas: string[] = [];
  const r = await createResponse(
    { model: "gpt-test", instructions: "丁寧に", input: [{ role: "user", content: "挨拶して" }] },
    { accessToken: async () => "tok", fetch: f, onDelta: (d) => deltas.push(d) },
  );
  assert.equal(r.text, "こんにちは");
  assert.equal(r.id, "resp_1");
  assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  assert.deepEqual(deltas, ["こん", "にちは"]);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/responses");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer tok");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "丁寧に");
});

test("response.failed の使用量の上限は UsageLimitError", async () => {
  const { f } = fakeFetch(() =>
    new Response(sse([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }])),
  );
  await assert.rejects(createResponse({ model: "m", input: [] }, { accessToken: "t", fetch: f }), UsageLimitError);
});

test("HTTP のエラーは本文のコードで分類する（429 の使用量の上限・401）", async () => {
  const limit = fakeFetch(() => Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached" } }, { status: 429 }));
  await assert.rejects(createResponse({ model: "m", input: [] }, { accessToken: "t", fetch: limit.f }), (e) => e instanceof UsageLimitError && e.status === 429);
  const unauth = fakeFetch(() => new Response("nope", { status: 401 }));
  await assert.rejects(createResponse({ model: "m", input: [] }, { accessToken: "t", fetch: unauth.f }), (e) => e instanceof ResponsesError && e.code === "unauthorized");
});

test("incomplete は途中までのテキストつきで例外、completed の無い流れも失敗にする", async () => {
  const inc = fakeFetch(() => new Response(sse([{ type: "response.output_text.delta", delta: "途中" }, { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])));
  await assert.rejects(createResponse({ model: "m", input: [] }, { accessToken: "t", fetch: inc.f }), (e) => e instanceof IncompleteResponseError && e.partialText === "途中" && e.reason === "max_output_tokens");
  const cut = fakeFetch(() => new Response(sse([{ type: "response.output_text.delta", delta: "途中" }])));
  await assert.rejects(createResponse({ model: "m", input: [] }, { accessToken: "t", fetch: cut.f }), (e) => e instanceof ResponsesError && e.code === "stream_interrupted");
});

test("JSON の応答をパースする", async () => {
  const { f, calls } = fakeFetch(() => new Response(sse([completed('{"a":1}')])));
  const { value } = await createJsonResponse<{ a: number }>(
    { model: "m", input: [{ role: "user", content: "x" }], text: { format: { type: "json_schema", name: "x", schema: { type: "object" }, strict: true } } },
    { accessToken: "t", fetch: f },
  );
  assert.deepEqual(value, { a: 1 });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).text.format.type, "json_schema");
});

test("モデルの一覧は visibility が list のものだけ、並び順はそのまま", async () => {
  const { f } = fakeFetch(() =>
    Response.json({ models: [{ slug: "b", display_name: "B", visibility: "list" }, { slug: "h", visibility: "hide" }, { slug: "a", display_name: "A", visibility: "list" }] }),
  );
  assert.deepEqual(await listModels({ accessToken: "t", fetch: f }), [
    { slug: "b", displayName: "B" },
    { slug: "a", displayName: "A" },
  ]);
});

test("access token を取れないときの例外は、そのまま返す（接続の失敗にしない）", async () => {
  class SignInRequired extends Error {}
  const { f, calls } = fakeFetch(() => new Response("{}"));
  await assert.rejects(
    createResponse({ model: "m", input: [] }, { accessToken: async () => { throw new SignInRequired("サインインしてください"); }, fetch: f }),
    SignInRequired,
  );
  assert.equal(calls.length, 0);
});
