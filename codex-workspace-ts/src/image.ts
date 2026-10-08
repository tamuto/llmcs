import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_IMAGE } from "./session.ts";

const run = promisify(execFile);

/** パッケージに同梱した Dockerfile のあるフォルダ (Python 版と同じ内容) */
export const DOCKER_CONTEXT = fileURLToPath(new URL("../docker/", import.meta.url));

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
export async function ensureImage(options: EnsureImageOptions = {}): Promise<string> {
  const { image = DEFAULT_IMAGE, maxAgeMs = 86_400_000, docker = "docker" } = options;
  const moment = options.now ?? new Date();
  const created = await imageCreated(image, docker);
  if (created === null || moment.getTime() - created.getTime() > maxAgeMs) {
    const refresh = moment.toISOString().replace(/\.\d{3}Z$/, "+00:00");
    await run(docker, ["build", "-q", "-t", image, "--build-arg", `CODEX_REFRESH=${refresh}`, DOCKER_CONTEXT], {
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  const { stdout } = await run(docker, ["run", "--rm", "--entrypoint", "codex", image, "--version"]);
  return stdout.trim();
}

async function imageCreated(image: string, docker: string): Promise<Date | null> {
  try {
    const { stdout } = await run(docker, ["image", "inspect", "--format", "{{.Created}}", image]);
    return parseCreated(stdout.trim());
  } catch {
    return null;
  }
}

/** Docker の作成日時 (2026-10-03T08:26:51.123456789Z)。ナノ秒は Date が読める桁 (ミリ秒) に切る。 */
export function parseCreated(value: string): Date | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  const [, head, fraction = "", zone = "Z"] = match;
  const millis = fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : "";
  const date = new Date(`${head}${millis}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}
