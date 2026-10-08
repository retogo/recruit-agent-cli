/** 求人検索の条件（CLI のオプションから作る） */
export interface SearchOptions {
  /** フリーワード（空白区切りで AND） */
  keyword?: string;
  /** 職種コード。3桁は大分類（110 = IT）、4桁は中分類（1111 = サーバーサイド）、それ以外は小分類 ID */
  occupations?: string[];
  /** 業種コード。末尾が 00 の4桁は大分類（1100）、それ以外は小分類（1101） */
  industries?: string[];
  /** 都道府県コード（13 = 東京） */
  prefectures?: string[];
  /** 年収下限（万円） */
  incomeMin?: number;
}

export const SEARCH_SORTS = ["relevance", "newest"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/**
 * pages.jobSearch.searchJob / totalResultsCount の filter を組み立てる。
 * 形は検索ページ（/job_search）がクエリから作る requestPayload に合わせている。
 */
export function buildSearchFilter(o: SearchOptions): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (o.keyword?.trim()) filter.keyword = { and: o.keyword.trim() };
  if (o.occupations?.length) {
    filter.occupations = o.occupations.map((code) => {
      if (/^\d{3}$/.test(code)) return { lv1_num: Number(code) };
      if (/^\d{4}$/.test(code)) return { lv2_num: Number(code) };
      return { occupation_id: code };
    });
  }
  if (o.industries?.length) {
    filter.industries = o.industries.map((code) => (/^\d{2}00$/.test(code) ? { lv1_id: code } : { lv2_id: code }));
  }
  if (o.prefectures?.length) {
    filter.locations = o.prefectures.map((code) => ({
      location_type: "prefecture",
      prefecture_code: code.padStart(2, "0"),
    }));
  }
  // 名前は under だが「この金額以上」の意味（円単位）
  if (o.incomeMin) filter.annual_income = { under: o.incomeMin * 10_000 };
  return filter;
}
