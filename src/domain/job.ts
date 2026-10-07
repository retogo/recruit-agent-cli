/** 求人ポストの1件 */
export interface Job {
  /** jobofferManagementNo。操作系の procedure はこの値で求人を指定する */
  id: string;
  company: string;
  title: string;
  /** 年収の下限・上限（万円）。非公開や上限なしは null */
  salaryMin: number | null;
  salaryMax: number | null;
  /** 勤務地の住所 */
  location: string | null;
  /** 「受付終了」表示の求人 */
  closed: boolean;
  /** 紹介経路（day0 / postday0 / manual_scouted / ai_scouted など）。おすすめ一覧の求人だけにある */
  sourceType: string | null;
  /**
   * 興味なし・気になる・応募で送る jobReferralType。
   * おすすめ一覧では sourceType から、気になる・閲覧済みなどの一覧ではフラグから決める（決まらなければ null）
   */
  referralType: string | null;
  /** 推薦時刻（i2a_tstamp）。興味なし・気になるで sendI2ATstamp として送る */
  i2aTstamp: string | null;
  /** 求人の版番号（contractGenerationNo）。詳細ページのクエリに使う */
  generationNo: string | null;
  /** おすすめ一覧での表示情報。興味なしの行動ログに使う（おすすめ一覧以外から取った求人は null） */
  tracking: JobTracking | null;
  /** API の元データ（--with-raw のときだけ出力する） */
  raw?: unknown;
}

export interface JobTracking {
  /** i|2|求人ID|版番号|request_id を base64 にしたもの */
  trackingId: string;
  contractGenerationNo: string;
  /** 一覧での並び順（1始まり） */
  position: number;
  /** 未読・AIスカウトなどのラベル（unread / ai_scout …） */
  labels: string[];
}

/** 興味なし・気になるの対象。ID だけでなく、紹介経路・推薦時刻・表示情報が要る */
export type JobRef = Pick<Job, "id" | "referralType" | "i2aTstamp" | "tracking">;

/** 詳細ページの対象。JobRef に版番号を加えたもの */
export type JobDetailRef = JobRef & Pick<Job, "generationNo">;

const CORPORATE_SUFFIXES = [
  "株式会社",
  "合同会社",
  "有限会社",
  "(株)",
  "(同)",
  "(有)",
];

/**
 * 企業名を照合用に正規化する。
 * 全角英数が混ざるので NFKC をかけ、法人格と空白を除いて小文字にそろえる。
 */
export function normalizeCompany(name: string): string {
  let s = name.normalize("NFKC");
  for (const suffix of CORPORATE_SUFFIXES) s = s.split(suffix).join("");
  return s.replace(/\s+/g, "").toLowerCase();
}

/** タイトルなどの一般テキストを照合用に正規化する */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
