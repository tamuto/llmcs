import { createHash, createPublicKey, randomBytes, verify, type webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;

/**
 * Sign in with ChatGPT（プラン利用）の OAuth。公式: developers.openai.com/siwc/token-sharing-open-source
 * p3（docs/chatgpt-sign-in.md）の実装を、アプリ名を引数にして切り出したもの。依存を足さず、Node の crypto と fetch で行う。
 */

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
/** プラン利用（推論）に要る scope。これが付与されていなければ推論には使わない */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE];
/** 初回の登録に使う client ID（登録すると oaiapp_… が発行される） */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CALLBACK_PATH = "/auth/callback";
export const DEFAULT_PORT = 1455;

export interface Endpoints {
  issuer: string;
  authorize: string;
  token: string;
  revoke: string;
  jwks: string;
}

export const OPENAI_ENDPOINTS: Endpoints = {
  issuer: ISSUER,
  authorize: `${ISSUER}/api/accounts/authorize`,
  token: `${ISSUER}/api/accounts/oauth/token`,
  revoke: `${ISSUER}/api/accounts/oauth/revoke`,
  jwks: `${ISSUER}/.well-known/jwks.json`,
};

/** テストで差し替えられるもの */
export interface OAuthDeps {
  endpoints: Endpoints;
  fetch: typeof fetch;
  now: () => number;
}

export const defaultDeps = (): OAuthDeps => ({ endpoints: OPENAI_ENDPOINTS, fetch: globalThis.fetch, now: Date.now });

/** サインインやトークンの操作の失敗。code は OAuth のエラー（invalid_grant など）か、この実装の分類 */
export class OAuthError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

/** 更新できない（サインインし直すしかない）refresh のエラー（公式の Errors and recovery） */
export const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const b64url = (b: Buffer) => b.toString("base64url");

/** 1回のサインインの試行に使う値（毎回新しく） */
export interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
}

export function newAttempt(redirectUri: string): Attempt {
  return { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)), redirectUri };
}

export const challengeOf = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

/**
 * authorize の URL。初回（clientId が無い）は dynamic_agent_client と agent_name_hint で登録する。
 * 再サインインは発行された client ID と id_token_hint（あれば login_hint）。
 */
export function authorizeUrl(
  e: Endpoints,
  a: Attempt,
  reg: { hostId: string; clientId?: string; idToken?: string; email?: string },
  /** 初回の登録で送るアプリの名前（agent_name_hint）。Codex app-server を使うなら initialize の clientInfo.name とそろえる */
  appName: string,
): string {
  const q = new URLSearchParams({
    client_id: reg.clientId ?? DYNAMIC_CLIENT_ID,
    ext_agent_host_id: reg.hostId,
    response_type: "code",
    redirect_uri: a.redirectUri,
    scope: SCOPES.join(" "),
    resource: RESOURCE,
    state: a.state,
    nonce: a.nonce,
    code_challenge_method: "S256",
    code_challenge: challengeOf(a.verifier),
  });
  if (!reg.clientId) q.set("agent_name_hint", appName);
  if (reg.clientId && reg.idToken) q.set("id_token_hint", reg.idToken);
  if (reg.clientId && reg.email) q.set("login_hint", reg.email);
  return `${e.authorize}?${q}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** ISO */
  expiresAt: string;
  scopes: string[];
}

async function postForm(d: OAuthDeps, url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await d.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    });
  } catch (e) {
    throw new OAuthError(`${url} に接続できません: ${(e as Error).message}`, "network");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // JSON でない応答
  }
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : res.status >= 500 ? "server_error" : `http_${res.status}`;
    // 応答の本文はトークンを含まないが、念のため説明の文だけを出す
    const desc = typeof data.error_description === "string" ? `（${data.error_description}）` : "";
    throw new OAuthError(`${code}${desc}`, code);
  }
  return data;
}

function tokenSet(d: OAuthDeps, data: Record<string, unknown>, prev?: TokenSet): TokenSet {
  if (typeof data.access_token !== "string") throw new OAuthError("トークンの応答に access_token がありません", "bad_response");
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : prev?.refreshToken,
    idToken: typeof data.id_token === "string" ? data.id_token : prev?.idToken,
    expiresAt: new Date(d.now() + expiresIn * 1000).toISOString(),
    scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : (prev?.scopes ?? []),
  };
}

/** 認可コードをトークンに換える（authorize と同じ redirect_uri・resource） */
export async function exchangeCode(d: OAuthDeps, clientId: string, a: Attempt, code: string): Promise<TokenSet> {
  const data = await postForm(d, d.endpoints.token, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: a.verifier,
    redirect_uri: a.redirectUri,
    resource: RESOURCE,
  });
  return tokenSet(d, data);
}

/** トークンを更新する。refresh token は毎回入れ替わる（応答の値でまとめて置き換える） */
export async function refreshTokens(d: OAuthDeps, clientId: string, prev: TokenSet): Promise<TokenSet> {
  if (!prev.refreshToken) throw new OAuthError("refresh token がありません", "invalid_grant");
  const data = await postForm(d, d.endpoints.token, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: prev.refreshToken,
    resource: RESOURCE,
  });
  return tokenSet(d, data, prev);
}

/** refresh token を取り消す（既に無効でも 200） */
export async function revoke(d: OAuthDeps, clientId: string, refreshToken: string): Promise<void> {
  await postForm(d, d.endpoints.revoke, { token: refreshToken, token_type_hint: "refresh_token", client_id: clientId });
}

// --- ID トークン ------------------------------------------------------------

export interface IdClaims {
  sub: string;
  email?: string;
}

let jwksCache: { url: string; at: number; keys: (JsonWebKey & { kid?: string })[] } | undefined;

async function jwks(d: OAuthDeps, kid: string | undefined, force = false) {
  if (force || !jwksCache || jwksCache.url !== d.endpoints.jwks || d.now() - jwksCache.at > 3_600_000) {
    let res: Response;
    try {
      res = await d.fetch(d.endpoints.jwks);
    } catch (e) {
      throw new OAuthError(`署名の鍵を取得できません: ${(e as Error).message}`, "network");
    }
    if (!res.ok) throw new OAuthError(`署名の鍵を取得できません（HTTP ${res.status}）`, "network");
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    jwksCache = { url: d.endpoints.jwks, at: d.now(), keys: body.keys ?? [] };
  }
  const key = jwksCache.keys.find((k) => k.kid === kid) ?? (kid ? undefined : jwksCache.keys[0]);
  // 鍵が入れ替わった直後は、取り直してもう一度探す
  if (!key && !force) return jwks(d, kid, true);
  return key;
}

/** ID トークンを検証する: RS256 の署名（JWKS）、iss、aud（発行された client ID）、exp、nonce */
export async function verifyIdToken(d: OAuthDeps, idToken: string, clientId: string, nonce?: string): Promise<IdClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("ID トークンの形が正しくありません", "invalid_id_token");
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    throw new OAuthError("ID トークンを読めません", "invalid_id_token");
  }
  if (header.alg !== "RS256") throw new OAuthError(`ID トークンの署名方式が想定外です: ${header.alg}`, "invalid_id_token");
  const jwk = await jwks(d, header.kid);
  if (!jwk) throw new OAuthError("ID トークンの署名の鍵が見つかりません", "invalid_id_token");
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new OAuthError("ID トークンの署名が正しくありません", "invalid_id_token");
  if (claims.iss !== d.endpoints.issuer) throw new OAuthError(`ID トークンの発行元が違います: ${String(claims.iss)}`, "invalid_id_token");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new OAuthError("ID トークンの宛先がこの登録ではありません", "invalid_id_token");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < d.now() - 60_000) throw new OAuthError("ID トークンの期限が切れています", "invalid_id_token");
  if (nonce !== undefined && claims.nonce !== nonce) throw new OAuthError("ID トークンの nonce が違います（別の試行の応答です）", "invalid_id_token");
  if (typeof claims.sub !== "string" || !claims.sub) throw new OAuthError("ID トークンにアカウント（sub）がありません", "invalid_id_token");
  return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined };
}

/** テスト用: JWKS のキャッシュを捨てる */
export function resetJwksCache() {
  jwksCache = undefined;
}
