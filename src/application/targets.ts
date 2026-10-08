import { APPLIED_STATUSES, type Application } from "../domain/application.ts";
import { type Job, stripRaw } from "../domain/job.ts";
import type { RecruitAgentPort } from "../ports/driven/recruit-agent.ts";

/** 進捗の通知先（CLI は stderr、Worker は捨てる） */
export type Log = (message: string) => void;

/** 求人 ID から表示用の情報と紹介経路を引く表。おすすめ一覧を優先し、なければ気になる一覧を見る */
async function lookupJobs(port: RecruitAgentPort, ids: string[], log: Log): Promise<Map<string, Job>> {
  const known = new Map<string, Job>();
  log("おすすめ一覧から紹介経路を取得しています…");
  for (const job of stripRaw((await port.recommendJobs(4)).jobs)) known.set(job.id, job);
  if (ids.some((id) => !known.has(id))) {
    log("気になる一覧から紹介経路を取得しています…");
    for (const job of stripRaw((await port.myJobs("interest")).jobs)) if (!known.has(job.id)) known.set(job.id, job);
  }
  if (ids.some((id) => !known.has(id))) {
    log("選考状況から紹介経路を取得しています…");
    for (const status of APPLIED_STATUSES) {
      for (const a of await port.applied(status)) if (!known.has(a.id)) known.set(a.id, applicationAsJob(a));
    }
  }
  return known;
}

/**
 * 応募した求人を、詳細ページを開ける Job の形にする。
 * 選考状況の画面は詳細へのリンクに job_referral=recommendPost と generation_no を付けている。
 * 応募済みなので興味なし・気になるの対象にはならない想定。
 */
export function applicationAsJob(a: Application): Job {
  return {
    id: a.id,
    company: a.company,
    title: a.title,
    salaryMin: null,
    salaryMax: null,
    location: null,
    closed: a.status === "closed",
    sourceType: null,
    referralType: "recommendPost",
    i2aTstamp: null,
    generationNo: a.generationNo,
    tracking: null,
  };
}

/**
 * 紹介経路や表示情報が分からない対象を、おすすめ一覧・気になる一覧から補う。
 * 見つからなければ null のまま（紹介経路が要る操作はエラーになり、行動ログは送らない）。
 */
export async function resolveTargets(
  port: RecruitAgentPort,
  targets: Partial<Job>[],
  log: Log = () => {},
): Promise<Job[]> {
  const missing = (t: Partial<Job>) => t.referralType === undefined || t.tracking === undefined;
  const known = targets.some(missing) ? await lookupJobs(port, targets.map((t) => t.id!), log) : new Map<string, Job>();
  return targets.map((t) => {
    const hit = known.get(t.id!);
    if (missing(t) && hit) return hit;
    return {
      id: t.id!,
      company: t.company ?? hit?.company ?? "",
      title: t.title ?? hit?.title ?? "",
      salaryMin: t.salaryMin ?? hit?.salaryMin ?? null,
      salaryMax: t.salaryMax ?? hit?.salaryMax ?? null,
      location: t.location ?? hit?.location ?? null,
      closed: t.closed ?? hit?.closed ?? false,
      sourceType: t.sourceType ?? hit?.sourceType ?? null,
      referralType: t.referralType ?? null,
      i2aTstamp: t.i2aTstamp ?? null,
      generationNo: t.generationNo ?? hit?.generationNo ?? null,
      tracking: t.tracking ?? null,
    };
  });
}
