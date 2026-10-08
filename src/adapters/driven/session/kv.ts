import type { Session } from "./session.ts";

/** Workers KV のうち、ここで使う部分（テストでは Map で代用する） */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const SESSION_KEY = "session";

/** Worker 用のセッション置き場。session.json の代わりに KV に1件だけ持つ */
export class KvSessionStore {
  constructor(private readonly kv: KeyValue) {}

  async load(): Promise<Session | null> {
    const text = await this.kv.get(SESSION_KEY);
    return text ? (JSON.parse(text) as Session) : null;
  }

  async save(session: Session): Promise<void> {
    await this.kv.put(SESSION_KEY, JSON.stringify(session));
  }
}
