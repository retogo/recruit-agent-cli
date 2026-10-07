import { expect, test } from "bun:test";
import type { Session } from "../src/adapters/driven/session/store.ts";
import { mapApplication } from "../src/adapters/driven/trpc/applied-mapper.ts";
import { TrpcClient } from "../src/adapters/driven/trpc/client.ts";
import { DEFAULT_PROCEDURES } from "../src/adapters/driven/trpc/procedures.ts";
import { TrpcRecruitAgent } from "../src/adapters/driven/trpc/recruit-agent.ts";

test("mapApplication: 面接中の1件（実応答の形、値はダミー）", () => {
  const a = mapApplication(
    {
      selectionStages: "InterviewProcess",
      jobofferManagementNo: 100,
      contractGenerationNo: 8,
      companyName: "A社",
      jobTitle: "AIエンジニア",
      selectionName: "1次選考(Web面接)",
      interviewAdjstTstamp: "2030-01-15T10:00:00+09:00",
      scheduleAdjustCode: "ScheduleFixed",
      timeRequired: 60,
      scheduleAdjustInfoNo: 555,
      isUnSeen: true,
    },
    "interviews",
  );
  expect(a).toEqual({
    id: "100",
    generationNo: "8",
    company: "A社",
    title: "AIエンジニア",
    status: "interviews",
    stage: "1次選考(Web面接)",
    stageCode: "InterviewProcess",
    interviewAt: "2030-01-15T10:00:00+09:00",
    durationMin: 60,
    scheduleCode: "ScheduleFixed",
    result: null,
    closedAt: null,
    unseen: true,
    scheduleNo: "555",
  });
});

test("applied: GET で type を送り、nextPageToken をたどって全件を返す", async () => {
  const session: Session = { cookie: "s=1", headers: {}, transformer: "none", importedAt: "test" };
  const inputs: unknown[] = [];
  const item = (n: number) => ({ jobofferManagementNo: n, contractGenerationNo: 1, companyName: `C${n}`, jobTitle: "T" });
  const fetchFn = async (url: string | URL | Request) => {
    const input = JSON.parse(new URL(String(url)).searchParams.get("input")!)["0"];
    inputs.push(input);
    const page = input.nextPageToken
      ? { list: [item(3)], count: 3 }
      : { list: [item(1), item(2)], count: 3, nextPageToken: "TOKEN" };
    return Response.json([{ result: { data: page } }]);
  };
  const port = new TrpcRecruitAgent(new TrpcClient(session, fetchFn), DEFAULT_PROCEDURES);
  const list = await port.applied("document_screening");
  expect(list.map((a) => a.id)).toEqual(["1", "2", "3"]);
  expect(inputs).toEqual([
    { type: "document_screening" },
    { type: "document_screening", nextPageToken: "TOKEN" },
  ]);
});

test("interview: scheduleAdjustInfoNo を文字列で送り、モーダルの項目を正規化する（値はダミー）", async () => {
  const session: Session = { cookie: "s=1", headers: {}, transformer: "none", importedAt: "test" };
  const inputs: unknown[] = [];
  const fetchFn = async (url: string | URL | Request) => {
    inputs.push(JSON.parse(new URL(String(url)).searchParams.get("input")!)["0"]);
    return Response.json([
      {
        result: {
          data: {
            corporateName: "A社",
            jobHeading: "AIエンジニア",
            selectionName: "1次選考(Web面接)",
            scheduleAdjust: { scheduleAdjustCode: "ScheduleFixed", interviewAdjustFixDate: "2030-01-15T10:00:00+09:00" },
            interviewStartRangeTime: [
              { interviewStartRangeFromTstamp: "2030-01-15T10:00:00+09:00", interviewStartRangeToTstamp: "2030-01-15T10:00:00+09:00" },
            ],
            timeRequired: 60,
            visitPlace: "Web面接",
            visitPerson: "https://meet.example.com/xxx",
            visitPlaceDetail: "接続方法",
            interviewer: "面接官",
            emergencyAddress: "contact@example.com",
            selectionContents: "選考内容",
            selectionPoint: "対策メモ",
            otherInfo: "その他",
            lastUpdateTstamp: "2030-01-10T09:00:00+09:00",
          },
        },
      },
    ]);
  };
  const port = new TrpcRecruitAgent(new TrpcClient(session, fetchFn), DEFAULT_PROCEDURES);
  const i = await port.interview("555");
  expect(inputs).toEqual([{ scheduleAdjustInfoNo: "555" }]);
  expect(i).toEqual({
    scheduleNo: "555",
    company: "A社",
    title: "AIエンジニア",
    stage: "1次選考(Web面接)",
    fixedAt: "2030-01-15T10:00:00+09:00",
    startRanges: [{ from: "2030-01-15T10:00:00+09:00", to: "2030-01-15T10:00:00+09:00" }],
    durationMin: 60,
    scheduleCode: "ScheduleFixed",
    place: "Web面接",
    visitTo: "https://meet.example.com/xxx",
    placeDetail: "接続方法",
    interviewer: "面接官",
    emergencyContact: "contact@example.com",
    contents: "選考内容",
    advice: "対策メモ",
    otherInfo: "その他",
    updatedAt: "2030-01-10T09:00:00+09:00",
  });
});
