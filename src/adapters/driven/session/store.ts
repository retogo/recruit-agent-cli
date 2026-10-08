import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export { mergeSetCookies, type Session, type Transformer } from "./session.ts";
import type { Session } from "./session.ts";

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
