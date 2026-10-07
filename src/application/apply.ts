import type { Job } from "../domain/job.ts";
import type { RecruitAgentPort } from "../ports/driven/recruit-agent.ts";

export interface ApplyOutcome {
  jobId: string;
  applied: boolean;
  result?: unknown;
}

/**
 * 応募は取り消せないので、求人の内容を見せたうえで人の確認が取れたときだけ送る。
 * confirm は対話端末からの入力に限る（CLI 側で TTY を強制する）。
 */
export async function applyWithConfirmation(
  port: RecruitAgentPort,
  job: Job,
  confirm: (job: Job) => Promise<boolean>,
): Promise<ApplyOutcome> {
  if (!(await confirm(job))) return { jobId: job.id, applied: false };
  const result = await port.apply(job);
  return { jobId: job.id, applied: true, result };
}
