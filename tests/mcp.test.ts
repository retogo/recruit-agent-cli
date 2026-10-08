import { expect, test } from "bun:test";
import { KvSessionStore } from "../src/adapters/driven/session/kv.ts";
import type { Session } from "../src/adapters/driven/session/session.ts";
import { explain, parseSessionInput, RecruitAgentTools } from "../src/adapters/driving/mcp/tools.ts";
import type { Interview } from "../src/domain/application.ts";
import type { Job, JobRef } from "../src/domain/job.ts";
import { type RecruitAgentPort, SessionExpiredError } from "../src/ports/driven/recruit-agent.ts";

const NOW = new Date("2026-10-08T00:00:00Z");

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  company: `企業${id}`,
  title: `求人${id}`,
  salaryMin: 600,
  salaryMax: 900,
  location: "東京都",
  closed: false,
  sourceType: "day0",
  referralType: "i2aJobAssessmentAfterRecommend",
  i2aTstamp: "2026-10-01T00:00:00",
  generationNo: "3",
  tracking: { trackingId: btoa(`i|2|${id}|3|req`), contractGenerationNo: "3", position: 1, labels: [] },
  raw: { jobCharacteristics: ["remote"] },
  ...extra,
});

const interview: Interview = {
  scheduleNo: "900",
  company: "企業A",
  title: "求人A",
  stage: "1次選考(Web面接)",
  fixedAt: "2026-10-10T10:00:00+09:00",
  startRanges: [],
  durationMin: 60,
  scheduleCode: "ScheduleFixed",
  place: "Web面接 https://meet.example/abc パスコード 1234",
  visitTo: "https://meet.example/abc",
  placeDetail: "ID 123 456",
  interviewer: "面接 太郎",
  emergencyContact: "03-0000-0000",
  contents: "技術面接",
  advice: "実績を具体的に",
  otherInfo: "連絡先 foo@example.com",
  updatedAt: null,
};

/** 呼ばれた操作を記録する偽のポート。呼ぶたびに Cookie を更新したことにする */
function fakePort(onRefresh: (s: Session) => void, session: Session, calls: string[], opts: { expired?: boolean }) {
  let n = 0;
  const touch = (name: string) => {
    calls.push(name);
    if (opts.expired) throw new SessionExpiredError("307 → /login");
    onRefresh({ ...session, cookie: `PDT2-WEB-SESSION=v${++n}`, refreshedAt: NOW.toISOString() });
  };
  const port: RecruitAgentPort = {
    recommendJobs: async () => (touch("recommend"), { jobs: [job("1"), job("2")], raw: null }),
    hide: async (j: JobRef) => touch(`hide ${j.id} ${j.referralType} ${j.tracking ? "tracked" : "untracked"}`),
    notApplyLog: async (j: JobRef) => touch(`log ${j.id}`),
    unhide: async (id: string) => touch(`unhide ${id}`),
    interest: async (j: JobRef) => touch(`interest ${j.id} ${j.referralType}`),
    uninterest: async (j: JobRef) => touch(`uninterest ${j.id}`),
    apply: async () => {
      throw new Error("apply must not be called");
    },
    similarJobs: async () => ({ jobs: [], raw: null }),
    searchJobs: async () => (touch("search"), { total: 1, jobs: [job("5", { referralType: "jobSearch", sourceType: null, tracking: null })] }),
    countJobs: async () => (touch("count"), 42),
    myJobs: async () => (touch("myJobs"), { jobs: [], raw: null }),
    applied: async (status) => (
      touch(`applied ${status}`),
      status === "interviews"
        ? [
            {
              id: "7",
              generationNo: "1",
              company: "企業A",
              title: "求人A",
              status,
              stage: null,
              stageCode: null,
              interviewAt: null,
              durationMin: null,
              scheduleCode: null,
              result: null,
              closedAt: null,
              unseen: false,
              scheduleNo: "900",
            },
          ]
        : []
    ),
    interview: async () => (touch("interview"), interview),
    call: async () => null,
    nextData: async () => null,
    jobDetail: async () => (touch("detail"), { jobofferManagementNo: "1", abTestData: {}, jobHeading: "求人1" }),
  };
  return port;
}

function setup(opts: { session?: Session | null; expired?: boolean } = {}) {
  const kv = new Map<string, string>();
  const puts: string[] = [];
  const store = new KvSessionStore({
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => {
      puts.push(v);
      kv.set(k, v);
    },
  });
  const initial = opts.session === undefined ? { cookie: "PDT2-WEB-SESSION=v0", headers: {}, transformer: "none" as const, importedAt: "t0" } : opts.session;
  if (initial) kv.set("session", JSON.stringify(initial));
  const calls: string[] = [];
  const tools = new RecruitAgentTools({
    store,
    connect: (session, onRefresh) => fakePort(onRefresh, session, calls, opts),
    sleep: async () => {},
    now: () => NOW,
  });
  return { tools, store, puts, calls };
}

test("ツール1回で Cookie が何度更新されても KV への書き込みは最後の1回だけ", async () => {
  const { tools, store, puts } = setup();
  await tools.hide({ jobs: ["1", "2"] });
  expect(puts).toHaveLength(1);
  expect((await store.load())?.cookie).toBe("PDT2-WEB-SESSION=v3");
});

test("セッションがなければ import_session を案内する", async () => {
  const { tools } = setup({ session: null });
  const error = await tools.recommend(1).catch((e) => explain(e) as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("import_session");
  expect((error as Error).message).not.toContain("ra auth");
});

test("import_session は確認できた Cookie だけを保存し、Cookie の値を返さない", async () => {
  const { tools, store } = setup({ session: null });
  const result = await tools.importSession("curl 'https://mypage.r-agent.com/recommend' -H 'user-agent: UA' -b 'PDT2-WEB-SESSION=new'");
  expect(result).toEqual({ ok: true, importedAt: NOW.toISOString(), recommendCount: 2 });
  expect(JSON.stringify(result)).not.toContain("PDT2");
  const saved = await store.load();
  expect(saved?.headers).toEqual({ "user-agent": "UA" });
  expect(saved?.importedAt).toBe(NOW.toISOString());
});

test("import_session は無効な Cookie で保存済みのセッションを上書きしない", async () => {
  const { tools, store, puts } = setup({ expired: true });
  await expect(tools.importSession("PDT2-WEB-SESSION=bad")).rejects.toBeInstanceOf(SessionExpiredError);
  expect(puts).toHaveLength(0);
  expect((await store.load())?.cookie).toBe("PDT2-WEB-SESSION=v0");
});

test("parseSessionInput は Cookie だけの入力も受け付け、それ以外は拒む", () => {
  expect(parseSessionInput("Cookie: a=1; PDT2-WEB-SESSION=x", NOW).cookie).toBe("a=1; PDT2-WEB-SESSION=x");
  expect(() => parseSessionInput("hello", NOW)).toThrow("PDT2-WEB-SESSION");
  expect(() => parseSessionInput("curl 'https://example.com/' -b 'PDT2-WEB-SESSION=x'", NOW)).toThrow("r-agent.com");
});

test("session_status はセッション切れをエラーにせず理由を返す", async () => {
  const { tools } = setup({ expired: true });
  const status = await tools.sessionStatus();
  expect(status.ok).toBe(false);
  expect("reason" in status && status.reason).toContain("import_session");
});

test("面接の予定は会議 URL・パスコード・面接官・連絡先を返さない", async () => {
  const { tools } = setup();
  const [summary] = await tools.interviews();
  expect(summary).toEqual({
    jobId: "7",
    scheduleNo: "900",
    company: "企業A",
    title: "求人A",
    stage: "1次選考(Web面接)",
    fixedAt: "2026-10-10T10:00:00+09:00",
    startRanges: [],
    durationMin: 60,
    scheduleCode: "ScheduleFixed",
    contents: "技術面接",
    advice: "実績を具体的に",
  });
  const text = JSON.stringify(summary);
  for (const secret of ["meet.example", "1234", "123 456", "面接 太郎", "03-0000-0000", "foo@example.com"]) {
    expect(text).not.toContain(secret);
  }
});

test("dryRun は送信せずに対象を返す", async () => {
  const { tools, calls } = setup();
  const result = await tools.hide({ jobs: ["2"], dryRun: true });
  expect(result).toEqual({
    dryRun: true,
    targets: [{ id: "2", company: "企業2", title: "求人2", referralType: "i2aJobAssessmentAfterRecommend", hasTracking: true }],
  });
  expect(calls).toEqual(["recommend"]);
});

test("一覧の求人オブジェクトを渡せば一覧を取り直さない（検索結果の求人も操作できる）", async () => {
  const { tools, calls } = setup();
  const { jobs } = (await tools.search({ keyword: "LLM", max: 100 })) as { jobs: Job[] };
  calls.length = 0;
  const result = await tools.interest({ jobs });
  expect(result).toMatchObject({ ok: 1, failed: 0 });
  expect(calls).toEqual(["interest 5 jobSearch"]);
});

test("ID だけなら おすすめ一覧から紹介経路と行動ログ用の表示情報を補う", async () => {
  const { tools, calls } = setup();
  await tools.hide({ jobs: ["1"] });
  expect(calls).toEqual(["recommend", "hide 1 i2aJobAssessmentAfterRecommend tracked"]);
});

test("興味なしの取り消しは紹介経路を引かない", async () => {
  const { tools, calls } = setup();
  await tools.unhide({ jobs: ["1"] });
  expect(calls).toEqual(["unhide 1"]);
});

test("検索は条件がなければ送らず、withCharacteristics でこだわり条件を付ける", async () => {
  const { tools, calls } = setup();
  await expect(tools.search({ max: 100 })).rejects.toThrow("検索条件");
  expect(calls).toHaveLength(0);
  const { jobs } = (await tools.search({ prefectures: ["13"], max: 100, withCharacteristics: true })) as {
    jobs: (Job & { characteristics: unknown })[];
  };
  expect(jobs[0]?.characteristics).toEqual(["remote"]);
  expect(jobs[0]).not.toHaveProperty("raw");
});

test("求人詳細は画面制御の項目を除く", async () => {
  const { tools } = setup();
  expect(await tools.showJob({ jobId: "1" })).toEqual({ jobofferManagementNo: "1", jobHeading: "求人1" });
});
