import type { MyJobsType } from "../../../ports/driven/recruit-agent.ts";

/*
 * 興味なし・気になる・応募で送る jobReferralType を決める。
 * どちらもサイトのフロントエンドのコードをそのまま写したもの。
 */

/** おすすめ一覧（/recommend）: 求人の sourceType から決める。対応表にないものは undefined（フロントエンドも同じ） */
const REFERRAL_TYPES: Record<string, string> = {
  day0: "i2aJobAssessmentAfterRecommend",
  postday0: "i2aJobAxisRecommend",
  advisor_referral: "recommendPost",
  ai_scouted: "aiScout",
  realtime: "smpRecommend",
  s_recommend: "i2aSRecommend",
  manual_scouted: "manualScouted",
};

export function referralTypeOf(sourceType: string | null): string | undefined {
  return sourceType === null ? undefined : REFERRAL_TYPES[sourceType];
}

export interface MyListFlags {
  isHrtechScouted?: unknown;
  isInterviewCommitOffer?: unknown;
  isAiScouted?: unknown;
  disclosureLevelCode?: unknown;
}

/** 気になる・閲覧済み・興味なしの一覧（/interests）: sourceType がないので、求人のフラグと一覧の種類から決める */
export function referralTypeForMyList(job: MyListFlags, list: MyJobsType): string {
  if (job.isHrtechScouted || job.isInterviewCommitOffer) return "manualScouted";
  if (job.isAiScouted) return "aiScout";
  if (job.disclosureLevelCode === "4") return "recommendPost";
  if (list === "viewed") return "smpRecommend";
  return "recommendPost";
}
