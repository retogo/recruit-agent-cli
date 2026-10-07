import { expect, test } from "bun:test";
import type { Session } from "../src/adapters/driven/session/store.ts";
import { TrpcClient } from "../src/adapters/driven/trpc/client.ts";
import { DEFAULT_PROCEDURES } from "../src/adapters/driven/trpc/procedures.ts";
import { TrpcRecruitAgent } from "../src/adapters/driven/trpc/recruit-agent.ts";
import { buildSearchFilter } from "../src/domain/search.ts";

test("buildSearchFilter: 検索ページの requestPayload と同じ形にする", () => {
  expect(
    buildSearchFilter({
      keyword: " 生成AI LLM ",
      occupations: ["110", "1111", "69462"],
      industries: ["1100", "1101"],
      prefectures: ["13", "8"],
      incomeMin: 800,
    }),
  ).toEqual({
    keyword: { and: "生成AI LLM" },
    occupations: [{ lv1_num: 110 }, { lv2_num: 1111 }, { occupation_id: "69462" }],
    industries: [{ lv1_id: "1100" }, { lv2_id: "1101" }],
    locations: [
      { location_type: "prefecture", prefecture_code: "13" },
      { location_type: "prefecture", prefecture_code: "08" },
    ],
    annual_income: { under: 8_000_000 },
  });
  expect(buildSearchFilter({ keyword: "  " })).toEqual({});
});

test("searchJobs: MQ== から始めて next_page_token をたどり、max で打ち切る。紹介経路は jobSearch", async () => {
  const session: Session = { cookie: "s=1", headers: {}, transformer: "none", importedAt: "test" };
  const bodies: Record<string, unknown>[] = [];
  const job = (n: number) => ({
    jobofferManagementNo: String(n),
    contractGenerationNo: "1",
    corpName: `C${n}`,
    jobHeading: "T",
    offices: [{ prefectureCityName: "東京都港区" }, { prefectureCityName: "東京都港区" }, { prefectureCityName: "大阪府大阪市" }],
  });
  const fetchFn = async (_: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))["0"];
    bodies.push(body);
    const page = body.page_token === "MQ==" ? [job(1), job(2)] : [job(3), job(4)];
    return Response.json([{ result: { data: { total_count: 9, next_page_token: "Mg==", jobdescriptions: page } } }]);
  };
  const port = new TrpcRecruitAgent(new TrpcClient(session, fetchFn), DEFAULT_PROCEDURES);
  const { total, jobs } = await port.searchJobs({ keyword: { and: "AI" } }, { sort: "newest", max: 3 });
  expect(total).toBe(9);
  expect(jobs.map((j) => j.id)).toEqual(["1", "2", "3"]);
  expect(jobs[0]!.referralType).toBe("jobSearch");
  expect(jobs[0]!.location).toBe("東京都港区、大阪府大阪市");
  expect(bodies).toEqual([
    { filter: { keyword: { and: "AI" } }, page_token: "MQ==", limit: 100, sort: "newest" },
    { filter: { keyword: { and: "AI" } }, page_token: "Mg==", limit: 100, sort: "newest" },
  ]);
});
