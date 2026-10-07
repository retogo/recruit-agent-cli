import type { Job } from "../../../domain/job.ts";
import type { MyJobsType } from "../../../ports/driven/recruit-agent.ts";
import { referralTypeForMyList, referralTypeOf } from "./referral.ts";

/**
 * API が返す求人。getRecommendJobs の recommendJobs[] と getMyJoboffers の joboffers[] で観測した形。
 * 項目は一覧の種類によって欠けることがある（isReceptionClosed など）。
 */
interface ApiJob {
  jobofferManagementNo: string;
  contractGenerationNo?: string;
  jobHeading: string;
  corpName: string;
  corpCode?: string;
  officeArea?: string;
  annualIncome?: { isConfidential?: boolean; min?: number | null; max?: number | null };
  isReceptionClosed?: boolean;
  sourceType?: string;
  i2a_tstamp?: string;
  trackingId?: string;
  disclosureLevelCode?: string;
  offices?: { prefectureCityName?: string }[];
  [flag: `is${string}`]: unknown;
}

/**
 * 行動ログの jobLabels。フロントエンドがカードに渡すフラグのうち真のものを、この順でラベルにする。
 * isApplied（応募済み）と isEmployeeProfileCount はおすすめ一覧の応答にないので扱わない。
 */
const LABELS: [keyof ApiJob, string][] = [
  ["isAdvisorReferral", "advisor_referral"],
  ["isAiScouted", "ai_scout"],
  ["isHrtechScouted", "hrtech_scout"],
  ["isInterviewCommitOffer", "interview_commit_offer"],
  ["isUnread", "unread"],
  ["isReceptionClosed", "reception_closed"],
  ["isJobMessage", "job_message"],
  ["isQuick", "quick"],
];

function isApiJob(v: unknown): v is ApiJob {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as ApiJob).jobofferManagementNo === "string" &&
    typeof (v as ApiJob).corpName === "string"
  );
}

/** 応答の中から求人の配列を探す（recommendJobs / joboffers など、キー名が一覧ごとに違うため） */
export function findJobArray(data: unknown, depth = 0): ApiJob[] {
  if (depth > 4 || !data || typeof data !== "object") return [];
  if (Array.isArray(data)) {
    if (data.length > 0 && data.every(isApiJob)) return data;
    return data.flatMap((x) => findJobArray(x, depth + 1));
  }
  let best: ApiJob[] = [];
  for (const v of Object.values(data)) {
    const found = findJobArray(v, depth + 1);
    if (found.length > best.length) best = found;
  }
  return best;
}

/**
 * どの一覧から取った求人か。jobReferralType の決め方が変わる。
 * 気になる・閲覧済み・興味なしはフラグから、検索結果は "jobSearch"（検索画面のカードと同じ）
 */
export type ListSource = MyJobsType | "search";

/**
 * position は一覧での並び順（1始まり）。おすすめ一覧以外では trackingId がないので tracking は null。
 * （検索結果にも tracking_id はあるが、おすすめ一覧の行動ログ用ではないので使わない）
 */
export function mapJob(api: ApiJob, position: number, list?: ListSource): Job {
  const income = api.annualIncome;
  const hidden = income?.isConfidential === true;
  const tracking =
    api.trackingId && api.contractGenerationNo
      ? {
          trackingId: api.trackingId,
          contractGenerationNo: api.contractGenerationNo,
          position,
          labels: LABELS.filter(([flag]) => api[flag] === true).map(([, label]) => label),
        }
      : null;
  const sourceType = api.sourceType ?? null;
  const referralType = sourceType
    ? (referralTypeOf(sourceType) ?? null)
    : list === "search"
      ? "jobSearch"
      : list
        ? referralTypeForMyList(api, list)
        : null;
  // 検索結果は officeArea がなく、offices[] に勤務地が並ぶ
  const offices = (api.offices ?? []).map((o) => o.prefectureCityName).filter(Boolean);
  const location = api.officeArea ?? (offices.length ? [...new Set(offices)].join("、") : null);
  return {
    id: api.jobofferManagementNo,
    company: api.corpName,
    title: api.jobHeading,
    salaryMin: hidden ? null : (income?.min ?? null),
    salaryMax: hidden ? null : (income?.max ?? null),
    location,
    closed: api.isReceptionClosed === true,
    sourceType,
    referralType,
    i2aTstamp: api.i2a_tstamp ?? null,
    generationNo: api.contractGenerationNo ?? null,
    tracking,
    raw: api,
  };
}

/** offset は前のページまでの件数（ページをまたいで position を通し番号にするため） */
export function mapJobs(data: unknown, offset = 0, list?: ListSource): Job[] {
  return findJobArray(data).map((api, i) => mapJob(api, offset + i + 1, list));
}
