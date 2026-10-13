/**
 * ChatGPT プランでの Responses API（https://api.openai.com/v1/responses）。
 * 公式: developers.openai.com/siwc/token-sharing-open-source/models-and-inference と preview-limitations
 *
 * 公式の決まりをこの層で守る:
 * - store: false / stream: true を必ず送る（変えられない）。イベントの流れを最後まで読み、response.completed だけを成功とする
 * - system ロールは拒否されるので型に入れない（指示は instructions か developer ロール）
 * - temperature・max_output_tokens・previous_response_id・metadata など、送ると拒否される項目は型に入れない
 *   （会話を続けるときは、履歴を input に入れて送り直す）
 * - 画像生成・ファイル検索・Code Interpreter などのツールは使えない。ツールはこの層では扱わない
 */

export const API_BASE = "https://api.openai.com/v1";

export type InputPart =
  | { type: "input_text"; text: string }
  /** data URL か https の URL。選んだモデルが画像を受け付けるときだけ */
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
  | { type: "output_text"; text: string };

export interface InputMessage {
  role: "user" | "assistant" | "developer";
  content: string | InputPart[];
}

export interface JsonSchemaFormat {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  /** true なら、すべてのプロパティを required にし additionalProperties: false にする必要がある */
  strict?: boolean;
}

export interface ResponseRequest {
  /** /models で visibility が list のものの slug */
  model: string;
  /** system に当たる指示 */
  instructions?: string;
  input: InputMessage[];
  text?: { format?: { type: "text" } | JsonSchemaFormat; verbosity?: "low" | "medium" | "high" };
  reasoning?: { effort?: "minimal" | "low" | "medium" | "high" };
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface ResponseResult {
  id?: string;
  model?: string;
  /** 出力のテキスト（output_text をつなげたもの） */
  text: string;
  usage?: Usage;
}

export interface ResponsesOptions {
  /** access token か、呼ぶたびに（必要なら更新して）返す関数。ChatGptAccount の accessToken() を渡せる */
  accessToken: string | (() => Promise<string>);
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** テキストの差分（表示を逐次更新するとき） */
  onDelta?: (delta: string) => void;
  /** すべてのイベント（デバッグや進み具合の表示） */
  onEvent?: (event: ResponseStreamEvent) => void;
}

export interface ResponseStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** API の失敗。code は API のエラーコードか、この実装の分類（network / unauthorized / stream_interrupted など） */
export class ResponsesError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "ResponsesError";
    this.code = code;
    this.status = status;
  }
}

/** プランの使用量の上限（subscription_sharing_usage_limit_exceeded など）。時間をおくか、ChatGPT の設定で確認してもらう */
export class UsageLimitError extends ResponsesError {
  constructor(message: string, code: string, status?: number) {
    super(message, code, status);
    this.name = "UsageLimitError";
  }
}

/** response.incomplete（出力が途中で打ち切られた）。reason は incomplete_details.reason */
export class IncompleteResponseError extends ResponsesError {
  readonly reason: string;
  readonly partialText: string;
  constructor(reason: string, partialText: string) {
    super(`応答が途中で終わりました（${reason}）`, "incomplete");
    this.name = "IncompleteResponseError";
    this.reason = reason;
    this.partialText = partialText;
  }
}

const USAGE_LIMIT_CODES = new Set(["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable", "usage_limit_reached"]);

function errorOf(code: string, message: string, status?: number): ResponsesError {
  if (USAGE_LIMIT_CODES.has(code)) return new UsageLimitError(message || "ChatGPT プランの使用量の上限に達しました", code, status);
  return new ResponsesError(message || code, code, status);
}

async function token(o: ResponsesOptions): Promise<string> {
  return typeof o.accessToken === "string" ? o.accessToken : o.accessToken();
}

async function call(o: ResponsesOptions, path: string, init: RequestInit): Promise<Response> {
  const f = o.fetch ?? globalThis.fetch;
  // トークンの取得の失敗（未接続・更新できない）は、そのまま呼ぶ側へ返す（接続の失敗に変えない）
  const bearer = await token(o);
  let res: Response;
  try {
    res = await f(`${o.baseUrl ?? API_BASE}${path}`, {
      ...init,
      signal: o.signal,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${bearer}` },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ResponsesError(`${path} に接続できません: ${(e as Error).message}`, "network");
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let code = res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : res.status >= 500 ? "server_error" : `http_${res.status}`;
  let message = `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string; type?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // JSON でない応答
  }
  throw errorOf(code, message, res.status);
}

/** Server-Sent Events を 1 件ずつ読む。data が JSON のものだけを返す */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ResponseStreamEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  const flush = function* (block: string): Generator<ResponseStreamEvent> {
    let eventName: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    const raw = data.join("\n");
    if (raw === "[DONE]") return;
    try {
      const ev = JSON.parse(raw) as ResponseStreamEvent;
      yield { ...ev, type: ev.type ?? eventName ?? "message" };
    } catch {
      // 壊れたイベントは飛ばす（最後に completed が無ければ失敗になる）
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        yield* flush(block);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield* flush(buf);
  } finally {
    reader.releaseLock();
  }
}

function outputText(response: Record<string, unknown> | undefined): string | undefined {
  const output = response?.output;
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output as { type?: string; content?: { type?: string; text?: string }[] }[]) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.length ? parts.join("") : undefined;
}

/**
 * 1 回の推論。イベントの流れを最後まで読み、response.completed で結果を返す。
 * response.failed・error・response.incomplete・途中で切れた流れは例外にする。
 */
export async function createResponse(req: ResponseRequest, o: ResponsesOptions): Promise<ResponseResult> {
  const res = await call(o, "/responses", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ ...req, store: false, stream: true }),
  });
  if (!res.body) throw new ResponsesError("応答の本文がありません", "bad_response", res.status);

  let text = "";
  for await (const ev of readEvents(res.body)) {
    o.onEvent?.(ev);
    switch (ev.type) {
      case "response.output_text.delta":
        if (typeof ev.delta === "string") {
          text += ev.delta;
          o.onDelta?.(ev.delta);
        }
        break;
      case "response.completed": {
        const r = (ev.response ?? {}) as Record<string, unknown>;
        return {
          id: typeof r.id === "string" ? r.id : undefined,
          model: typeof r.model === "string" ? r.model : undefined,
          text: outputText(r) ?? text,
          usage: r.usage as Usage | undefined,
        };
      }
      case "response.failed": {
        const err = ((ev.response as Record<string, unknown> | undefined)?.error ?? {}) as { code?: string; message?: string };
        throw errorOf(err.code ?? "response_failed", err.message ?? "応答の生成に失敗しました");
      }
      case "response.incomplete": {
        const details = ((ev.response as Record<string, unknown> | undefined)?.incomplete_details ?? {}) as { reason?: string };
        throw new IncompleteResponseError(details.reason ?? "unknown", text);
      }
      case "error": {
        const err = (ev.error ?? ev) as { code?: string; message?: string };
        throw errorOf(err.code ?? "stream_error", err.message ?? "応答の途中でエラーになりました");
      }
    }
  }
  throw new ResponsesError("応答が完了する前に接続が切れました", "stream_interrupted");
}

/** JSON Schema で形を決めた応答を、パースして返す（検証は呼ぶ側で行う） */
export async function createJsonResponse<T = unknown>(
  req: ResponseRequest & { text: { format: JsonSchemaFormat } },
  o: ResponsesOptions,
): Promise<{ value: T; result: ResponseResult }> {
  const result = await createResponse(req, o);
  try {
    return { value: JSON.parse(result.text) as T, result };
  } catch {
    throw new ResponsesError("応答が JSON として読めません", "bad_json");
  }
}

export interface ModelInfo {
  slug: string;
  displayName: string;
}

/**
 * このアカウントで使えるモデル（visibility が list のもの。サーバの並び順のまま）。
 * アカウントを切り替えたら取り直す。
 */
export async function listModels(o: Omit<ResponsesOptions, "onDelta" | "onEvent">): Promise<ModelInfo[]> {
  const res = await call(o, "/models", { method: "GET", headers: { accept: "application/json" } });
  const body = (await res.json()) as { models?: { slug?: string; display_name?: string; visibility?: string }[] };
  return (body.models ?? [])
    .filter((m) => m.visibility === "list" && typeof m.slug === "string")
    .map((m) => ({ slug: m.slug!, displayName: m.display_name ?? m.slug! }));
}
