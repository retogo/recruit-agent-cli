import {
  type HttpMethod,
  MaintenanceError,
  ProcedureError,
  SessionExpiredError,
} from "../../../ports/driven/recruit-agent.ts";
import { mergeSetCookies, type Session } from "../session/session.ts";

export const BASE_URL = "https://mypage.r-agent.com";

/** リダイレクトの行き先で、メンテナンス中かログイン切れかを分ける */
function redirectError(res: Response): Error {
  const location = res.headers.get("location") ?? "?";
  if (/maintenance/i.test(location)) return new MaintenanceError();
  return new SessionExpiredError(`${res.status} → ${location}`);
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TrpcCall {
  procedure: string;
  input: unknown;
}

/**
 * Next.js + tRPC の httpBatchLink 相当のクライアント。
 * `/api/trpc/<p1>,<p2>?batch=1` に、POST はボディ、GET は `input` クエリで `{"0": ..., "1": ...}` を送る。
 */
export class TrpcClient {
  constructor(
    private session: Session,
    private readonly fetchFn: FetchFn = fetch,
    readonly baseUrl: string = BASE_URL,
    /** サーバーが Cookie を更新したときに呼ぶ（保存はここで行う） */
    private readonly onSessionRefresh?: (session: Session) => Promise<void>,
  ) {}

  async call(procedure: string, input: unknown, method: HttpMethod): Promise<unknown> {
    const [result] = await this.batch([{ procedure, input }], method);
    return result;
  }

  async batch(calls: TrpcCall[], method: HttpMethod): Promise<unknown[]> {
    const path = calls.map((c) => c.procedure).join(",");
    const url = new URL(`/api/trpc/${path}`, this.baseUrl);
    url.searchParams.set("batch", "1");

    const payload = Object.fromEntries(calls.map((c, i) => [String(i), this.encode(c.input)]));
    const headers: Record<string, string> = {
      accept: "*/*",
      ...this.session.headers,
      cookie: this.session.cookie,
    };
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (method === "GET") {
      url.searchParams.set("input", JSON.stringify(payload));
    } else {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(payload);
    }

    const res = await this.fetchFn(url, init);
    await this.absorbCookies(res);
    if (res.status >= 300 && res.status < 400) throw redirectError(res);
    if (res.status === 401 || res.status === 403) throw new SessionExpiredError(`HTTP ${res.status}`);

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      if (/<html/i.test(text)) throw new SessionExpiredError("JSON ではなく HTML が返った");
      throw new ProcedureError(path, `HTTP ${res.status}: JSON ではない応答`, text.slice(0, 500));
    }
    const items = Array.isArray(body) ? body : [body];
    return calls.map((c, i) => this.decode(c.procedure, items[i]));
  }

  /** サーバー描画のページを取る。ログイン切れはリダイレクトで表れる */
  async fetchPage(url: URL): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.session.headers,
      accept: "text/html",
      cookie: this.session.cookie,
    };
    delete headers["content-type"];
    const res = await this.fetchFn(url, { headers, redirect: "manual" });
    await this.absorbCookies(res);
    if (res.status >= 300 && res.status < 400) throw redirectError(res);
    if (!res.ok) throw new ProcedureError(url.pathname, `HTTP ${res.status}`);
    return res;
  }

  private async absorbCookies(res: Response): Promise<void> {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;
    const cookie = mergeSetCookies(this.session.cookie, setCookies);
    if (cookie === this.session.cookie) return;
    this.session = { ...this.session, cookie, refreshedAt: new Date().toISOString() };
    await this.onSessionRefresh?.(this.session);
  }

  private encode(input: unknown): unknown {
    if (this.session.transformer === "none") return input;
    if (input === undefined) return { json: null, meta: { values: ["undefined"], v: 1 } };
    return { json: input };
  }

  private decode(procedure: string, item: unknown): unknown {
    if (!item || typeof item !== "object") {
      throw new ProcedureError(procedure, "応答がありません", item);
    }
    const obj = item as { result?: { data?: unknown }; error?: unknown };
    if (obj.error !== undefined) {
      const err = unwrapJson(obj.error) as { message?: string; data?: { httpStatus?: number; code?: string } };
      if (err?.data?.httpStatus === 401 || err?.data?.code === "UNAUTHORIZED") {
        throw new SessionExpiredError(err.message ?? "UNAUTHORIZED");
      }
      throw new ProcedureError(procedure, err?.message ?? "エラー応答", err);
    }
    return unwrapJson(obj.result?.data);
  }
}

function unwrapJson(value: unknown): unknown {
  if (value && typeof value === "object" && "json" in value) return (value as { json: unknown }).json;
  return value;
}
