import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatGptAccount, ChatGptAuthError, PLAN_SCOPE, type Endpoints, type OAuthDeps } from "../src/index.ts";
import { resetJwksCache } from "../src/oauth.ts";

const endpoints: Endpoints = {
  issuer: "https://auth.example",
  authorize: "https://auth.example/authorize",
  token: "https://auth.example/token",
  revoke: "https://auth.example/revoke",
  jwks: "https://auth.example/jwks",
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };

const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

function idToken(claims: Record<string, unknown>) {
  const head = enc({ alg: "RS256", kid: "k1" });
  const body = enc(claims);
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/** 偽の認可サーバ。発行した nonce をコード交換時の ID トークンに入れる */
function fakeAuth(now: () => number) {
  let nonce = "";
  let refreshCount = 0;
  const log: { url: string; body: URLSearchParams }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const body = new URLSearchParams(String(init.body ?? ""));
    log.push({ url: u, body });
    if (u === endpoints.jwks) return Response.json({ keys: [jwk] });
    if (u === endpoints.revoke) return new Response("{}");
    if (u === endpoints.token) {
      const grant = body.get("grant_type");
      if (grant === "refresh_token" && body.get("refresh_token") === "bad") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (grant === "refresh_token") refreshCount++;
      return Response.json({
        access_token: `at-${refreshCount}`,
        refresh_token: `rt-${refreshCount}`,
        expires_in: 3600,
        scope: `openid email offline_access ${PLAN_SCOPE}`,
        id_token: idToken({ iss: endpoints.issuer, aud: "oaiapp_1", sub: "user-1", email: "a@example.com", exp: Math.floor(now() / 1000) + 600, nonce }),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, log, setNonce: (n: string) => (nonce = n) };
}

test("サインイン → access token（期限が近ければ更新）→ 解除", async () => {
  resetJwksCache();
  let t = Date.parse("2026-10-13T00:00:00Z");
  const now = () => t;
  const auth = fakeAuth(now);
  const deps: OAuthDeps = { endpoints, fetch: auth.f, now };
  const file = join(await mkdtemp(join(tmpdir(), "chatgpt-plan-")), "chatgpt.json");
  const account = new ChatGptAccount({ file, appName: "infodb_test", deps });

  await assert.rejects(account.accessToken(), (e) => e instanceof ChatGptAuthError && e.code === "not_connected");

  const attempt = await account.startLogin({ port: 0 });
  const url = new URL(attempt.url);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "infodb_test");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  auth.setNonce(url.searchParams.get("nonce")!);

  // ブラウザが戻ってくる代わりに、コールバックの URL を手で渡す
  const callback = `${attempt.redirectUri}?state=${url.searchParams.get("state")}&code=c1&client_id=oaiapp_1`;
  const status = await attempt.submit(callback);
  assert.equal(status.connected, true);
  assert.equal(status.planAllowed, true);
  assert.equal(status.email, "a@example.com");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(status).includes("at-0"), "状態にトークンを出さない");

  assert.equal(await account.accessToken(), "at-0");
  t += 58 * 60_000; // 期限まで 2 分 → 更新される
  assert.equal(await account.accessToken(), "at-1");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.tokens.refreshToken, "rt-1");

  const out = await account.logout();
  assert.equal(out.revoked, true);
  assert.equal((await account.status()).connected, false);
  assert.equal((await account.status()).registered, true, "登録（client ID）は残す");
});

test("state の違うコールバックでは試行を終わらせない", async () => {
  resetJwksCache();
  const auth = fakeAuth(Date.now);
  const file = join(await mkdtemp(join(tmpdir(), "chatgpt-plan-")), "chatgpt.json");
  const account = new ChatGptAccount({ file, appName: "infodb_test", deps: { endpoints, fetch: auth.f, now: Date.now } });
  const attempt = await account.startLogin({ port: 0 });
  await assert.rejects(attempt.submit(`${attempt.redirectUri}?state=other&code=c`), /state が違います/);
  assert.ok(account.pending(), "まだ待っている");
  attempt.cancel();
  await assert.rejects(attempt.done, /取り消しました/);
  assert.equal(account.pending(), undefined);
});
