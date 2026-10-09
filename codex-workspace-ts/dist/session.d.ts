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
export declare const DEFAULT_IMAGE = "llmcs-codex-workspace:local";
export declare const CONTAINER_WORKSPACE = "/workspace";
export declare const CONTAINER_AUTH = "/codex/auth.json";
/** Sign in with ChatGPT の access token を app-server に渡す環境変数の既定の名前 */
export declare const ACCESS_TOKEN_ENV = "ACCESS_TOKEN";
/**
 * Sign in with ChatGPT のプラン利用で app-server を動かす設定 (公式の Codex app-server の手順のとおり)。
 * Codex は環境変数 envKey の値を `Authorization: Bearer` で /v1/responses に送る。Codex 自身のサインインは要らない。
 */
export declare function chatgptPlanOverrides(envKey?: string): string[];
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
export declare function dockerCommand(workspace: string, options?: DockerCommandOptions): string[];
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
export declare class WorkspaceSession {
    threadId: string | null;
    model: string | null;
    private readonly command;
    private options;
    private proc;
    private queue;
    private nextId;
    /** スレッドで使ったトークンの累計。 */
    private total;
    constructor(command: string[], options?: WorkspaceSessionOptions);
    /** 起動して initialize まで済ませたセッション。`await using` で閉じられる。 */
    static open(command: string[], options?: WorkspaceSessionOptions): Promise<WorkspaceSession>;
    start(): Promise<void>;
    /**
     * 起動し直す (Sign in with ChatGPT の access token を更新したとき)。env を渡すと置き換える。
     * スレッドを続けるには、このあと resumeThread を呼ぶ (記録を残さないスレッドや、消えたコンテナのスレッドは続けられない)。
     */
    restart(options?: {
        env?: Record<string, string>;
    }): Promise<void>;
    /** 保存してあるスレッドを続ける (thread/resume)。 */
    resumeThread(threadId: string): Promise<string>;
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
