import { expect, test } from "bun:test";
import type { Session } from "../src/adapters/driven/session/store.ts";
import { TrpcClient } from "../src/adapters/driven/trpc/client.ts";
import { DEFAULT_PROCEDURES } from "../src/adapters/driven/trpc/procedures.ts";
import { TrpcRecruitAgent, jobDetailPath } from "../src/adapters/driven/trpc/recruit-agent.ts";
import { ProcedureError } from "../src/ports/driven/recruit-agent.ts";

const session: Session = { cookie: "s=1", headers: {}, transformer: "none", importedAt: "test" };

function agent() {
  const bodies: unknown[] = [];
  const paths: string[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    paths.push(new URL(String(url)).pathname);
    bodies.push(JSON.parse(String(init?.body))["0"]);
    return Response.json([{ result: { data: null } }]);
  };
  return { port: new TrpcRecruitAgent(new TrpcClient(session, fetchFn), DEFAULT_PROCEDURES), bodies, paths };
}

test("hide: 表示情報があれば、非表示のあとにブラウザと同じ not_apply ログを送る", async () => {
  const { port, bodies, paths } = agent();
  const trackingId = btoa("i|2|100000007|8|REQUESTID");
  await port.hide({
    id: "100000007",
    referralType: "i2aJobAssessmentAfterRecommend",
    i2aTstamp: "1",
    tracking: { trackingId, contractGenerationNo: "8", position: 5, labels: ["unread"] },
  });
  expect(paths).toEqual([
    "/api/trpc/features.activities.notApplications",
    "/api/trpc/rmpLogging.sendLog",
  ]);
  expect(bodies[1]).toEqual({
    commonParameter: {
      pageId: "/recommend",
      pageUrl: "https://mypage.r-agent.com/recommend",
      pageTitle: "求人をさがす",
      device: "pc",
      eventType: "click",
      eventName: "not_apply",
      referrer: "https://mypage.r-agent.com/recommend",
    },
    extraParameter: {
      rmpRequestIds: ["REQUESTID"],
      jobTrackingId: trackingId,
      pageNo: 1,
      position: 5,
      jobofferManagementNo: "100000007",
      contractGenerationNo: "8",
      elementName: "not_apply_button",
      jobLabels: ["unread"],
    },
  });
});

test("notApplyLog: 表示情報がなければ送らない", async () => {
  const { port, bodies } = agent();
  expect(port.notApplyLog({ id: "1", referralType: "i2aJobAssessmentAfterRecommend", i2aTstamp: null, tracking: null })).rejects.toBeInstanceOf(
    ProcedureError,
  );
  expect(bodies).toEqual([]);
});

test("hide: ブラウザの実リクエストと同じ形で送る", async () => {
  const { port, bodies } = agent();
  await port.hide({ id: "100000008", referralType: "i2aJobAssessmentAfterRecommend", i2aTstamp: "1790820096", tracking: null });
  expect(bodies[0]).toEqual({
    jobofferManagementNo: "100000008",
    jobReferralType: "i2aJobAssessmentAfterRecommend",
    sendI2ATstamp: "1790820096",
  });
});

test("hide: 推薦時刻のないスカウト求人は sendI2ATstamp を送らない", async () => {
  const { port, bodies } = agent();
  await port.hide({ id: "1", referralType: "manualScouted", i2aTstamp: null, tracking: null });
  expect(bodies[0]).toEqual({ jobofferManagementNo: "1", jobReferralType: "manualScouted" });
});

test("interest / uninterest / unhide の入力", async () => {
  const { port, bodies } = agent();
  const ref = { id: "1", referralType: "i2aJobAxisRecommend", i2aTstamp: "9", tracking: null };
  await port.interest(ref);
  await port.uninterest(ref);
  await port.unhide("1");
  expect(bodies).toEqual([
    { jobofferManagementNo: "1", isRegistration: true, jobReferralType: "i2aJobAxisRecommend", sendI2ATstamp: "9" },
    { jobofferManagementNo: "1", isRegistration: false, jobReferralType: "i2aJobAxisRecommend", sendI2ATstamp: "9" },
    { jobofferManagementNo: "1" },
  ]);
});

test("jobDetailPath: 一覧のカードと同じクエリを付ける", () => {
  const trackingId = btoa("i|2|9|5|REQ");
  const path = jobDetailPath({
    id: "9",
    referralType: "i2aJobAssessmentAfterRecommend",
    i2aTstamp: "123",
    generationNo: "5",
    tracking: { trackingId, contractGenerationNo: "5", position: 2, labels: [] },
  });
  const url = new URL(path, "https://example.com");
  expect(url.pathname).toBe("/joboffers/9");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    job_referral: "i2aJobAssessmentAfterRecommend",
    page_no: "1",
    position: "2",
    request_ids: "REQ",
    tracking_id: trackingId,
    i2a_tstamp: "123",
    generation_no: "5",
  });
  // 気になる一覧の求人は表示情報も推薦時刻もない
  expect(jobDetailPath({ id: "9", referralType: "recommendPost", i2aTstamp: null, generationNo: "3", tracking: null })).toBe(
    "/joboffers/9?job_referral=recommendPost&generation_no=3",
  );
});

test("紹介経路が決まらない求人は送る前に止める", async () => {
  const { port, bodies } = agent();
  expect(port.hide({ id: "1", referralType: null, i2aTstamp: null, tracking: null })).rejects.toBeInstanceOf(ProcedureError);
  expect(bodies).toEqual([]);
});
