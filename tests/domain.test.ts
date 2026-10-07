import { expect, test } from "bun:test";
import { mapJobs } from "../src/adapters/driven/trpc/mapper.ts";
import { parseTargets } from "../src/adapters/driving/cli/index.ts";
import { runSequential } from "../src/application/bulk.ts";
import { applyFilter } from "../src/domain/filter.ts";
import { type Job, normalizeCompany } from "../src/domain/job.ts";
import { SessionExpiredError } from "../src/ports/driven/recruit-agent.ts";
import fixture from "./fixtures/recommend.json";

const job = (over: Partial<Job>): Job => ({
  id: "1",
  company: "",
  title: "",
  salaryMin: null,
  salaryMax: null,
  location: null,
  closed: false,
  sourceType: null,
  referralType: null,
  generationNo: null,
  i2aTstamp: null,
  tracking: null,
  ...over,
});

test("normalizeCompany: 全角英数・法人格・空白を吸収する", () => {
  expect(normalizeCompany("ＸＹＺ 株式会社")).toBe("xyz");
  expect(normalizeCompany("サンプルキャリア（株）")).toBe("サンプルキャリア");
  expect(normalizeCompany("合同会社ＥＸＡＭＰＬＥ．ｃｏｍ")).toBe("example.com");
});

test("mapJobs: getRecommendJobs の実応答を正規化する（年収上限なしは null）", () => {
  const jobs = mapJobs(fixture);
  expect(jobs.map(({ raw, ...j }) => j)).toEqual([
    job({
      id: "100000002",
      company: "株式会社サンプルデータ",
      title: "【データエンジニア】大規模データ基盤の構築",
      salaryMin: 550,
      salaryMax: 990,
      location: "東京都渋谷区サンプル1-2-3　サンプルビル",
      sourceType: "day0",
      referralType: "i2aJobAssessmentAfterRecommend",
      generationNo: "5",
      i2aTstamp: "1790992907",
    }),
    job({
      id: "100000006",
      company: "合同会社ＥＸＡＭＰＬＥ．ｃｏｍ",
      title: "テックリード/VPoE室",
      salaryMin: 600,
      salaryMax: null,
      location: "東京都港区サンプル4-5-6 サンプルタワー",
      sourceType: "ai_scouted",
      referralType: "aiScout",
      generationNo: "10",
    }),
  ]);
});

test("mapJobs: trackingId があれば行動ログ用の表示情報を作る（position は offset からの通し番号）", () => {
  const trackingId = btoa("i|2|9|3|REQ");
  const [j] = mapJobs(
    {
      recommendJobs: [
        {
          jobofferManagementNo: "9",
          contractGenerationNo: "3",
          corpName: "A",
          jobHeading: "T",
          trackingId,
          isNew: true,
          isUnread: true,
          isAiScouted: true,
        },
      ],
    },
    25,
  );
  expect(j!.tracking).toEqual({ trackingId, contractGenerationNo: "3", position: 26, labels: ["ai_scout", "unread"] });
});

test("mapJobs: 気になる・閲覧済みの一覧ではフラグと一覧の種類から jobReferralType を決める", () => {
  const data = (flags: Record<string, unknown>) => ({
    joboffers: [{ jobofferManagementNo: "1", corpName: "A", jobHeading: "T", ...flags }],
  });
  const ref = (flags: Record<string, unknown>, list: "interest" | "viewed") => mapJobs(data(flags), 0, list)[0]!.referralType;
  expect(ref({}, "interest")).toBe("recommendPost");
  expect(ref({}, "viewed")).toBe("smpRecommend");
  expect(ref({ isAiScouted: true }, "viewed")).toBe("aiScout");
  expect(ref({ isHrtechScouted: true, isAiScouted: true }, "interest")).toBe("manualScouted");
  expect(ref({ isInterviewCommitOffer: true }, "interest")).toBe("manualScouted");
  expect(ref({ disclosureLevelCode: "4" }, "viewed")).toBe("recommendPost");
  // 一覧の種類が分からなければ決めない
  expect(mapJobs(data({}))[0]!.referralType).toBeNull();
});

test("mapJobs: getMyJoboffers の joboffers[] と非公開年収", () => {
  const jobs = mapJobs({
    joboffers: [
      { jobofferManagementNo: "1", corpName: "A", jobHeading: "T", annualIncome: { isConfidential: true, min: 1, max: 2 } },
    ],
    hasNextPage: false,
  });
  expect(jobs.map(({ raw, ...j }) => j)).toEqual([job({ id: "1", company: "A", title: "T" })]);
});

test("applyFilter: 残す企業 > 除外企業 > 低上限のリーダー職、重複は除外", () => {
  const jobs = [
    job({ id: "a", company: "ＸＹＺ株式会社", title: "SE" }),
    job({ id: "b", company: "株式会社キープ商事", title: "リーダー", salaryMax: 800 }),
    job({ id: "c", company: "某社", title: "プロジェクトマネージャー", salaryMax: 1000 }),
    job({ id: "d", company: "某社", title: "シニアプロジェクトマネージャー", salaryMax: 1200 }),
    job({ id: "e", company: "ダブり工業", title: "Web エンジニア" }),
    job({ id: "f", company: "ダブり工業", title: "Web エンジニア" }),
  ];
  const { kept, excluded } = applyFilter(jobs, {
    keepCompanies: ["キープ商事"],
    excludeCompanies: ["XYZ"],
    excludeLowCeilingRoles: { titleKeywords: ["リーダー", "マネージャー", "PM"], salaryMaxAtMost: 1000 },
  });
  expect(kept.map((j) => j.id)).toEqual(["b", "d", "e"]);
  expect(excluded.map((e) => [e.job.id, e.reason])).toEqual([
    ["a", "company: XYZ"],
    ["c", 'role "マネージャー" with salaryMax 1000 <= 1000'],
    ["f", "duplicate of e"],
  ]);
});

test("applyFilter: 英字キーワードは単語境界で照合する", () => {
  const rules = { excludeTitles: ["PM"], excludeCompanies: ["ABC"] };
  const { kept, excluded } = applyFilter(
    [
      job({ id: "a", company: "X", title: "Software Development Engineer" }),
      job({ id: "b", company: "X", title: "PM（Web）" }),
      job({ id: "c", company: "ABCコンサルティング合同会社", title: "SE" }),
    ],
    rules,
  );
  expect(kept.map((j) => j.id)).toEqual(["a"]);
  expect(excluded.map((e) => e.reason)).toEqual(["title: PM", "company: ABC"]);
});

test("parseTargets: 行区切り・配列・filter 出力（重複除外は対象外、紹介経路と表示用の項目は引き継ぎ、raw は捨てる）", () => {
  expect(parseTargets("J1\nJ2  J3\n")).toEqual([{ id: "J1" }, { id: "J2" }, { id: "J3" }]);
  expect(parseTargets('["J1", {"id": "J2", "sourceType": "day0", "i2aTstamp": "1"}]')).toEqual([
    { id: "J1" },
    { id: "J2", sourceType: "day0", referralType: "i2aJobAssessmentAfterRecommend", i2aTstamp: "1" },
  ]);
  expect(
    parseTargets(
      JSON.stringify({
        kept: [{ id: "K" }],
        excluded: [
          { job: { id: "X", company: "XYZ株式会社", sourceType: "postday0", i2aTstamp: "9", raw: {} }, reason: "company: XYZ" },
          { job: { id: "K" }, reason: "duplicate of K" },
        ],
      }),
    ),
  ).toEqual([
    { id: "X", company: "XYZ株式会社", sourceType: "postday0", referralType: "i2aJobAxisRecommend", i2aTstamp: "9" },
  ]);
});

test("runSequential: 個別失敗は続行、セッション切れで打ち切り、重複 ID は1回", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const results = await runSequential(
    [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }],
    async ({ id }) => {
      if (id === "b") throw new Error("求人を非表示にできませんでした");
    },
    { intervalMs: 700, sleep },
  );
  expect(results).toEqual([
    { id: "a", ok: true },
    { id: "b", ok: false, error: "求人を非表示にできませんでした" },
    { id: "c", ok: true },
  ]);
  expect(sleeps).toEqual([700, 700]);

  const seen: string[] = [];
  const run = runSequential(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    async ({ id }) => {
      seen.push(id);
      if (id === "b") throw new SessionExpiredError("test");
    },
    { intervalMs: 0, sleep },
  );
  expect(run).rejects.toBeInstanceOf(SessionExpiredError);
  await run.catch(() => {});
  expect(seen).toEqual(["a", "b"]);
});
