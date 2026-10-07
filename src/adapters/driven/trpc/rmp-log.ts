import type { JobTracking } from "../../../domain/job.ts";
import { BASE_URL } from "./client.ts";

export const SEND_LOG = "rmpLogging.sendLog";

const RECOMMEND_URL = `${BASE_URL}/recommend`;

/** trackingId（base64 の i|2|求人ID|版番号|request_id）から request_id を取り出す */
export function requestIdOf(trackingId: string): string | null {
  const parts = atob(trackingId).split("|");
  return parts.length >= 5 ? parts.at(-1)! : null;
}

/**
 * おすすめ一覧のカードで「興味なし」を押したときにブラウザが送る行動ログ。
 * おすすめ一覧（推薦系の day0 / postday0 など）はこのログを見て求人を除外するので、
 * notApplications だけ送っても一覧に残り続ける。形はブラウザの実リクエストに合わせている。
 */
export function notApplyLog(jobId: string, t: JobTracking): unknown {
  const requestId = requestIdOf(t.trackingId);
  return {
    commonParameter: {
      pageId: "/recommend",
      pageUrl: RECOMMEND_URL,
      pageTitle: "求人をさがす",
      device: "pc",
      eventType: "click",
      eventName: "not_apply",
      referrer: RECOMMEND_URL,
    },
    extraParameter: {
      ...(requestId && { rmpRequestIds: [requestId] }),
      jobTrackingId: t.trackingId,
      pageNo: 1,
      position: t.position,
      jobofferManagementNo: jobId,
      contractGenerationNo: t.contractGenerationNo,
      elementName: "not_apply_button",
      jobLabels: t.labels,
    },
  };
}
