import { join } from "node:path";
import type { HttpMethod } from "../../../ports/driven/recruit-agent.ts";
import { configDir } from "../session/store.ts";

export type Action =
  | "recommend"
  | "hide"
  | "unhide"
  | "interest"
  | "uninterest"
  | "apply"
  | "similar"
  | "search"
  | "searchCount"
  | "myJobs"
  | "applied"
  | "interview";

/**
 * - confirmed: 入力の必須項目を zod の検証エラーで確認し、実際に呼んで応答を見た
 * - schema: 入力の必須項目は zod の検証エラーで確認したが、成功する呼び出しはまだ試していない
 * - guessed: 入力の形が推測
 * - override: procedures.json で上書きした
 */
export type ProcedureStatus = "confirmed" | "schema" | "guessed" | "override";

export interface ProcedureDef {
  procedure: string;
  method: HttpMethod;
  /**
   * 入力テンプレート。文字列中の `{{name}}` を差し込む。文字列全体が `{{name}}` のときは修飾子が使える。
   * - `{{name}}`: 値がなければそのキーごと落とす
   * - `{{name:number}}`: 数値にする
   * - `{{name:nullable}}`: 値がなければ null
   * - `{{name:json}}`: 値を JSON として解釈して埋め込む
   */
  input?: unknown;
  status: ProcedureStatus;
  note?: string;
}

/**
 * 興味なし・気になるの紹介経路と推薦時刻。値は求人の sourceType / i2a_tstamp から referral.ts で決める。
 * sendI2ATstamp は i2a_tstamp のない求人（スカウトなど）では送らない。
 */
const REFERRAL = { jobReferralType: "{{referralType}}", sendI2ATstamp: "{{i2aTstamp}}" };

export const DEFAULT_PROCEDURES: Record<Action, ProcedureDef> = {
  recommend: {
    procedure: "pages.recommend.getRecommendJobs",
    method: "POST",
    input: { request_id: "{{requestId}}", page_token: "{{pageToken:nullable}}" },
    status: "confirmed",
    note: "1ページ25件。応答の nextPageToken を次の page_token に渡す",
  },
  hide: {
    procedure: "features.activities.notApplications",
    method: "POST",
    input: { jobofferManagementNo: "{{jobId}}", ...REFERRAL },
    status: "confirmed",
    note: "ブラウザの実リクエストとフロントエンドのコードで確認。jobReferralType が違うと裏の API が 500",
  },
  unhide: {
    procedure: "features.activities.notApplicationsCancel",
    method: "POST",
    input: { jobofferManagementNo: "{{jobId}}" },
    status: "confirmed",
    note: "実行して興味なし一覧から外れるのを確認。おすすめ一覧には戻らない",
  },
  interest: {
    procedure: "features.interests.switchInterest",
    method: "POST",
    input: { jobofferManagementNo: "{{jobId}}", isRegistration: true, ...REFERRAL },
    status: "confirmed",
    note: "実行して気になる一覧に入るのを確認",
  },
  uninterest: {
    procedure: "features.interests.switchInterest",
    method: "POST",
    input: { jobofferManagementNo: "{{jobId}}", isRegistration: false, ...REFERRAL },
    status: "confirmed",
    note: "実行して気になる一覧から外れるのを確認",
  },
  apply: {
    procedure: "pages.joboffers.jobOfferApply",
    method: "POST",
    input: { jobofferManagementNo: "{{jobId}}", ...REFERRAL },
    status: "confirmed",
    note: "実データで確認（応答は空文字、選考状況の書類選考中に入る、気になる一覧から外れる）",
  },
  similar: {
    procedure: "pages.joboffers.getSimilarJobs",
    method: "POST",
    input: { job_ids: ["{{jobId:number}}"] },
    status: "schema",
    note: "job_ids は数値の配列。応答は { matchings: [] } で、中身がある場合の形は未確認",
  },
  search: {
    procedure: "pages.jobSearch.searchJob",
    method: "POST",
    input: { filter: "{{filter:json}}", page_token: "{{pageToken}}", limit: 100, sort: "{{sort}}" },
    status: "confirmed",
    note: "page_token はページ番号の Base64（MQ== が1ページ目）。limit は 25 と 100 が通り、10 は 500",
  },
  searchCount: {
    procedure: "pages.jobSearch.totalResultsCount",
    method: "POST",
    input: { filter: "{{filter:json}}" },
    status: "confirmed",
  },
  myJobs: {
    procedure: "features.activities.getMyJoboffers",
    method: "GET",
    input: { type: "{{type}}", nextPageToken: "{{pageToken}}" },
    status: "confirmed",
    note: "type は viewed / interest / not_applied。1ページ50件、応答の nextPageToken を入力の nextPageToken に渡す（hasNextPage まで）",
  },
  applied: {
    procedure: "pages.applied.getApplied",
    method: "GET",
    input: { type: "{{type}}", nextPageToken: "{{pageToken}}" },
    status: "confirmed",
    note: "type は document_screening / interviews / closed。書類選考中は25件ずつ nextPageToken でページ送り",
  },
  interview: {
    procedure: "features.interview.getInterviewInfo",
    method: "GET",
    input: { scheduleAdjustInfoNo: "{{scheduleNo}}" },
    status: "confirmed",
    note: "scheduleAdjustInfoNo は一覧では数値だが、ここでは文字列で渡す。会議 URL は visitPerson か visitPlace に入る（企業による）",
  },
};

export const proceduresPath = () => join(configDir(), "procedures.json");

export async function loadProcedures(): Promise<Record<Action, ProcedureDef>> {
  const file = Bun.file(proceduresPath());
  if (!(await file.exists())) return DEFAULT_PROCEDURES;
  const overrides: Partial<Record<Action, Partial<ProcedureDef>>> = await file.json();
  const merged = { ...DEFAULT_PROCEDURES };
  for (const [action, def] of Object.entries(overrides) as [Action, Partial<ProcedureDef>][]) {
    if (!(action in DEFAULT_PROCEDURES)) throw new Error(`procedures.json: 未知のアクション "${action}"`);
    merged[action] = { ...DEFAULT_PROCEDURES[action], ...def, status: "override" };
  }
  return merged;
}

const DROP = Symbol("drop");

export function renderInput(template: unknown, vars: Record<string, string>): unknown {
  const out = render(template, vars);
  return out === DROP ? undefined : out;
}

function render(t: unknown, vars: Record<string, string>): unknown {
  if (typeof t === "string") {
    const whole = t.match(/^\{\{(\w+)(?::(number|nullable|json))?\}\}$/);
    if (whole) {
      const v = vars[whole[1]!];
      const mod = whole[2];
      if (v === undefined) return mod === "nullable" ? null : DROP;
      if (mod === "number") return Number(v);
      if (mod === "json") return JSON.parse(v);
      return v;
    }
    return t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
  }
  if (Array.isArray(t)) return t.map((x) => render(x, vars)).filter((x) => x !== DROP);
  if (t && typeof t === "object") {
    const entries = Object.entries(t)
      .map(([k, v]) => [k, render(v, vars)] as const)
      .filter(([, v]) => v !== DROP);
    return Object.fromEntries(entries);
  }
  return t;
}
