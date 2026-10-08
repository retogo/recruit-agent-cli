/** 選考状況のタブ。書類選考中 / 書類通過〜内定 / 選考終了 */
export const APPLIED_STATUSES = ["document_screening", "interviews", "closed"] as const;
export type AppliedStatus = (typeof APPLIED_STATUSES)[number];

/** 応募した求人1件の選考状況 */
export interface Application {
  /** jobofferManagementNo（API は数値で返すが、他の一覧に合わせて文字列にする） */
  id: string;
  generationNo: string;
  company: string;
  title: string;
  status: AppliedStatus;
  /** 選考段階の名前（「1次選考(Web面接)」「書類選考」など） */
  stage: string | null;
  /** 面接中の区分（InterviewProcess / ScreeningPassed / OfferIssued） */
  stageCode: string | null;
  /** 面接日時（ISO 8601） */
  interviewAt: string | null;
  /** 面接の所要時間（分） */
  durationMin: number | null;
  /** 日程調整の状態（ScheduleFixed など） */
  scheduleCode: string | null;
  /** 選考終了の理由（NotPassed: 不合格 / Declined: 辞退） */
  result: string | null;
  /** 不合格の日付（ISO 8601） */
  closedAt: string | null;
  /** 画面で未読（新着）扱いか */
  unseen: boolean;
  /** 面接の日程調整番号（scheduleAdjustInfoNo）。面接詳細を引くキー。面接中の行にだけある */
  scheduleNo: string | null;
}

/**
 * 面接詳細（画面の「詳細」モーダルの中身）。
 * 会議 URL・面接官・緊急連絡先を含むので、ログや共有先に出さないこと。
 */
export interface Interview {
  scheduleNo: string;
  company: string;
  title: string;
  /** 選考段階（「1次選考(Web面接)」など） */
  stage: string | null;
  /** 確定した面接日時（ISO 8601） */
  fixedAt: string | null;
  /** 面接開始時刻の範囲（調整中は幅がある） */
  startRanges: { from: string; to: string }[];
  durationMin: number | null;
  /** 日程調整の状態（ScheduleFixed など） */
  scheduleCode: string | null;
  /**
   * 訪問場所（「Web面接」など）。面接によっては会議 URL・会議 ID・パスコードまでここに書かれる。
   * 会議情報がどの項目に入るかは企業ごとに違うので、place / visitTo / placeDetail のどれも機微情報として扱う
   */
  place: string | null;
  /** 訪問先。Web面接では会議 URL が入ることが多い */
  visitTo: string | null;
  /** 接続方法や注意事項 */
  placeDetail: string | null;
  interviewer: string | null;
  /** 当日の緊急連絡先 */
  emergencyContact: string | null;
  /** 選考内容 */
  contents: string | null;
  /** アドバイザーからの選考のポイント・アドバイス */
  advice: string | null;
  otherInfo: string | null;
  updatedAt: string | null;
}

/** 面接詳細のうち、会話やログに出してよい項目（日時・企業・選考段階・所要時間・選考内容・対策メモ） */
export type InterviewSummary = Pick<
  Interview,
  "scheduleNo" | "company" | "title" | "stage" | "fixedAt" | "startRanges" | "durationMin" | "scheduleCode" | "contents" | "advice"
>;

/**
 * 会議 URL・会議 ID・パスコード・面接官・緊急連絡先を落とした面接詳細。
 * 会議情報は place / visitTo / placeDetail / otherInfo のどれに入るか企業ごとに違うので、許可した項目だけを写す。
 */
export function interviewSummary(i: Interview): InterviewSummary {
  return {
    scheduleNo: i.scheduleNo,
    company: i.company,
    title: i.title,
    stage: i.stage,
    fixedAt: i.fixedAt,
    startRanges: i.startRanges,
    durationMin: i.durationMin,
    scheduleCode: i.scheduleCode,
    contents: i.contents,
    advice: i.advice,
  };
}
