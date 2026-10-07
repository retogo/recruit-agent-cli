import type { HttpMethod, JobList, MyJobsType, RecruitAgentPort, SearchResult } from "../../../ports/driven/recruit-agent.ts";
import { ProcedureError } from "../../../ports/driven/recruit-agent.ts";
import type { Application, AppliedStatus, Interview } from "../../../domain/application.ts";
import type { Job, JobDetailRef, JobRef } from "../../../domain/job.ts";
import type { SearchSort } from "../../../domain/search.ts";
import { type ApiInterview, type AppliedPage, mapApplication, mapInterview } from "./applied-mapper.ts";
import type { TrpcClient } from "./client.ts";
import { mapJobs } from "./mapper.ts";
import { type Action, type ProcedureDef, renderInput } from "./procedures.ts";
import { SEND_LOG, notApplyLog, requestIdOf } from "./rmp-log.ts";

const NANOID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** 画面が作る request_id と同じ 21 文字の nanoid 形式 */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => NANOID_ALPHABET[b & 63]).join("");
}

/** 興味なし・気になるのテンプレート変数。jobReferralType は必須なので、決められなければ送る前に止める */
function referralVars(job: JobRef): Record<string, string> {
  const referralType = job.referralType;
  if (!referralType) {
    throw new ProcedureError(job.id, "紹介経路（jobReferralType）を決められません。おすすめ一覧か気になる一覧にある求人を指定してください");
  }
  const vars: Record<string, string> = { jobId: job.id, referralType };
  if (job.i2aTstamp) vars.i2aTstamp = job.i2aTstamp;
  return vars;
}

/**
 * 求人詳細ページのパス。一覧のカードがリンクに付けるクエリと同じものを付ける（フロントエンドのコードの写し）。
 * job_referral だけだと 404 になる。推薦時刻や表示情報まで付けると取れる。
 */
export function jobDetailPath(job: JobDetailRef): string {
  const q = new URLSearchParams();
  if (job.referralType) q.set("job_referral", job.referralType);
  if (job.tracking) {
    q.set("page_no", "1");
    q.set("position", String(job.tracking.position));
    const requestId = requestIdOf(job.tracking.trackingId);
    if (requestId) q.set("request_ids", requestId);
    q.set("tracking_id", job.tracking.trackingId);
  }
  if (job.i2aTstamp) q.set("i2a_tstamp", job.i2aTstamp);
  if (job.generationNo) q.set("generation_no", job.generationNo);
  return `/joboffers/${encodeURIComponent(job.id)}?${q}`;
}

export class TrpcRecruitAgent implements RecruitAgentPort {
  constructor(
    private readonly client: TrpcClient,
    private readonly procedures: Record<Action, ProcedureDef>,
  ) {}

  private run(action: Action, vars: Record<string, string> = {}): Promise<unknown> {
    const def = this.procedures[action];
    return this.client.call(def.procedure, renderInput(def.input, vars), def.method);
  }

  private async list(action: Action, vars: Record<string, string> = {}, myList?: MyJobsType): Promise<JobList> {
    const raw = await this.run(action, vars);
    return { jobs: mapJobs(raw, 0, myList), raw };
  }

  async recommendJobs(maxPages: number): Promise<JobList> {
    const requestId = newRequestId();
    const pages: unknown[] = [];
    const jobs = [];
    let pageToken: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const raw = await this.run("recommend", pageToken ? { requestId, pageToken } : { requestId });
      pages.push(raw);
      jobs.push(...mapJobs(raw, jobs.length));
      const next = (raw as { nextPageToken?: string | null } | null)?.nextPageToken;
      if (!next) break;
      pageToken = next;
    }
    return { jobs, raw: pages };
  }
  /** 非表示にしたうえで、おすすめ一覧から外れるよう not_apply の行動ログも送る（ブラウザと同じ） */
  async hide(job: JobRef) {
    const result = await this.run("hide", referralVars(job));
    if (job.tracking) await this.notApplyLog(job);
    return result;
  }
  async notApplyLog(job: JobRef) {
    if (!job.tracking) {
      throw new ProcedureError(job.id, "おすすめ一覧の表示情報（trackingId）がないため行動ログを送れません");
    }
    return this.client.call(SEND_LOG, notApplyLog(job.id, job.tracking), "POST");
  }
  unhide(jobId: string) {
    return this.run("unhide", { jobId });
  }
  async interest(job: JobRef) {
    return this.run("interest", referralVars(job));
  }
  async uninterest(job: JobRef) {
    return this.run("uninterest", referralVars(job));
  }
  async apply(job: JobRef) {
    return this.run("apply", referralVars(job));
  }
  similarJobs(jobId: string) {
    return this.list("similar", { jobId });
  }
  async searchJobs(filter: Record<string, unknown>, opts: { sort?: SearchSort; max: number }): Promise<SearchResult> {
    const jobs: Job[] = [];
    let total = 0;
    // page_token はページ番号の Base64。1ページ目は "MQ=="（= "1"）で、以降は応答の next_page_token
    let pageToken: string | undefined = btoa("1");
    while (pageToken && jobs.length < opts.max) {
      const vars: Record<string, string> = { filter: JSON.stringify(filter), pageToken };
      if (opts.sort) vars.sort = opts.sort;
      const page = (await this.run("search", vars)) as { total_count?: number; next_page_token?: string | null } | null;
      total = page?.total_count ?? total;
      const found = mapJobs(page, jobs.length, "search");
      if (found.length === 0) break;
      jobs.push(...found);
      pageToken = page?.next_page_token ?? undefined;
    }
    return { total, jobs: jobs.slice(0, opts.max) };
  }
  async countJobs(filter: Record<string, unknown>): Promise<number> {
    const res = (await this.run("searchCount", { filter: JSON.stringify(filter) })) as { total_count?: number } | null;
    return res?.total_count ?? 0;
  }
  /** 50件ずつ nextPageToken をたどって全件を返す（hasNextPage が false になるまで） */
  async myJobs(type: MyJobsType): Promise<JobList> {
    const jobs: Job[] = [];
    const pages: unknown[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 40; i++) {
      const raw = (await this.run("myJobs", pageToken ? { type, pageToken } : { type })) as {
        nextPageToken?: string | null;
        hasNextPage?: boolean;
      } | null;
      pages.push(raw);
      jobs.push(...mapJobs(raw, jobs.length, type));
      if (!raw?.hasNextPage || !raw.nextPageToken) break;
      pageToken = raw.nextPageToken;
    }
    return { jobs, raw: pages };
  }
  async applied(status: AppliedStatus): Promise<Application[]> {
    const out: Application[] = [];
    let pageToken: string | undefined;
    // 書類選考中は25件ずつ。念のため上限を設けて無限ループを防ぐ
    for (let i = 0; i < 40; i++) {
      const vars: Record<string, string> = pageToken ? { type: status, pageToken } : { type: status };
      const page = (await this.run("applied", vars)) as AppliedPage | null;
      out.push(...(page?.list ?? []).map((a) => mapApplication(a, status)));
      if (!page?.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return out;
  }
  async interview(scheduleNo: string): Promise<Interview> {
    const raw = (await this.run("interview", { scheduleNo })) as ApiInterview | null;
    if (!raw) throw new ProcedureError(scheduleNo, "面接詳細がありません");
    return mapInterview(raw, scheduleNo);
  }
  call(procedure: string, input: unknown, method: HttpMethod) {
    return this.client.call(procedure, input, method);
  }

  async jobDetail(job: JobDetailRef): Promise<Record<string, unknown>> {
    const data = (await this.nextData(jobDetailPath(job))) as { props?: { pageProps?: Record<string, unknown> } };
    const props = data.props?.pageProps;
    if (!props?.jobofferManagementNo) throw new ProcedureError(job.id, "詳細ページに求人データがありません");
    return props;
  }

  async nextData(path: string): Promise<unknown> {
    const url = new URL(path, this.client.baseUrl);
    const res = await this.client.fetchPage(url);
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new ProcedureError(url.pathname, "__NEXT_DATA__ が見つかりません");
    return JSON.parse(m[1]!);
  }
}
