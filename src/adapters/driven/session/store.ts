import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 求人ポストの tRPC は transformer なし（none）。superjson は他サイト流用時のために残す */
export type Transformer = "superjson" | "none";

export interface Session {
  cookie: string;
  /** DevTools の cURL から取り込んだ追加ヘッダー（CSRF など） */
  headers: Record<string, string>;
  transformer: Transformer;
  importedAt: string;
  /** サーバーの Set-Cookie で Cookie を更新した最後の日時 */
  refreshedAt?: string;
}

/**
 * Set-Cookie の値で Cookie ヘッダーの文字列を更新する。
 * 求人ポストはリクエストのたびに PDT2-WEB-SESSION を新しい値（有効期限 24 時間）で返すので、
 * これを保存しておけば、1 日 1 回以上使う限りセッションが続く。
 */
export function mergeSetCookies(cookie: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const sc of setCookies) {
    const [pair = "", ...attrs] = sc.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
    if (expired) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 設定・セッションの置き場所。RA_HOME > XDG_CONFIG_HOME > ~/.config */
export function configDir(): string {
  if (process.env.RA_HOME) return process.env.RA_HOME;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "recruit-agent-cli");
}

const sessionPath = () => join(configDir(), "session.json");

export async function writePrivate(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
  await chmod(path, 0o600);
}

export async function loadSession(): Promise<Session | null> {
  const fromEnv = process.env.RA_COOKIE;
  const file = Bun.file(sessionPath());
  const stored: Session | null = (await file.exists()) ? await file.json() : null;
  if (fromEnv) {
    return {
      cookie: fromEnv,
      headers: stored?.headers ?? {},
      transformer: stored?.transformer ?? "none",
      importedAt: "env:RA_COOKIE",
    };
  }
  return stored;
}

export async function saveSession(session: Session): Promise<string> {
  const path = sessionPath();
  await writePrivate(path, session);
  return path;
}
