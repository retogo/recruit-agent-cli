import { type Job, normalizeCompany, normalizeText } from "./job.ts";

/**
 * 機械的に判定できる絞り込みルール。
 * 「知名度」のような主観的な分類はここに持たず、skill 側で Claude が判断する。
 */
export interface FilterRules {
  /** 他のどのルールより優先して残す企業（正規化後の部分一致） */
  keepCompanies?: string[];
  /** 除外する企業（正規化後の部分一致） */
  excludeCompanies?: string[];
  /** 除外するタイトルのキーワード（正規化後の部分一致） */
  excludeTitles?: string[];
  /** タイトルがキーワードに当たり、かつ年収上限が閾値以下なら除外（例：リーダー・PM職で上限1000万円以下） */
  excludeLowCeilingRoles?: {
    titleKeywords: string[];
    /** 万円 */
    salaryMaxAtMost: number;
  };
  /** 「受付終了」の求人を除外する */
  excludeClosed?: boolean;
  /** 同じ求人（ID 一致、または企業名＋タイトル一致）の2件目以降を除外する */
  dedupe?: boolean;
}

export interface Excluded {
  job: Job;
  reason: string;
}

export interface FilterResult {
  kept: Job[];
  excluded: Excluded[];
}

/**
 * 正規化後の部分一致。ただし英数字だけのキーワードは単語境界で照合する
 * （"PM" が "Development" に当たらないように）。
 */
function matchAny(value: string, needles: string[] | undefined, norm: (s: string) => string): string | null {
  if (!needles) return null;
  for (const needle of needles) {
    const n = norm(needle);
    const hit = /^[a-z0-9]+$/.test(n)
      ? new RegExp(`(?<![a-z0-9])${n}(?![a-z0-9])`).test(value)
      : value.includes(n);
    if (hit) return needle;
  }
  return null;
}

export function applyFilter(jobs: Job[], rules: FilterRules): FilterResult {
  const kept: Job[] = [];
  const excluded: Excluded[] = [];
  const seenIds = new Map<string, string>();
  const seenKeys = new Map<string, string>();

  for (const job of jobs) {
    const company = normalizeCompany(job.company);
    const title = normalizeText(job.title);

    if (rules.dedupe ?? true) {
      const key = `${company}\u0000${title}`;
      const dup = seenIds.get(job.id) ?? seenKeys.get(key);
      if (dup !== undefined) {
        excluded.push({ job, reason: `duplicate of ${dup}` });
        continue;
      }
      seenIds.set(job.id, job.id);
      seenKeys.set(key, job.id);
    }

    if (matchAny(company, rules.keepCompanies, normalizeCompany)) {
      kept.push(job);
      continue;
    }

    const reason = exclusionReason(job, company, title, rules);
    if (reason) excluded.push({ job, reason });
    else kept.push(job);
  }

  return { kept, excluded };
}

function exclusionReason(job: Job, company: string, title: string, rules: FilterRules): string | null {
  if (rules.excludeClosed && job.closed) return "closed";

  const byCompany = matchAny(company, rules.excludeCompanies, normalizeCompany);
  if (byCompany) return `company: ${byCompany}`;

  const byTitle = matchAny(title, rules.excludeTitles, normalizeText);
  if (byTitle) return `title: ${byTitle}`;

  const role = rules.excludeLowCeilingRoles;
  if (role && job.salaryMax !== null && job.salaryMax <= role.salaryMaxAtMost) {
    const kw = matchAny(title, role.titleKeywords, normalizeText);
    if (kw) return `role "${kw}" with salaryMax ${job.salaryMax} <= ${role.salaryMaxAtMost}`;
  }

  return null;
}
