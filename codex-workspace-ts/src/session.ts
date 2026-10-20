/**
 * コンテナの中の codex app-server を、作業場所を渡して動かす (Python 版 codex_workspace の TypeScript 版)。
 *
 * 作業場所 (ホストのフォルダ) を /workspace にマウントしたコンテナで app-server を起こし、
 * `docker run -i` の標準入出力を JSON-RPC の経路にする。コンテナが囲いになるので、Codex には
 * danger-full-access でコマンドの実行とファイルの書き込みを許し、承認は求めさせない。
 * コンテナに入れるのは作業場所と認証情報のファイル1つだけで、ホストのほかの場所は見えない。
 *
 * スレッドを1つ立て、同じスレッドに続けて頼める (前のやり取りの文脈とキャッシュが続く)。
 * 頼むたびに、Codex が書き換えたファイル、動かしたコマンド、使ったトークンを返すので、
 * 呼ぶ側はその結果を確かめて、崩れていれば作業場所を元に戻せばよい。
 *
 * 認証は2通り。Codex の初期設定でサインインした auth.json をマウントするか、Sign in with ChatGPT で
 * 呼ぶ側が得た access token を環境変数で渡す (chatgptPlanOverrides)。後者ではファイルをマウントせず、
 * トークンの値はコマンドの引数に入れない。
 *
 * 作業場所のパスは、Docker のデーモンから見た場所 (ホストの場所) で渡す。開発環境の
 * コンテナの中から動かすときは、そのコンテナの中の場所とは違うことがある。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export const DEFAULT_IMAGE = "llmcs-codex-workspace:local";
export const CONTAINER_WORKSPACE = "/workspace";
export const CONTAINER_AUTH = "/codex/auth.json";
const CLIENT_NAME = "codex_workspace";
const CLIENT_VERSION = "0.2.1";

/** Sign in with ChatGPT の access token を app-server に渡す環境変数の既定の名前 */
export const ACCESS_TOKEN_ENV = "ACCESS_TOKEN";

/**
 * Sign in with ChatGPT のプラン利用で app-server を動かす設定 (公式の Codex app-server の手順のとおり)。
 * Codex は環境変数 envKey の値を `Authorization: Bearer` で /v1/responses に送る。Codex 自身のサインインは要らない。
 */
export function chatgptPlanOverrides(envKey = ACCESS_TOKEN_ENV): string[] {
  const p = "model_providers.openai_chatgpt_plan";
  return [
    `model_provider="openai_chatgpt_plan"`,
    `${p}.name="ChatGPT plan"`,
    `${p}.base_url="https://api.openai.com/v1"`,
    `${p}.env_key="${envKey}"`,
    `${p}.wire_api="responses"`,
    `${p}.requires_openai_auth=false`,
    `${p}.supports_websockets=false`,
  ];
}

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

/**
 * Codex の使用量の上限 (5時間や週の窓) に当たって、ターンが失敗した。
 *
 * 待てば戻るが、すぐに頼み直しても同じように失敗する。呼び出し側は、続けて頼むのをやめる。
 */
export class UsageLimitError extends WorkspaceError {
  override name = "UsageLimitError";
}

/** codexErrorInfo のうち、使用量の上限に当たったもの。 */
const USAGE_LIMIT_ERRORS = new Set(["usageLimitExceeded", "rateLimitExceeded"]);
/** Sign in with ChatGPT のプラン利用で、使用量の上限に当たったときの Responses のエラーコード */
const PLAN_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

function isUsageLimit(error: unknown): boolean {
  const info = isRecord(error) ? error.codexErrorInfo : undefined;
  if (typeof info === "string" && USAGE_LIMIT_ERRORS.has(info)) return true;
  if (isRecord(info) && Object.keys(info).some((key) => USAGE_LIMIT_ERRORS.has(key))) return true;
  // 独自の provider では、API のエラーが本文のまま届く
  return json(error).includes(PLAN_USAGE_LIMIT_CODE);
}

/**
 * アカウントの使用量 (account/rateLimits/read)。
 *
 * windows は、窓の長さ (分) から、使った割合 (%) への対応。ChatGPT のプランでは、
 * 5時間 (300分) と週 (10080分) の2つ。allowed は、ふつうに使ってよいかの、
 * サーバー側の判断 (分からなければ null)。reached は、上限に当たっていればその種類。
 */
export class Usage {
  readonly windows: Record<number, number>;
  readonly allowed: boolean | null;
  readonly reached: string | null;

  constructor(windows: Record<number, number>, allowed: boolean | null, reached: string | null) {
    this.windows = windows;
    this.allowed = allowed;
    this.reached = reached;
  }

  used(minutes: number): number | null {
    return this.windows[minutes] ?? null;
  }
}

export function parseUsage(result: Record<string, unknown>): Usage {
  const limits = isRecord(result.rateLimits) ? result.rateLimits : {};
  const windows: Record<number, number> = {};
  for (const name of ["primary", "secondary"]) {
    const window = isRecord(limits[name]) ? limits[name] : {};
    if (window.windowDurationMins !== undefined && window.windowDurationMins !== null) {
      windows[Number(window.windowDurationMins)] = Number(window.usedPercent ?? 0);
    }
  }
  return new Usage(
    windows,
    typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
    typeof limits.rateLimitReachedType === "string" ? limits.rateLimitReachedType : null,
  );
}

export interface CommandRecord {
  command: string;
  exitCode: number | null;
}

export interface TurnResult {
  status: string;
  /** 最後の応答の文。 */
  message: string | null;
  /** 書き換えたファイル。作業場所からの相対パス。 */
  changed: string[];
  /** 動かしたコマンドと終了コード。 */
  commands: CommandRecord[];
  /**
   * このターンで使ったトークン。
   *
   * 1回の頼みごとの中では、ファイルを読む、書くといった手順ごとにモデルへの問い合わせが
   * 重なる。app-server の tokenUsage.last は最後の1回分だけなので、スレッドの累計
   * (tokenUsage.total) の、頼む前と後の差を取る。
   */
  usage: Record<string, unknown> | null;
  seconds: number;
}

/** item/completed の項目 (type は agentMessage, fileChange, commandExecution など) か、error。 */
export type WorkspaceEvent =
  | { type: string; item: Record<string, unknown> }
  | { type: "error"; error: unknown };

export interface DockerCommandOptions {
  image?: string;
  /** 認証情報 (auth.json) を入れた Docker ボリューム */
  authVolume?: string;
  authSubpath?: string;
  /** 認証情報のホストのファイル */
  authFile?: string;
  /**
   * Sign in with ChatGPT の access token を入れた環境変数の名前 (例: ACCESS_TOKEN)。
   * 指定すると認証のファイルはマウントせず、`-e <名前>` で docker を起こしたプロセスの環境から値を引き継ぎ、
   * chatgptPlanOverrides の設定で app-server を起こす。値は引数に入らない (WorkspaceSessionOptions.env で渡す)。
   */
  accessTokenEnv?: string;
  docker?: string;
  configOverrides?: string[];
}

/**
 * app-server を起こす docker run。認証は、ボリュームの中のファイル・ホストのファイル・access token の環境変数のどれか1つ。
 *
 * 認証情報のファイルは読み書きできるようにマウントする。Codex がトークンを更新したときに書き戻すため。
 * access token のときは Codex は更新しない (更新は呼ぶ側が行い、起動し直す → WorkspaceSession.restart)。
 */
export function dockerCommand(workspace: string, options: DockerCommandOptions = {}): string[] {
  const { image = DEFAULT_IMAGE, authVolume, authSubpath = "auth.json", authFile, accessTokenEnv, docker = "docker" } = options;
  if ([authVolume, authFile, accessTokenEnv].filter((x) => x !== undefined).length !== 1) {
    throw new TypeError("authVolume・authFile・accessTokenEnv のどれか1つを渡してください");
  }
  if (accessTokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(accessTokenEnv)) {
    throw new TypeError(`環境変数の名前ではありません: ${accessTokenEnv}`);
  }
  const auth =
    accessTokenEnv !== undefined
      ? ["-e", accessTokenEnv]
      : authVolume !== undefined
        ? ["--mount", `type=volume,src=${authVolume},dst=${CONTAINER_AUTH},volume-subpath=${authSubpath}`]
        : ["--mount", `type=bind,src=${authFile},dst=${CONTAINER_AUTH}`];
  const command = [
    docker, "run", "-i", "--rm",
    "--mount", `type=bind,src=${workspace},dst=${CONTAINER_WORKSPACE}`,
    ...auth,
    image,
  ];
  const overrides = [...(accessTokenEnv !== undefined ? chatgptPlanOverrides(accessTokenEnv) : []), ...(options.configOverrides ?? [])];
  for (const override of overrides) command.push("-c", override);
  return command;
}

/** initialize で名乗るアプリ。Sign in with ChatGPT では name を登録のときの agent_name_hint と同じにする */
export interface ClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface WorkspaceSessionOptions {
  model?: string;
  effort?: string;
  /**
   * app-server (docker) のプロセスに足す環境変数 (Sign in with ChatGPT の access token など)。
   * 今のプロセスの環境に重ねて渡す。値はログや例外に出さない。
   */
  env?: Record<string, string>;
  /** initialize で名乗るアプリ (既定は codex_workspace) */
  clientInfo?: ClientInfo;
  /** 1回の頼みごとの上限 (ミリ秒)。既定 30分 */
  turnTimeoutMs?: number;
  /** JSON-RPC の要求1つの上限 (ミリ秒)。既定 2分 */
  requestTimeoutMs?: number;
  onEvent?: (event: WorkspaceEvent) => void;
}

export interface RunTurnOptions {
  /** 中止すると turn/interrupt を送り、status が "interrupted" の結果を返す */
  signal?: AbortSignal;
}

type Message = Record<string, unknown> & { id?: number | string; method?: string; params?: unknown };

export class WorkspaceSession {
  threadId: string | null = null;
  model: string | null = null;

  private readonly command: string[];
  private options: WorkspaceSessionOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue = new MessageQueue();
  private nextId = 0;
  /** スレッドで使ったトークンの累計。 */
  private total: Record<string, unknown> = {};

  constructor(command: string[], options: WorkspaceSessionOptions = {}) {
    this.command = command;
    this.options = options;
  }

  /** 起動して initialize まで済ませたセッション。`await using` で閉じられる。 */
  static async open(command: string[], options: WorkspaceSessionOptions = {}): Promise<WorkspaceSession> {
    const session = new WorkspaceSession(command, options);
    await session.start();
    return session;
  }

  async start(): Promise<void> {
    const [file, ...args] = this.command;
    const env = this.options.env ? { ...process.env, ...this.options.env } : process.env;
    this.queue = new MessageQueue();
    const proc = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], env }) as unknown as ChildProcessWithoutNullStreams;
    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", (error) => reject(new WorkspaceError(`起動できません: ${file}`, { cause: error })));
    });
    this.proc = proc;
    // 相手が先に終わったときの書き込みエラーは、読み取り側の「終わりました」で知らせる
    proc.stdin.on("error", () => {});
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => this.queue.push(line));
    lines.on("close", () => this.queue.end());
    await this.request("initialize", { clientInfo: this.options.clientInfo ?? { name: CLIENT_NAME, version: CLIENT_VERSION } });
    this.notify("initialized");
  }

  /**
   * 起動し直す (Sign in with ChatGPT の access token を更新したとき)。env を渡すと置き換える。
   * スレッドを続けるには、このあと resumeThread を呼ぶ (記録を残さないスレッドや、消えたコンテナのスレッドは続けられない)。
   */
  async restart(options: { env?: Record<string, string> } = {}): Promise<void> {
    await this.close();
    if (options.env) this.options = { ...this.options, env: options.env };
    await this.start();
  }

  /** 保存してあるスレッドを続ける (thread/resume)。 */
  async resumeThread(threadId: string): Promise<string> {
    const result = await this.request("thread/resume", { threadId });
    const thread = isRecord(result.thread) ? result.thread : {};
    this.threadId = typeof thread.id === "string" ? thread.id : threadId;
    this.total = {};
    if (typeof result.model === "string") this.model = result.model;
    return this.threadId;
  }

  async startThread(developerInstructions?: string): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: CONTAINER_WORKSPACE,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      ephemeral: true,
    };
    if (this.options.model) params.model = this.options.model;
    if (developerInstructions) params.developerInstructions = developerInstructions;
    const result = await this.request("thread/start", params);
    const thread = result.thread as { id: string };
    this.threadId = thread.id;
    // トークンの累計はスレッドごとに数え直される。前のスレッドの累計と差を取らない。
    this.total = {};
    this.model = typeof result.model === "string" ? result.model : null;
    return this.threadId;
  }

  /** 1回頼んで、終わるまで待つ。 */
  async runTurn(text: string, options: RunTurnOptions = {}): Promise<TurnResult> {
    if (this.threadId === null) await this.startThread();
    const started = performance.now();
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
    };
    if (this.options.effort) params.effort = this.options.effort;
    const requestId = this.send("turn/start", params);
    const result: TurnResult = { status: "unknown", message: null, changed: [], commands: [], usage: null, seconds: 0 };
    const before = { ...this.total };
    const timeout = this.options.turnTimeoutMs ?? 1_800_000;
    const deadline = started + timeout;

    let turnId: string | null = null;
    let interruptRequested = false;
    const interrupt = () => {
      interruptRequested = true;
      if (turnId) this.send("turn/interrupt", { threadId: this.threadId, turnId });
    };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    if (options.signal?.aborted) interruptRequested = true;

    try {
      for (;;) {
        const message = await this.queue.next(deadline);
        if (message === undefined) {
          throw new WorkspaceError(`1回の頼みごとが ${Math.round(timeout / 1000)} 秒を超えました`);
        }
        if (this.answerServerRequest(message)) continue;
        if (message.id === requestId) {
          if ("error" in message) throw new WorkspaceError(`turn/start が失敗しました: ${json(message.error)}`);
          const turn = (message.result as { turn?: { id?: string } } | undefined)?.turn;
          turnId = turn?.id ?? null;
          if (interruptRequested) interrupt();
          continue;
        }
        const p = isRecord(message.params) ? message.params : {};
        switch (message.method) {
          case "item/completed":
            this.collect(result, isRecord(p.item) ? p.item : {});
            break;
          case "thread/tokenUsage/updated": {
            const usage = isRecord(p.tokenUsage) ? p.tokenUsage : {};
            const total = isRecord(usage.total) ? usage.total : {};
            result.usage = difference(total, before);
            this.total = total;
            break;
          }
          case "error":
            this.options.onEvent?.({ type: "error", error: p });
            break;
          case "turn/completed": {
            const turn = isRecord(p.turn) ? p.turn : {};
            result.status = typeof turn.status === "string" ? turn.status : "completed";
            if (result.status === "failed") {
              if (isUsageLimit(turn.error)) throw new UsageLimitError(`使用量の上限に当たりました: ${json(turn.error)}`);
              throw new WorkspaceError(`ターンが失敗しました: ${json(turn.error)}`);
            }
            result.seconds = Math.round((performance.now() - started) / 100) / 10;
            return result;
          }
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", interrupt);
    }
  }

  /** アカウントの今の使用量。頼む前に見て、上限に近ければ頼まないために使う。 */
  async usage(): Promise<Usage> {
    return parseUsage(await this.request("account/rateLimits/read"));
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    await exited;
    clearTimeout(timer);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private collect(result: TurnResult, item: Record<string, unknown>) {
    const kind = typeof item.type === "string" ? item.type : "unknown";
    if (kind === "agentMessage") {
      result.message = typeof item.text === "string" ? item.text : null;
    } else if (kind === "fileChange") {
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        const path = relative(isRecord(change) && typeof change.path === "string" ? change.path : "");
        if (!result.changed.includes(path)) result.changed.push(path);
      }
    } else if (kind === "commandExecution") {
      result.commands.push({
        command: String(item.command ?? ""),
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      });
    }
    this.options.onEvent?.({ type: kind, item });
  }

  // JSON-RPC -------------------------------------------------------------

  /** 承認は求めさせない設定なので、要求が来たら断る。 */
  private answerServerRequest(message: Message): boolean {
    if (message.method === undefined || message.id === undefined) return false;
    this.write({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
    return true;
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = this.send(method, params);
    const deadline = performance.now() + (this.options.requestTimeoutMs ?? 120_000);
    for (;;) {
      const message = await this.queue.next(deadline);
      if (message === undefined) throw new WorkspaceError(`${method} の応答がありません`);
      if (this.answerServerRequest(message)) continue;
      if (message.id === requestId) {
        if ("error" in message) throw new WorkspaceError(`${method} が失敗しました: ${json(message.error)}`);
        return isRecord(message.result) ? message.result : {};
      }
    }
  }

  private send(method: string, params?: Record<string, unknown>): number {
    this.nextId += 1;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id: this.nextId, method };
    if (params !== undefined) payload.params = params;
    this.write(payload);
    return this.nextId;
  }

  private notify(method: string, params?: Record<string, unknown>) {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.write(payload);
  }

  private write(payload: Record<string, unknown>) {
    if (!this.proc || this.proc.stdin.destroyed) throw new WorkspaceError("app-server が動いていません");
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}

/** 標準出力の行を、読む側が待てる形でためる。JSON でない行は捨てる。 */
class MessageQueue {
  private items: Message[] = [];
  private ended = false;
  private waiter: (() => void) | null = null;

  push(line: string) {
    try {
      const message = JSON.parse(line);
      if (isRecord(message)) this.items.push(message as Message);
    } catch {
      return;
    }
    this.wake();
  }

  end() {
    this.ended = true;
    this.wake();
  }

  /** 次のメッセージ。deadline (performance.now() 基準) を過ぎたら undefined。 */
  async next(deadline: number): Promise<Message | undefined> {
    for (;;) {
      const item = this.items.shift();
      if (item) return item;
      if (this.ended) throw new WorkspaceError("app-server が終わりました");
      const remaining = deadline - performance.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = null;
    }
  }

  private wake() {
    this.waiter?.();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function difference(after: Record<string, unknown>, before: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      typeof value === "number" && Number.isInteger(value) ? value - (Number(before[key]) || 0) : value,
    ]),
  );
}

function relative(path: string): string {
  const prefix = `${CONTAINER_WORKSPACE.replace(/\/$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
