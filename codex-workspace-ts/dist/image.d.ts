/** パッケージに同梱した Dockerfile のあるフォルダ (Python 版と同じ内容) */
export declare const DOCKER_CONTEXT: string;
export interface EnsureImageOptions {
    image?: string;
    /** これより古ければ作り直す (ミリ秒)。既定 1日 */
    maxAgeMs?: number;
    docker?: string;
    now?: Date;
}
/**
 * イメージが無いか、maxAgeMs より古ければ作り直す。返すのは中の Codex の版。
 *
 * Codex の版は固定しない。作り直すたびにその時点の最新を入れる。毎回作り直すと
 * 取得に時間がかかるので、作ってからの日数で決める。
 */
export declare function ensureImage(options?: EnsureImageOptions): Promise<string>;
/** Docker の作成日時 (2026-10-03T08:26:51.123456789Z)。ナノ秒は Date が読める桁 (ミリ秒) に切る。 */
export declare function parseCreated(value: string): Date | null;
