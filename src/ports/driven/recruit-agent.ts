import type { Application, AppliedStatus, Interview } from "../../domain/application.ts";
import type { Job, JobDetailRef, JobRef } from "../../domain/job.ts";
import type { SearchSort } from "../../domain/search.ts";

export type HttpMethod = "GET" | "POST";

export const MY_JOBS_TYPES = ["viewed", "interest", "not_applied"] as const;
export type MyJobsType = (typeof MY_JOBS_TYPES)[number];

/** 求人ポスト（mypage.r-agent.com）への操作 */
export interface RecruitAgentPort {
  /** おすすめ求人。API は1ページ25件で、画面は最大100件まで表示する */
  recommendJobs(maxPages: number): Promise<JobList>;
  /** 興味なし。おすすめ一覧から外すための行動ログ（not_apply）も送る */
  hide(job: JobRef): Promise<unknown>;
  /** 興味なしの行動ログだけを送る（ログなしで非表示にした求人をおすすめ一覧から外す） */
  notApplyLog(job: JobRef): Promise<unknown>;
  /** 興味なしの取り消し */
  unhide(jobId: string): Promise<unknown>;
  /** 気になるに登録 */
  interest(job: JobRef): Promise<unknown>;
  /** 気になるを解除 */
  uninterest(job: JobRef): Promise<unknown>;
  /** 応募。取り消せないので、呼び出し側で必ず人の確認を挟むこと */
  apply(job: JobRef): Promise<unknown>;
  similarJobs(jobId: string): Promise<JobList>;
  /** 求人検索。100件ずつページをたどり、最大 max 件まで返す */
  searchJobs(filter: Record<string, unknown>, opts: { sort?: SearchSort; max: number }): Promise<SearchResult>;
  /** 検索条件に当たる件数だけを返す */
  countJobs(filter: Record<string, unknown>): Promise<number>;
  /** 閲覧済み・気になる・興味なしの一覧（全ページ） */
  myJobs(type: MyJobsType): Promise<JobList>;
  /** 選考状況（全ページ）。取得すると画面の未読バッジが消える可能性がある */
  applied(status: AppliedStatus): Promise<Application[]>;
  /** 面接詳細（会議 URL・面接官・対策メモなど）。キーは選考状況の scheduleNo */
  interview(scheduleNo: string): Promise<Interview>;
  /** 任意の procedure を呼ぶ（調査用） */
  call(procedure: string, input: unknown, method: HttpMethod): Promise<unknown>;
  /** ページの __NEXT_DATA__ を取り出す（求人詳細などサーバー描画のページ向け） */
  nextData(path: string): Promise<unknown>;
  /** 求人詳細（詳細ページのサーバー描画データ）。開くと閲覧済み・既読として記録される */
  jobDetail(job: JobDetailRef): Promise<Record<string, unknown>>;
}

export interface SearchResult {
  /** 条件に当たる全件数（返した件数ではない） */
  total: number;
  jobs: Job[];
}

export interface JobList {
  jobs: Job[];
  /** マッパーが求人配列を見つけられなかったときの確認用 */
  raw: unknown;
}

/** サイトがメンテナンス中（/maintenance.html に転送される）。ログインし直しても直らないので、時間をおいて再実行する */
export class MaintenanceError extends Error {
  constructor() {
    super("求人ポストがメンテナンス中です（/maintenance.html に転送されました）。時間をおいて再実行してください。");
    this.name = "MaintenanceError";
  }
}

export class SessionExpiredError extends Error {
  /** 切れたと判断した理由（HTTP ステータスやリダイレクト先）。CLI 以外は案内文を自前で組み立てる */
  constructor(readonly detail: string) {
    super(`ログインセッションが無効です（${detail}）。\`ra auth import-curl\` で取り込み直してください。`);
    this.name = "SessionExpiredError";
  }
}

export class ProcedureError extends Error {
  constructor(
    readonly procedure: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(`${procedure}: ${message}`);
    this.name = "ProcedureError";
  }
}
