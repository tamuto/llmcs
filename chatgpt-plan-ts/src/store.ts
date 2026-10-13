import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenSet } from "./oauth.ts";

/**
 * ChatGPT との接続（このマシン・この人だけ。共有しない）。1 ファイルに保存する:
 *
 *   <file>          0600。秘密（トークン）を含む
 *   <file>.lock     トークンの更新の排他（.json は .lock に置き換える）
 *
 * 置き場所は使う側が決める（例: ~/.config/<アプリ>/chatgpt.json）。アプリの他の設定とは別のファイルにする。
 */
export interface Connection {
  /** このマシンの登録に使う ID（ext_agent_host_id）。一度作ったらずっと使う */
  hostId: string;
  /** 発行された client ID（oaiapp_…）。初回のサインインで決まる */
  clientId?: string;
  /** 検証した ID トークンのアカウント */
  account?: { sub: string; email?: string };
  /** 解除すると消える（登録とアカウントは残す） */
  tokens?: TokenSet & { savedAt: string };
}

const lockPath = (file: string) => (file.endsWith(".json") ? file.replace(/\.json$/, ".lock") : `${file}.lock`);

export async function loadConnection(file: string): Promise<Connection | undefined> {
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text.trim()) return undefined;
  try {
    const c = JSON.parse(text) as Connection;
    return typeof c.hostId === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

/** 無ければホスト ID だけの接続を作る（まだ保存しない） */
export async function loadOrNew(file: string): Promise<Connection> {
  return (await loadConnection(file)) ?? { hostId: `urn:uuid:${randomUUID()}` };
}

/** 一時ファイルも含めて所有者だけが読み書きできるように書き、rename で置き換える */
export async function saveConnection(c: Connection, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(c, null, 2)}\n`, "utf8");
  } finally {
    await fh.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** 更新日時（別のプロセスでの接続の変化に気付くため） */
export async function connectionMtime(file: string): Promise<number> {
  return (await stat(file).catch(() => undefined))?.mtimeMs ?? 0;
}

/**
 * 同じマシンの複数のプロセスで、トークンの更新を1つずつ行う（refresh token は使うと入れ替わるため）。
 * lock を取れなければ少し待つ。古い lock（staleMs より前）は落ちたプロセスのものとして取り直す。
 */
export async function withLock<T>(
  file: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 30_000, staleMs = 60_000 } = opts;
  const lock = lockPath(file);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await open(lock, "wx", 0o600);
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = await stat(lock).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > staleMs) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() > until) throw new Error("ChatGPT の接続の更新を待ちきれませんでした（別のプロセスが更新中です）", { cause: e });
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}
