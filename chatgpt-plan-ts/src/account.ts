import { createServer, type Server } from "node:http";
import {
  authorizeUrl,
  CALLBACK_PATH,
  DEFAULT_PORT,
  defaultDeps,
  exchangeCode,
  newAttempt,
  OAuthError,
  PLAN_SCOPE,
  refreshTokens,
  revoke,
  TERMINAL_REFRESH_ERRORS,
  verifyIdToken,
  type Attempt,
  type OAuthDeps,
} from "./oauth.ts";
import { connectionMtime, loadConnection, loadOrNew, saveConnection, withLock, type Connection } from "./store.ts";

/** 画面に出してよい状態（トークンは含めない） */
export interface ChatGptStatus {
  /** サインイン済みでトークンがある */
  connected: boolean;
  /** プラン利用（chatgpt.tokens.use.direct）が許可されている */
  planAllowed: boolean;
  email?: string;
  /** access token の期限（ISO） */
  expiresAt?: string;
  /** このマシンを登録済み（client ID がある） */
  registered: boolean;
  /** 待っているサインイン */
  pending?: { url: string; redirectUri: string; startedAt: string; expiresAt: string };
  /** 直前のサインインの失敗 */
  lastError?: string;
}

/** 推論に使えない理由。code で次にすることを分ける */
export class ChatGptAuthError extends Error {
  readonly code: "not_connected" | "plan_not_allowed" | "signin_required" | "network";
  constructor(message: string, code: ChatGptAuthError["code"]) {
    super(message);
    this.name = "ChatGptAuthError";
    this.code = code;
  }
}

export interface LoginAttempt {
  url: string;
  redirectUri: string;
  startedAt: string;
  expiresAt: string;
  /** サインインが終わったら（失敗したら reject） */
  done: Promise<ChatGptStatus>;
  /** やめる（待ち受けを閉じる） */
  cancel(): void;
  /** コールバックの URL を手で渡す（ブラウザがコールバックに届かない環境で、アドレスバーの URL を貼る） */
  submit(callbackUrl: string): Promise<ChatGptStatus>;
}

/** 推論に使える接続か（サインイン済みで、プラン利用が許可されている）。使えなければ ChatGptAuthError */
function checkUsable(c?: Connection): void {
  if (!c?.tokens) throw new ChatGptAuthError("ChatGPT にサインインしていません（「Continue with ChatGPT」からサインインしてください）", "not_connected");
  if (!c.tokens.scopes.includes(PLAN_SCOPE)) {
    throw new ChatGptAuthError("ChatGPT プランの利用が許可されていません。もう一度サインインして、プランの利用に同意してください", "plan_not_allowed");
  }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:2rem"><h1>${title}</h1><p>${body}</p></body>`;

export interface ChatGptAccountOptions {
  /** 接続を保存するファイル（例: ~/.config/<アプリ>/chatgpt.json）。0600 で書く */
  file: string;
  /** 初回の登録で送るアプリの名前（agent_name_hint。例: infodb_p3） */
  appName: string;
  /** サインイン後のページに出すアプリの表示名 */
  appLabel?: string;
  /** テストで差し替える */
  deps?: OAuthDeps;
}

/**
 * ChatGPT（Sign in with ChatGPT のプラン利用）との接続。
 * 127.0.0.1 でコールバックを待ち受けるので、ブラウザと同じマシン（または転送されたポート）で動かす。
 */
export class ChatGptAccount {
  private attempt?: LoginAttempt;
  private lastError?: string;
  private readonly file: string;
  private readonly appName: string;
  private readonly appLabel: string;
  private readonly deps: OAuthDeps;

  constructor(opts: ChatGptAccountOptions) {
    this.file = opts.file;
    this.appName = opts.appName;
    this.appLabel = opts.appLabel ?? opts.appName;
    this.deps = opts.deps ?? defaultDeps();
  }

  /** 接続のファイルの更新日時（別のプロセスでの変化に気付くため） */
  mtime() {
    return connectionMtime(this.file);
  }

  async status(): Promise<ChatGptStatus> {
    const c = await loadConnection(this.file);
    const t = c?.tokens;
    const a = this.attempt;
    return {
      connected: !!t,
      planAllowed: !!t?.scopes.includes(PLAN_SCOPE),
      email: c?.account?.email,
      expiresAt: t?.expiresAt,
      registered: !!c?.clientId,
      pending: a ? { url: a.url, redirectUri: a.redirectUri, startedAt: a.startedAt, expiresAt: a.expiresAt } : undefined,
      lastError: this.lastError,
    };
  }

  /**
   * サインインを始める: 127.0.0.1 で待ち受けてから authorize の URL を返す。同時に1つだけ。
   * 既存の接続は、新しい試行が成功するまで変えない。
   */
  async startLogin(opts: { port?: number; timeoutMs?: number } = {}): Promise<LoginAttempt> {
    if (this.attempt) throw new Error("サインインを待っています。先に取り消してください");
    const conn = await loadOrNew(this.file);
    let server: Server | undefined;
    let finish!: (s: ChatGptStatus) => void;
    let fail!: (e: Error) => void;
    const done = new Promise<ChatGptStatus>((res, rej) => {
      finish = res;
      fail = rej;
    });
    done.catch(() => {}); // 待つ人がいなくても未処理にしない
    let settled = false;
    const close = () => {
      server?.close();
      server?.closeAllConnections?.();
      if (this.attempt === attempt) this.attempt = undefined;
    };
    const end = (e?: Error, s?: ChatGptStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      this.lastError = e?.message;
      if (e) fail(e);
      else finish(s!);
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      void this.complete(conn, a, url.searchParams).then(
        (s) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE("サインインしました", `この画面は閉じてかまいません。${escapeHtml(this.appLabel)} に戻ってください。`));
          end(undefined, s);
        },
        (e: Error) => {
          const mismatch = e instanceof OAuthError && e.code === "state_mismatch";
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("サインインできませんでした", escapeHtml(e.message)));
          // 別の試行の応答（state が違う）では、この試行を終わらせない
          if (!mismatch) end(e);
        },
      );
    });
    const port = await listen(server, opts.port ?? DEFAULT_PORT);
    const a: Attempt = newAttempt(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const timer = setTimeout(() => end(new OAuthError("サインインを待ちきれませんでした（5分）", "timeout")), timeoutMs);
    timer.unref?.();
    const startedAt = new Date(this.deps.now());
    const attempt: LoginAttempt = {
      url: authorizeUrl(this.deps.endpoints, a, {
        hostId: conn.hostId,
        clientId: conn.clientId,
        idToken: conn.tokens?.idToken,
        email: conn.account?.email,
      }, this.appName),
      redirectUri: a.redirectUri,
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
      done,
      cancel: () => end(new OAuthError("サインインを取り消しました", "cancelled")),
      submit: async (callbackUrl: string) => {
        let params: URLSearchParams;
        try {
          params = new URL(callbackUrl.trim()).searchParams;
        } catch {
          throw new OAuthError("URL を読めません（ブラウザのアドレスバーの URL をそのまま貼ってください）", "bad_callback");
        }
        try {
          const s = await this.complete(conn, a, params);
          end(undefined, s);
          return s;
        } catch (e) {
          if (!(e instanceof OAuthError && e.code === "state_mismatch")) end(e as Error);
          throw e;
        }
      },
    };
    this.attempt = attempt;
    this.lastError = undefined;
    return attempt;
  }

  /** 待っている試行 */
  pending(): LoginAttempt | undefined {
    return this.attempt;
  }

  /** コールバックの値を確かめてトークンに換え、ID トークンを検証して保存する */
  private async complete(conn: Connection, a: Attempt, q: URLSearchParams): Promise<ChatGptStatus> {
    if (q.get("state") !== a.state) throw new OAuthError("この試行の応答ではありません（state が違います）", "state_mismatch");
    const err = q.get("error");
    if (err) {
      const why = err === "access_denied" ? "サインインか同意が取り消されました" : `${err}${q.get("error_description") ? `（${q.get("error_description")}）` : ""}`;
      throw new OAuthError(why, err);
    }
    const code = q.get("code");
    if (!code) throw new OAuthError("認可コードがありません", "bad_callback");
    const clientId = q.get("client_id") ?? conn.clientId;
    if (!clientId) throw new OAuthError("発行された client ID がコールバックにありません", "bad_callback");

    const tokens = await exchangeCode(this.deps, clientId, a, code);
    if (!tokens.idToken) throw new OAuthError("ID トークンがありません", "invalid_id_token");
    const claims = await verifyIdToken(this.deps, tokens.idToken, clientId, a.nonce);

    return withLock(this.file, async () => {
      // 保存の直前に読み直す（ほかのプロセスでの変更を消さない）
      const cur = (await loadConnection(this.file)) ?? conn;
      if (cur.account && cur.account.sub !== claims.sub) {
        throw new OAuthError(
          `接続済みのアカウント（${cur.account.email ?? cur.account.sub}）と違うアカウントでサインインしました。切り替えるには先に接続を解除してください（登録ごと消す: logout({ forget: true })）`,
          "account_mismatch",
        );
      }
      await saveConnection(
        { hostId: cur.hostId, clientId, account: { sub: claims.sub, email: claims.email ?? cur.account?.email }, tokens: { ...tokens, savedAt: new Date(this.deps.now()).toISOString() } },
        this.file,
      );
      return this.status();
    });
  }

  /**
   * 推論に使う access token。期限まで minValidMs を切っていたら更新する（排他）。
   * 既定の 5 分は Responses API の 1 リクエスト向け。長く走る処理（Codex app-server の 1 ターンなど）は長めに渡す。
   * 使えなければ ChatGptAuthError（code で次にすることが分かる）。
   */
  async accessToken(minValidMs = 5 * 60_000): Promise<string> {
    const fresh = (c?: Connection) => {
      const t = c?.tokens;
      return t && Date.parse(t.expiresAt) - this.deps.now() > minValidMs ? t.accessToken : undefined;
    };
    const c0 = await loadConnection(this.file);
    checkUsable(c0);
    const t0 = fresh(c0);
    if (t0) return t0;
    return withLock(this.file, async () => {
      // lock を待つ間にほかのプロセスが更新していれば、それを使う
      const c = await loadConnection(this.file);
      checkUsable(c);
      const t = fresh(c);
      if (t) return t;
      try {
        const next = await refreshTokens(this.deps, c!.clientId!, c!.tokens!);
        await saveConnection({ ...c!, tokens: { ...next, savedAt: new Date(this.deps.now()).toISOString() } }, this.file);
        if (!next.scopes.includes(PLAN_SCOPE)) throw new ChatGptAuthError("ChatGPT プランの利用が許可されていません", "plan_not_allowed");
        return next.accessToken;
      } catch (e) {
        if (e instanceof OAuthError && e.code && TERMINAL_REFRESH_ERRORS.has(e.code)) {
          // 更新できないトークンは消す（登録とアカウントは残し、同じ登録でサインインし直す）
          await saveConnection({ ...c!, tokens: undefined }, this.file);
          throw new ChatGptAuthError(`ChatGPT の接続が切れました（${e.code}）。サインインし直してください`, "signin_required");
        }
        if (e instanceof OAuthError && (e.code === "network" || e.code === "server_error")) {
          throw new ChatGptAuthError(`ChatGPT のトークンを更新できません（${e.message}）。しばらくしてからやり直してください`, "network");
        }
        throw e;
      }
    });
  }

  /**
   * 接続を解除する: refresh token を取り消してからトークンを消す。登録（ホスト ID・client ID）とアカウントは残す
   * （次のサインインで同じ登録を使う）。forget なら登録ごと消す。取り消しが通らなくてもローカルのトークンは消す。
   */
  async logout(opts: { forget?: boolean } = {}): Promise<{ revoked: boolean; message: string }> {
    this.attempt?.cancel();
    return withLock(this.file, async () => {
      const c = await loadConnection(this.file);
      let revoked = false;
      let note = "";
      if (c?.tokens?.refreshToken && c.clientId) {
        try {
          await revoke(this.deps, c.clientId, c.tokens.refreshToken);
          revoked = true;
        } catch (e) {
          note = `（ChatGPT 側での取り消しを確かめられませんでした: ${(e as Error).message}。ChatGPT の設定で接続を切ってください）`;
        }
      }
      if (c) {
        if (opts.forget) await saveConnection({ hostId: c.hostId }, this.file);
        else await saveConnection({ ...c, tokens: undefined }, this.file);
      }
      return { revoked, message: `${c?.tokens ? "接続を解除しました" : "接続していません"}${note}` };
    });
  }
}

async function listen(server: Server, port: number): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number>((res, rej) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        rej(e);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        res(typeof addr === "object" && addr ? addr.port : p);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, "127.0.0.1");
    });
  try {
    return await tryPort(port);
  } catch (e) {
    // 既定のポートが使われていれば、空いているポートで（パスは同じ）
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && port !== 0) return tryPort(0);
    throw new OAuthError(`コールバックを待ち受けられません: ${(e as Error).message}`, "listen_failed");
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
