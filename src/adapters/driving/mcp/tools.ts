import { runSequential, type ItemResult } from "../../../application/bulk.ts";
import { jobDetailView } from "../../../application/job-detail.ts";
import { resolveTargets } from "../../../application/targets.ts";
import { APPLIED_STATUSES, type Application, type AppliedStatus, interviewSummary } from "../../../domain/application.ts";
import { type Job, type JobRef, stripRaw } from "../../../domain/job.ts";
import { buildSearchFilter, type SearchOptions, type SearchSort } from "../../../domain/search.ts";
import {
  MaintenanceError,
  type MyJobsType,
  type RecruitAgentPort,
  SessionExpiredError,
} from "../../../ports/driven/recruit-agent.ts";
import { extractTrpcCalls, parseCurl, replayableHeaders } from "../../driven/session/curl.ts";
import type { Session } from "../../driven/session/session.ts";
import { referralTypeOf } from "../../driven/trpc/referral.ts";

export interface SessionStore {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
}

export interface ToolsDependencies {
  store: SessionStore;
  /** セッションからポートを作る。サーバーが Cookie を更新したら onRefresh に新しいセッションを渡す */
  connect: (session: Session, onRefresh: (session: Session) => void) => RecruitAgentPort;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** 一覧の求人オブジェクト（そのまま渡せば一覧を取り直さない）か、求人 ID */
export type JobInput = string | Partial<Job>;

export interface BulkInput {
  jobs: JobInput[];
  dryRun?: boolean;
}

/** CLI と同じ間隔。約0.7秒間隔で60件連続しても制限はかからなかった */
const BULK_INTERVAL_MS = 700;

/** ログインに要る Cookie。これだけ貼られた場合も受け付ける */
const SESSION_COOKIE = "PDT2-WEB-SESSION";

/** ログイン切れ・メンテナンスを、MCP クライアントの利用者向けの案内に置き換える */
export function explain(e: unknown): unknown {
  if (e instanceof SessionExpiredError) {
    return new Error(
      `求人ポストのログインセッションが無効です（${e.detail}）。ブラウザでログインし、DevTools の「Copy as cURL」を import_session に渡してください。`,
    );
  }
  if (e instanceof MaintenanceError) return new Error(e.message);
  return e;
}

function toTarget(input: JobInput): Partial<Job> {
  if (typeof input === "string") return { id: input };
  const job = { ...input };
  delete job.raw;
  if (job.referralType === undefined && job.sourceType != null) {
    job.referralType = referralTypeOf(job.sourceType) ?? null;
  }
  return job;
}

/** dryRun で見せる対象。紹介経路が決まらない求人は実行しても失敗する */
function preview(job: Job) {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    referralType: job.referralType,
    hasTracking: job.tracking !== null,
  };
}

function summarize(results: ItemResult[]) {
  return { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/**
 * MCP のツールの中身。CLI の各コマンドに当たるが、応募と任意の procedure 呼び出しは持たない。
 * Cookie は呼び出しのたびに更新されるので、ツール1回の終わりにまとめて保存する（KV の書き込み回数を抑える）。
 */
export class RecruitAgentTools {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly deps: ToolsDependencies) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * imported を渡すと保存済みのセッションの代わりに使い、呼び出しが成功したときだけ保存する
   * （取り込んだ Cookie が無効なら、保存済みのものを上書きしない）。
   */
  private async withPort<T>(fn: (port: RecruitAgentPort) => Promise<T>, imported?: Session): Promise<T> {
    const current = imported ?? (await this.deps.store.load());
    if (!current) throw new SessionExpiredError("セッション未登録");
    let refreshed: Session | null = null;
    const port = this.deps.connect(current, (s) => {
      refreshed = s;
    });
    let succeeded = false;
    try {
      const result = await fn(port);
      succeeded = true;
      return result;
    } finally {
      const latest = refreshed ?? (imported ? current : null);
      if (latest && (succeeded || !imported)) await this.deps.store.save(latest);
    }
  }

  /**
   * DevTools の「Copy as cURL」（bash / cmd、複数可）か Cookie を取り込む。
   * おすすめ一覧が取れたときだけ保存し、Cookie の値は返さない。
   */
  async importSession(text: string) {
    const session = parseSessionInput(text, this.now());
    const recommendCount = await this.withPort(async (port) => (await port.recommendJobs(1)).jobs.length, session);
    return { ok: true, importedAt: session.importedAt, recommendCount };
  }

  /** セッションが生きているか。呼ぶと Cookie の有効期限が延びる（cron からも使う） */
  async sessionStatus() {
    const stored = await this.deps.store.load();
    if (!stored) return { ok: false, reason: "セッション未登録。import_session で取り込んでください" };
    try {
      const { jobs } = await this.withPort((port) => port.recommendJobs(1));
      const latest = await this.deps.store.load();
      return { ok: true, importedAt: stored.importedAt, refreshedAt: latest?.refreshedAt ?? null, recommendCount: jobs.length };
    } catch (e) {
      if (e instanceof SessionExpiredError || e instanceof MaintenanceError) {
        return { ok: false, reason: (explain(e) as Error).message };
      }
      throw e;
    }
  }

  async recommend(pages: number) {
    return this.withPort(async (port) => stripRaw((await port.recommendJobs(pages)).jobs));
  }

  async myJobs(type: MyJobsType) {
    return this.withPort(async (port) => stripRaw((await port.myJobs(type)).jobs));
  }

  async search(input: SearchOptions & { sort?: SearchSort; max: number; countOnly?: boolean; withCharacteristics?: boolean }) {
    const filter = buildSearchFilter(input);
    if (Object.keys(filter).length === 0) throw new Error("検索条件を1つ以上指定してください");
    return this.withPort(async (port) => {
      if (input.countOnly) return { filter, total: await port.countJobs(filter) };
      const { total, jobs } = await port.searchJobs(filter, { sort: input.sort, max: input.max });
      // こだわり条件（リモート可など）は検索条件にできないので、必要なら結果の jobCharacteristics で絞ってもらう
      const shown = input.withCharacteristics
        ? jobs.map(({ raw, ...job }) => ({
            ...job,
            characteristics: (raw as { jobCharacteristics?: unknown } | undefined)?.jobCharacteristics ?? null,
          }))
        : stripRaw(jobs);
      return { filter, total, jobs: shown };
    });
  }

  async showJob(input: { jobId: string; referralType?: string; generationNo?: string }) {
    return this.withPort(async (port) => {
      // 検索結果など一覧にない求人は、紹介経路と版番号を直接渡せば開ける
      const target: Partial<Job> =
        input.referralType && input.generationNo
          ? { id: input.jobId, referralType: input.referralType, generationNo: input.generationNo, i2aTstamp: null, tracking: null }
          : { id: input.jobId };
      const [job] = await resolveTargets(port, [target]);
      if (!job?.referralType) {
        throw new Error(
          `求人 ${input.jobId} がおすすめ一覧・気になる一覧・選考状況に見つからないため開けません。検索結果の求人なら referralType: "jobSearch" と generationNo を渡してください`,
        );
      }
      return jobDetailView(await port.jobDetail(job));
    });
  }

  async applications(status?: AppliedStatus) {
    return this.withPort(async (port) => {
      const list: Application[] = [];
      for (const s of status ? [status] : APPLIED_STATUSES) list.push(...(await port.applied(s)));
      return list;
    });
  }

  /** 面接詳細のうち、会議 URL・面接官・連絡先を除いた項目だけを返す */
  async interviews(jobId?: string) {
    return this.withPort(async (port) => {
      const scheduled = (await port.applied("interviews")).filter((a) => a.scheduleNo);
      const targets = jobId ? scheduled.filter((a) => a.id === jobId || a.scheduleNo === jobId) : scheduled;
      if (jobId && targets.length === 0) throw new Error(`${jobId} は面接中の求人 ID・日程調整番号に見つかりません`);
      const result = [];
      for (const a of targets) result.push({ jobId: a.id, ...interviewSummary(await port.interview(a.scheduleNo!)) });
      return result.sort((x, y) => (x.fixedAt ?? "9").localeCompare(y.fixedAt ?? "9"));
    });
  }

  hide(input: BulkInput & { logOnly?: boolean }) {
    return this.bulk(input, true, (port) => (input.logOnly ? (j) => port.notApplyLog(j) : (j) => port.hide(j)));
  }

  unhide(input: BulkInput) {
    return this.bulk(input, false, (port) => (j) => port.unhide(j.id));
  }

  interest(input: BulkInput) {
    return this.bulk(input, true, (port) => (j) => port.interest(j));
  }

  uninterest(input: BulkInput) {
    return this.bulk(input, true, (port) => (j) => port.uninterest(j));
  }

  private bulk(
    input: BulkInput,
    /** 紹介経路（referralType / i2aTstamp）が要る操作か */
    needsReferral: boolean,
    pick: (port: RecruitAgentPort) => (job: JobRef) => Promise<unknown>,
  ) {
    const targets = input.jobs.map(toTarget);
    return this.withPort(async (port) => {
      const jobs: Job[] = needsReferral
        ? await resolveTargets(port, targets)
        : targets.map((t) => ({ ...toJob(t), referralType: null, i2aTstamp: null, tracking: null }));
      if (input.dryRun) return { dryRun: true, targets: jobs.map(preview) };
      return summarize(await runSequential(jobs, pick(port), { intervalMs: BULK_INTERVAL_MS, sleep: this.sleep }));
    });
  }
}

function toJob(t: Partial<Job>): Job {
  return {
    id: t.id!,
    company: t.company ?? "",
    title: t.title ?? "",
    salaryMin: t.salaryMin ?? null,
    salaryMax: t.salaryMax ?? null,
    location: t.location ?? null,
    closed: t.closed ?? false,
    sourceType: t.sourceType ?? null,
    referralType: t.referralType ?? null,
    i2aTstamp: t.i2aTstamp ?? null,
    generationNo: t.generationNo ?? null,
    tracking: t.tracking ?? null,
  };
}

/** 「Copy as cURL」（複数可）か、`PDT2-WEB-SESSION=…` を含む Cookie の文字列からセッションを作る */
export function parseSessionInput(text: string, now: Date): Session {
  const trimmed = text.trim();
  const importedAt = now.toISOString();
  if (/^curl(\.exe)?\s/.test(trimmed)) {
    // 「Copy all as cURL」は複数の curl を改行や ; で並べる
    const chunks = trimmed.split(/(?:^|\n|;\s*\n?)\s*(?=curl(?:\.exe)?\s)/).filter((c) => /^curl/.test(c.trim()));
    for (const chunk of chunks) {
      const parsed = parseCurl(chunk);
      if (!parsed.cookie || !parsed.url.hostname.endsWith("r-agent.com")) continue;
      return {
        cookie: parsed.cookie,
        headers: replayableHeaders(parsed.headers),
        transformer: extractTrpcCalls(parsed).transformer ?? "none",
        importedAt,
      };
    }
    throw new Error("Cookie 付きの r-agent.com へのリクエストが見つかりません");
  }
  const cookie = trimmed.replace(/^cookie:\s*/i, "");
  if (!cookie.includes(`${SESSION_COOKIE}=`)) {
    throw new Error(`「Copy as cURL」の内容か、${SESSION_COOKIE}=… を含む Cookie を渡してください`);
  }
  return { cookie, headers: {}, transformer: "none", importedAt };
}
