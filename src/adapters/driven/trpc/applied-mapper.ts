import type { Application, AppliedStatus, Interview } from "../../../domain/application.ts";

/** pages.applied.getApplied の list[] の1件。タブごとに入る項目が違う */
interface ApiApplication {
  jobofferManagementNo: number | string;
  contractGenerationNo: number | string;
  companyName: string;
  jobTitle: string;
  selectionName?: string | null;
  selectionStages?: string | null;
  interviewAdjstTstamp?: string | null;
  timeRequired?: number | null;
  scheduleAdjustCode?: string | null;
  selectionStatusCode?: string | null;
  notPassedDate?: string | null;
  isUnSeen?: boolean;
  scheduleAdjustInfoNo?: number | string | null;
}

/** features.interview.getInterviewInfo の応答 */
export interface ApiInterview {
  corporateName?: string;
  jobHeading?: string;
  lastUpdateTstamp?: string | null;
  scheduleAdjust?: { scheduleAdjustCode?: string | null; interviewAdjustFixDate?: string | null };
  interviewStartRangeTime?: { interviewStartRangeFromTstamp?: string; interviewStartRangeToTstamp?: string }[];
  timeRequired?: number | null;
  selectionName?: string | null;
  visitPlace?: string | null;
  visitPlaceDetail?: string | null;
  visitPerson?: string | null;
  emergencyAddress?: string | null;
  selectionContents?: string | null;
  interviewer?: string | null;
  selectionPoint?: string | null;
  otherInfo?: string | null;
}

export function mapInterview(api: ApiInterview, scheduleNo: string): Interview {
  return {
    scheduleNo,
    company: api.corporateName ?? "",
    title: api.jobHeading ?? "",
    stage: api.selectionName ?? null,
    fixedAt: api.scheduleAdjust?.interviewAdjustFixDate ?? null,
    startRanges: (api.interviewStartRangeTime ?? []).flatMap((r) =>
      r.interviewStartRangeFromTstamp && r.interviewStartRangeToTstamp
        ? [{ from: r.interviewStartRangeFromTstamp, to: r.interviewStartRangeToTstamp }]
        : [],
    ),
    durationMin: api.timeRequired ?? null,
    scheduleCode: api.scheduleAdjust?.scheduleAdjustCode ?? null,
    place: api.visitPlace ?? null,
    visitTo: api.visitPerson ?? null,
    placeDetail: api.visitPlaceDetail ?? null,
    interviewer: api.interviewer ?? null,
    emergencyContact: api.emergencyAddress ?? null,
    contents: api.selectionContents ?? null,
    advice: api.selectionPoint ?? null,
    otherInfo: api.otherInfo ?? null,
    updatedAt: api.lastUpdateTstamp ?? null,
  };
}

export interface AppliedPage {
  list: ApiApplication[];
  count?: number;
  nextPageToken?: string | null;
}

export function mapApplication(api: ApiApplication, status: AppliedStatus): Application {
  return {
    id: String(api.jobofferManagementNo),
    generationNo: String(api.contractGenerationNo),
    company: api.companyName,
    title: api.jobTitle,
    status,
    stage: api.selectionName ?? null,
    stageCode: api.selectionStages ?? null,
    interviewAt: api.interviewAdjstTstamp ?? null,
    durationMin: api.timeRequired ?? null,
    scheduleCode: api.scheduleAdjustCode ?? null,
    result: api.selectionStatusCode ?? null,
    closedAt: api.notPassedDate ?? null,
    unseen: api.isUnSeen === true,
    scheduleNo: api.scheduleAdjustInfoNo == null ? null : String(api.scheduleAdjustInfoNo),
  };
}
