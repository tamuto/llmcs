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
 * 作業場所のパスは、Docker のデーモンから見た場所 (ホストの場所) で渡す。開発環境の
 * コンテナの中から動かすときは、そのコンテナの中の場所とは違うことがある。
 */
export declare const DEFAULT_IMAGE = "llmcs-codex-workspace:local";
export declare const CONTAINER_WORKSPACE = "/workspace";
export declare const CONTAINER_AUTH = "/codex/auth.json";
export declare class WorkspaceError extends Error {
    name: string;
}
/**
 * Codex の使用量の上限 (5時間や週の窓) に当たって、ターンが失敗した。
 *
 * 待てば戻るが、すぐに頼み直しても同じように失敗する。呼び出し側は、続けて頼むのをやめる。
 */
export declare class UsageLimitError extends WorkspaceError {
    name: string;
}
/**
 * アカウントの使用量 (account/rateLimits/read)。
 *
 * windows は、窓の長さ (分) から、使った割合 (%) への対応。ChatGPT のプランでは、
 * 5時間 (300分) と週 (10080分) の2つ。allowed は、ふつうに使ってよいかの、
 * サーバー側の判断 (分からなければ null)。reached は、上限に当たっていればその種類。
 */
export declare class Usage {
    readonly windows: Record<number, number>;
    readonly allowed: boolean | null;
    readonly reached: string | null;
    constructor(windows: Record<number, number>, allowed: boolean | null, reached: string | null);
    used(minutes: number): number | null;
}
export declare function parseUsage(result: Record<string, unknown>): Usage;
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
export type WorkspaceEvent = {
    type: string;
    item: Record<string, unknown>;
} | {
    type: "error";
    error: unknown;
};
export interface DockerCommandOptions {
    image?: string;
    /** 認証情報 (auth.json) を入れた Docker ボリューム */
    authVolume?: string;
    authSubpath?: string;
    /** 認証情報のホストのファイル */
    authFile?: string;
    docker?: string;
    configOverrides?: string[];
}
/**
 * app-server を起こす docker run。認証情報はボリュームの中のファイルか、ホストのファイルで渡す。
 *
 * 認証情報は読み書きできるようにマウントする。Codex がトークンを更新したときに書き戻すため。
 */
export declare function dockerCommand(workspace: string, options?: DockerCommandOptions): string[];
export interface WorkspaceSessionOptions {
    model?: string;
    effort?: string;
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
export declare class WorkspaceSession {
    threadId: string | null;
    model: string | null;
    private readonly command;
    private readonly options;
    private proc;
    private queue;
    private nextId;
    /** スレッドで使ったトークンの累計。 */
    private total;
    constructor(command: string[], options?: WorkspaceSessionOptions);
    /** 起動して initialize まで済ませたセッション。`await using` で閉じられる。 */
    static open(command: string[], options?: WorkspaceSessionOptions): Promise<WorkspaceSession>;
    start(): Promise<void>;
    startThread(developerInstructions?: string): Promise<string>;
    /** 1回頼んで、終わるまで待つ。 */
    runTurn(text: string, options?: RunTurnOptions): Promise<TurnResult>;
    /** アカウントの今の使用量。頼む前に見て、上限に近ければ頼まないために使う。 */
    usage(): Promise<Usage>;
    close(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
    private collect;
    /** 承認は求めさせない設定なので、要求が来たら断る。 */
    private answerServerRequest;
    private request;
    private send;
    private notify;
    private write;
}
