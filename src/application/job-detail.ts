/** 詳細ページのデータのうち、求人の中身ではないもの（A/B テスト・ログ・画面制御） */
export const DETAIL_NOISE = [
  "__deviceTypeDefaultState",
  "__loginSucceeded",
  "abTestData",
  "applyWithJobExtraParameter",
  "extraParameter",
  "forceBackToDefaultPath",
  "interestedJobIds",
  "isDisplayConfirmApplyDialogForEntryWithJob",
  "isDisplayConfirmApplyDialogForJobApply",
  "isDisplayConfirmDialog",
  "isScoutAcceptanceConfirmationTarget",
  "matchingCriteriaData",
  "referer",
  "requestId",
  "rmpLogPageViewData",
];

/** 詳細ページから、選考状況の一覧に足りない項目（年収・職種・勤務地・休日）を抜き出す */
export function detailSummary(d: Record<string, unknown>) {
  const p = d as {
    workCondition?: {
      salary?: { annualIncome?: { min?: number | null; max?: number | null }; unpublishedAnnualIncome?: boolean };
      dayoffAnnualDayCount?: number | null;
    };
    jobRequirements?: { occupations?: string[] };
    workLocation?: { offices?: { prefectureCityName?: string }[] };
  };
  const income = p.workCondition?.salary?.annualIncome;
  return {
    salaryMin: income?.min ?? null,
    salaryMax: income?.max ?? null,
    salaryUnpublished: p.workCondition?.salary?.unpublishedAnnualIncome === true,
    occupations: p.jobRequirements?.occupations ?? [],
    locations: [...new Set((p.workLocation?.offices ?? []).map((o) => o.prefectureCityName).filter(Boolean))],
    annualHolidays: p.workCondition?.dayoffAnnualDayCount ?? null,
  };
}

/** 詳細ページのデータから、求人の中身ではない項目を除く */
export function jobDetailView(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(detail).filter(([k]) => !DETAIL_NOISE.includes(k)));
}
