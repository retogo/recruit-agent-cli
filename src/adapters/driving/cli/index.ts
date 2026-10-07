import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { applyWithConfirmation } from "../../../application/apply.ts";
import { runSequential } from "../../../application/bulk.ts";
import { APPLIED_STATUSES, type Application, type AppliedStatus } from "../../../domain/application.ts";
import { applyFilter, type FilterRules } from "../../../domain/filter.ts";
import { buildSearchFilter, SEARCH_SORTS, type SearchSort } from "../../../domain/search.ts";
import type { Job, JobRef } from "../../../domain/job.ts";
import {
  type HttpMethod,
  MY_JOBS_TYPES,
  type MyJobsType,
  ProcedureError,
  type RecruitAgentPort,
  MaintenanceError,
  SessionExpiredError,
} from "../../../ports/driven/recruit-agent.ts";
import { extractTrpcCalls, parseCurl, replayableHeaders } from "../../driven/session/curl.ts";
import { configDir, loadSession, saveSession, writePrivate } from "../../driven/session/store.ts";
import { BASE_URL, TrpcClient } from "../../driven/trpc/client.ts";
import { loadProcedures, proceduresPath } from "../../driven/trpc/procedures.ts";
import { TrpcRecruitAgent } from "../../driven/trpc/recruit-agent.ts";
import { referralTypeOf } from "../../driven/trpc/referral.ts";

const USAGE = `ra — 求人ポスト（mypage.r-agent.com）の非公式 CLI

認証
  ra auth import-curl [FILE]          DevTools の「Copy as cURL」（複数可）を取り込む。FILE 省略時は stdin
  ra auth status                      セッションが生きているか確認

求人
  ra recommend [--pages N] [--filter | --rules FILE] [--with-raw] [--raw] [--out FILE]
                                      おすすめ求人（1ページ25件、既定4ページ＝画面と同じ最大100件）
                                      --filter で {kept, excluded} を返す（ルールは --rules、省略時は設定ディレクトリの filters.json）
  ra hide [ID...] [--stdin] [--interval MS] [--dry-run] [--log-only]
                                      興味なし（連続実行は既定 700ms 間隔）。おすすめ一覧から外す行動ログも送る
                                      --stdin は ID の行・JSON 配列・ra recommend --filter の出力（excluded を対象）
                                      --log-only は行動ログだけを送る（非表示にしたのに一覧に残る求人の修復用）
  ra unhide [ID...] [--stdin]         興味なしの取り消し
  ra interest [ID...] [--stdin]       気になるに登録
  ra uninterest [ID...] [--stdin]     気になるを解除
  ra mine --type viewed|interest|not_applied
                                      閲覧済み・気になる・興味なしの一覧（50件ずつ全ページ）
  ra show ID [--raw] [--out FILE] [--referral R --generation N]
                                      求人詳細（仕事内容・必須スキル・勤務条件・企業情報・選考）
                                      おすすめ一覧・気になる一覧・選考状況にある求人のみ。開くと閲覧済み・既読になる
  ra applied [--status S] [--with-detail] [--out FILE]
                                      選考状況（S は document_screening / interviews / closed、省略時は全部）
                                      --with-detail で詳細ページから年収・職種・勤務地・年間休日を足す
  ra interview [ID...] [--out FILE]   面接詳細（日時・場所・会議 URL・面接官・選考内容・対策メモ）
                                      ID は求人 ID か日程調整番号。省略時は面接中のものすべてを日時順に
  ra similar ID                       類似求人
  ra search [--keyword W] [--occ CODES] [--ind CODES] [--pref CODES] [--income 万円]
            [--sort relevance|newest] [--max N] [--count] [--filter JSON] [--out FILE]
                                      求人検索（100件ずつ最大 N 件、既定100）。--count は件数だけ
                                      CODES はカンマ区切り。職種 110=IT・1111=サーバーサイド、都道府県 13=東京
  ra apply ID [--yes]                 応募。対話端末では求人 ID を打ち直したら送信。--yes（-y）なら確認なしで送信

ローカル処理・調査
  ra filter [--rules FILE] [--in FILE]   求人 JSON（stdin）をルールで絞る
  ra call PROCEDURE [--get] [--input JSON]  任意の tRPC procedure を呼ぶ
  ra page PATH                        ページの __NEXT_DATA__ を取り出す
  ra procedures                       使用中の procedure 定義と取り込み済みサンプル

設定は ${configDir()} に置く（RA_HOME で変更可）。
`;

const log = (msg: string) => process.stderr.write(`${msg}\n`);

async function output(data: unknown, out?: string): Promise<void> {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (out) {
    await Bun.write(out, text);
    log(`wrote ${out}`);
  } else {
    // process.stdout.write は直後の process.exit でパイプへの大きな出力が切れるため、書き終わりを待つ
    await Bun.write(Bun.stdout, text);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("stdin から入力を渡してください");
  return await Bun.stdin.text();
}

async function readJsonFile<T>(path: string): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path} がありません`);
  return (await file.json()) as T;
}

/**
 * 操作対象を、行区切りの ID・JSON 配列（ID 文字列 or 求人）・ra recommend --filter の出力のどれからでも受け取る。
 * filter の出力なら excluded を対象にする。ただし重複による除外は元の求人と同じ ID のことがあるので外す。
 * 求人の JSON なら referralType（なければ sourceType から決める）/ i2aTstamp / tracking も引き継ぐ。
 * ID だけのときは後でおすすめ一覧・気になる一覧から補う。
 */
export function parseTargets(text: string): Partial<Job>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return trimmed.split(/\s+/).map((id) => ({ id }));
  }
  let data = JSON.parse(trimmed);
  if (!Array.isArray(data)) data = data.excluded ?? data.kept ?? data.jobs ?? [];
  return (data as unknown[]).flatMap((x): Partial<Job>[] => {
    if (typeof x === "string" || typeof x === "number") return [{ id: String(x) }];
    const o = x as Partial<Job> & { job?: Partial<Job>; reason?: string };
    if (o.reason?.startsWith("duplicate")) return [];
    const { raw, ...job } = o.job ?? o;
    if (!job.id) return [];
    if (job.referralType === undefined && job.sourceType !== undefined) {
      job.referralType = referralTypeOf(job.sourceType) ?? null;
    }
    return [job];
  });
}

/** 求人 ID から表示用の情報と紹介経路を引く表。おすすめ一覧を優先し、なければ気になる一覧を見る */
async function lookupJobs(port: RecruitAgentPort, ids: string[]): Promise<Map<string, Job>> {
  const known = new Map<string, Job>();
  log("おすすめ一覧から紹介経路を取得しています…");
  for (const job of stripRaw((await port.recommendJobs(4)).jobs)) known.set(job.id, job);
  if (ids.some((id) => !known.has(id))) {
    log("気になる一覧から紹介経路を取得しています…");
    for (const job of stripRaw((await port.myJobs("interest")).jobs)) if (!known.has(job.id)) known.set(job.id, job);
  }
  if (ids.some((id) => !known.has(id))) {
    log("選考状況から紹介経路を取得しています…");
    for (const status of APPLIED_STATUSES) {
      for (const a of await port.applied(status)) if (!known.has(a.id)) known.set(a.id, applicationAsJob(a));
    }
  }
  return known;
}

/**
 * 応募した求人を、詳細ページを開ける Job の形にする。
 * 選考状況の画面は詳細へのリンクに job_referral=recommendPost と generation_no を付けている。
 * 応募済みなので興味なし・気になるの対象にはならない想定。
 */
function applicationAsJob(a: Application): Job {
  return {
    id: a.id,
    company: a.company,
    title: a.title,
    salaryMin: null,
    salaryMax: null,
    location: null,
    closed: a.status === "closed",
    sourceType: null,
    referralType: "recommendPost",
    i2aTstamp: null,
    generationNo: a.generationNo,
    tracking: null,
  };
}

/**
 * 紹介経路や表示情報が分からない対象を、おすすめ一覧・気になる一覧から補う。
 * 見つからなければ null のまま（紹介経路が要る操作はエラーになり、行動ログは送らない）。
 */
async function resolveTargets(port: RecruitAgentPort, targets: Partial<Job>[]): Promise<Job[]> {
  const missing = (t: Partial<Job>) => t.referralType === undefined || t.tracking === undefined;
  const known = targets.some(missing) ? await lookupJobs(port, targets.map((t) => t.id!)) : new Map<string, Job>();
  return targets.map((t) => {
    const hit = known.get(t.id!);
    if (missing(t) && hit) return hit;
    return {
      id: t.id!,
      company: t.company ?? hit?.company ?? "",
      title: t.title ?? hit?.title ?? "",
      salaryMin: t.salaryMin ?? hit?.salaryMin ?? null,
      salaryMax: t.salaryMax ?? hit?.salaryMax ?? null,
      location: t.location ?? hit?.location ?? null,
      closed: t.closed ?? hit?.closed ?? false,
      sourceType: t.sourceType ?? hit?.sourceType ?? null,
      referralType: t.referralType ?? null,
      i2aTstamp: t.i2aTstamp ?? null,
      generationNo: t.generationNo ?? hit?.generationNo ?? null,
      tracking: t.tracking ?? null,
    };
  });
}

/** 詳細ページのデータのうち、求人の中身ではないもの（A/B テスト・ログ・画面制御） */
const DETAIL_NOISE = [
  "__deviceTypeDefaultState",
  "__loginSucceeded",
  "abTestData",
  "applyWithJobExtraParameter",
  "extraParameter",
  "forceBackToDefaultPath",
  "interestedJobIds",
  "isDisplayConfirmApplyDialogForEntryWithJob",
  "isDisplayConfirmApplyDialogForJobApply",
  "isDisplayConfirmDialog",
  "isScoutAcceptanceConfirmationTarget",
  "matchingCriteriaData",
  "referer",
  "requestId",
  "rmpLogPageViewData",
];

/** 詳細ページから、選考状況の一覧に足りない項目（年収・職種・勤務地・休日）を抜き出す */
function detailSummary(d: Record<string, unknown>) {
  const p = d as {
    workCondition?: {
      salary?: { annualIncome?: { min?: number | null; max?: number | null }; unpublishedAnnualIncome?: boolean };
      dayoffAnnualDayCount?: number | null;
    };
    jobRequirements?: { occupations?: string[] };
    workLocation?: { offices?: { prefectureCityName?: string }[] };
  };
  const income = p.workCondition?.salary?.annualIncome;
  return {
    salaryMin: income?.min ?? null,
    salaryMax: income?.max ?? null,
    salaryUnpublished: p.workCondition?.salary?.unpublishedAnnualIncome === true,
    occupations: p.jobRequirements?.occupations ?? [],
    locations: [...new Set((p.workLocation?.offices ?? []).map((o) => o.prefectureCityName).filter(Boolean))],
    annualHolidays: p.workCondition?.dayoffAnnualDayCount ?? null,
  };
}

async function applied(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      status: { type: "string" },
      "with-detail": { type: "boolean" },
      interval: { type: "string", default: "700" },
      out: { type: "string" },
    },
  });
  const status = values.status as AppliedStatus | undefined;
  if (status !== undefined && !APPLIED_STATUSES.includes(status)) {
    throw new Error(`--status は ${APPLIED_STATUSES.join(" / ")} のどれかです`);
  }
  const port = await connect();
  const list: Application[] = [];
  for (const s of status ? [status] : APPLIED_STATUSES) list.push(...(await port.applied(s)));
  log(
    APPLIED_STATUSES.map((s) => `${s} ${list.filter((a) => a.status === s).length}`).join(" / "),
  );
  if (!values["with-detail"]) {
    await output(list, values.out);
    return 0;
  }

  // 詳細ページを1件ずつ開いて年収などを足す。失敗した求人は detailError に理由を残して続ける
  const interval = Number(values.interval);
  const enriched: (Application & Record<string, unknown>)[] = [];
  for (const [i, a] of list.entries()) {
    if (i > 0) await Bun.sleep(interval);
    try {
      enriched.push({ ...a, ...detailSummary(await port.jobDetail(applicationAsJob(a))) });
      log(`[${i + 1}/${list.length}] ${a.company}`);
    } catch (e) {
      if (e instanceof SessionExpiredError || e instanceof MaintenanceError) throw e;
      const detailError = e instanceof Error ? e.message : String(e);
      enriched.push({ ...a, detailError });
      log(`[${i + 1}/${list.length}] ${a.company} NG: ${detailError}`);
    }
  }
  await output(enriched, values.out);
  return 0;
}

/**
 * 面接詳細。引数なしなら面接中のものすべて、求人 ID か日程調整番号を渡せばそれだけ。
 * 会議 URL・面接官・緊急連絡先を含むので、--out でファイルに書くときも共有しないこと。
 */
async function interview(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const port = await connect();
  const scheduled = (await port.applied("interviews")).filter((a) => a.scheduleNo);
  const targets = positionals.length
    ? positionals.map((key) => {
        const hit = scheduled.find((a) => a.id === key || a.scheduleNo === key);
        if (!hit) throw new Error(`${key} は面接中の求人 ID・日程調整番号に見つかりません`);
        return hit;
      })
    : scheduled;

  const result = [];
  for (const a of targets) result.push({ jobId: a.id, ...(await port.interview(a.scheduleNo!)) });
  result.sort((x, y) => (x.fixedAt ?? "9").localeCompare(y.fixedAt ?? "9"));
  log(`${result.length} 件`);
  if (values.out) {
    // 会議 URL や連絡先を含むので、自分だけが読める権限で書く
    await writePrivate(values.out, result);
    log(`wrote ${values.out} (0600)`);
  } else {
    await output(result);
  }
  return 0;
}

async function show(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      raw: { type: "boolean" },
      out: { type: "string" },
      referral: { type: "string" },
      generation: { type: "string" },
    },
  });
  const id = positionals[0];
  if (!id) throw new Error("求人 ID を指定してください");
  const port = await connect();
  // 検索結果など一覧にない求人は、紹介経路と版番号を直接渡せば開ける（ra search の出力の referralType / generationNo）
  const [job] =
    values.referral && values.generation
      ? await resolveTargets(port, [
          { id, referralType: values.referral, generationNo: values.generation, i2aTstamp: null, tracking: null },
        ])
      : await resolveTargets(port, [{ id }]);
  if (!job?.referralType) {
    log(
      `求人 ${id} がおすすめ一覧・気になる一覧・選考状況に見つからないため、詳細ページの URL を組み立てられません。` +
        "検索結果の求人なら --referral jobSearch --generation <版番号> を付けてください",
    );
    return 1;
  }
  const detail = await port.jobDetail(job);
  const shown = values.raw ? detail : Object.fromEntries(Object.entries(detail).filter(([k]) => !DETAIL_NOISE.includes(k)));
  await output(shown, values.out);
  return 0;
}

function stripRaw(jobs: Job[]): Job[] {
  return jobs.map(({ raw, ...rest }) => rest);
}

async function connect(): Promise<RecruitAgentPort> {
  const session = await loadSession();
  if (!session) throw new SessionExpiredError("セッション未登録");
  // RA_COOKIE で渡したセッションはファイルに書き戻さない
  const persist = session.importedAt === "env:RA_COOKIE" ? undefined : async (s: typeof session) => void (await saveSession(s));
  return new TrpcRecruitAgent(new TrpcClient(session, fetch, BASE_URL, persist), await loadProcedures());
}

async function defaultRules(path?: string): Promise<FilterRules | null> {
  if (path) return readJsonFile<FilterRules>(path);
  const fallback = join(configDir(), "filters.json");
  return (await Bun.file(fallback).exists()) ? readJsonFile<FilterRules>(fallback) : null;
}

// ---- commands ----

async function authImportCurl(args: string[]): Promise<number> {
  const text = args[0] ? await Bun.file(args[0]).text() : await readStdin();
  // 「Copy all as cURL」は複数の curl を改行や ; で並べる
  const chunks = text.split(/(?:^|\n|;\s*\n?)\s*(?=curl\s)/).filter((c) => c.trim().startsWith("curl"));
  if (chunks.length === 0) throw new Error("curl コマンドが見つかりません");

  const samples: string[] = [];
  let saved: string | null = null;
  for (const chunk of chunks) {
    const parsed = parseCurl(chunk);
    const { calls, transformer } = extractTrpcCalls(parsed);
    if (!saved && parsed.cookie && parsed.url.hostname.endsWith("r-agent.com")) {
      saved = await saveSession({
        cookie: parsed.cookie,
        headers: replayableHeaders(parsed.headers),
        transformer: transformer ?? "none",
        importedAt: new Date().toISOString(),
      });
    }
    for (const c of calls) {
      if (c.procedure === "rmpLogging.sendLog") continue;
      const path = join(configDir(), "samples", `${c.procedure}.json`);
      await writePrivate(path, { ...c, capturedAt: new Date().toISOString() });
      samples.push(c.procedure);
    }
  }

  await output({ session: saved, samples });
  if (!saved) log("cookie 付きの r-agent.com へのリクエストが無かったため、セッションは更新していません");
  return 0;
}

async function authStatus(): Promise<number> {
  const session = await loadSession();
  if (!session) {
    await output({ ok: false, reason: "セッション未登録" });
    return 1;
  }
  const { jobs } = await (await connect()).recommendJobs(1);
  await output({ ok: true, importedAt: session.importedAt, refreshedAt: (await loadSession())?.refreshedAt, transformer: session.transformer, recommendCount: jobs.length });
  return 0;
}

async function recommend(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pages: { type: "string", default: "4" },
      filter: { type: "boolean" },
      rules: { type: "string" },
      "with-raw": { type: "boolean" },
      raw: { type: "boolean" },
      out: { type: "string" },
    },
  });
  const pages = Number(values.pages);
  if (!Number.isInteger(pages) || pages < 1) throw new Error("--pages は1以上の整数です");
  const { jobs, raw } = await (await connect()).recommendJobs(pages);
  if (values.raw) return output(raw, values.out).then(() => 0);
  if (jobs.length === 0) log("求人配列を見つけられませんでした。--raw で応答を確認してください");

  const shown = values["with-raw"] ? jobs : stripRaw(jobs);
  if (values.filter || values.rules) {
    const rules = await defaultRules(values.rules);
    if (!rules) throw new Error("--rules か ~/.config/recruit-agent-cli/filters.json が必要です");
    const result = applyFilter(shown, rules);
    log(`kept ${result.kept.length} / excluded ${result.excluded.length}`);
    await output(result, values.out);
  } else {
    await output(shown, values.out);
  }
  return 0;
}

async function bulk(
  argv: string[],
  name: string,
  /** 紹介経路（sourceType / i2aTstamp）が要る操作か */
  needsReferral: boolean,
  pick: (port: RecruitAgentPort) => (job: JobRef) => Promise<unknown>,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stdin: { type: "boolean" },
      interval: { type: "string", default: "700" },
      "dry-run": { type: "boolean" },
    },
  });
  const targets = [
    ...positionals.map((id) => ({ id })),
    ...(values.stdin ? parseTargets(await readStdin()) : []),
  ];
  if (targets.length === 0) throw new Error("求人 ID を指定してください");

  const port = await connect();
  const jobs: JobRef[] = needsReferral
    ? await resolveTargets(port, targets)
    : targets.map((t) => ({ id: t.id!, referralType: null, i2aTstamp: null, tracking: null }));
  if (values["dry-run"]) {
    await output({ action: name, dryRun: true, targets: [...new Map(jobs.map((j) => [j.id, j])).values()] });
    return 0;
  }

  const results = await runSequential(jobs, pick(port), {
    intervalMs: Number(values.interval),
    onProgress: (r, i, total) => log(`[${i + 1}/${total}] ${name} ${r.id} ${r.ok ? "ok" : `NG: ${r.error}`}`),
  });
  const failed = results.filter((r) => !r.ok).length;
  await output({ action: name, ok: results.length - failed, failed, results });
  return failed > 0 ? 1 : 0;
}

/**
 * 応募。確認の方法は2通り。
 * - 対話端末: 求人の内容を見せ、求人 ID を打ち直したら送る
 * - `--yes`（`-y`）: 入力なしで送る（パイプ・エージェントからも可）
 * 応募後の取り消しは担当アドバイザーへの連絡で行う。
 */
async function apply(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { yes: { type: "boolean", short: "y" } },
  });
  const id = positionals[0];
  if (!id) throw new Error("求人 ID を指定してください");
  const confirmed = values.yes === true;
  if (!confirmed && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    log("対話端末ではないため確認できません。送る場合は --yes を付けてください");
    return 2;
  }
  if ((await loadProcedures()).apply.status === "guessed") {
    log("応募の入力の形が未検証です。実際の応募リクエストを取り込み、procedures.json の apply を設定してから実行してください");
    return 2;
  }
  const port = await connect();
  const [job] = await resolveTargets(port, [{ id }]);
  if (!job?.referralType) {
    log(`求人 ${id} がおすすめ一覧・気になる一覧・選考状況に見つからないため、紹介経路を決められません`);
    return 1;
  }
  const outcome = await applyWithConfirmation(port, job, async (j) => {
    const salary = `${j.salaryMin ?? "?"}〜${j.salaryMax ?? ""}万円`;
    log(`\n応募先: ${j.company}\n求人:   ${j.title}\n年収:   ${salary}\n勤務地: ${j.location ?? "-"}\n`);
    if (confirmed) return true;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`本当に応募する場合は求人 ID（${j.id}）を入力してください: `);
    rl.close();
    return answer.trim() === j.id;
  });
  if (!outcome.applied) log("応募を中止しました");
  await output(outcome);
  return outcome.applied ? 0 : 1;
}

async function filter(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { rules: { type: "string" }, in: { type: "string" } } });
  const rules = await defaultRules(values.rules);
  if (!rules) throw new Error("--rules か ~/.config/recruit-agent-cli/filters.json が必要です");
  const text = values.in ? await Bun.file(values.in).text() : await readStdin();
  let data = JSON.parse(text);
  if (!Array.isArray(data)) data = data.kept ?? data.jobs;
  const result = applyFilter(data as Job[], rules);
  log(`kept ${result.kept.length} / excluded ${result.excluded.length}`);
  await output(result);
  return 0;
}

async function call(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { get: { type: "boolean" }, input: { type: "string" } },
  });
  const procedure = positionals[0];
  if (!procedure) throw new Error("procedure 名を指定してください");
  const method: HttpMethod = values.get ? "GET" : "POST";
  const input = values.input === undefined ? undefined : JSON.parse(values.input);
  await output(await (await connect()).call(procedure, input, method));
  return 0;
}

async function search(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      keyword: { type: "string" },
      occ: { type: "string" },
      ind: { type: "string" },
      pref: { type: "string" },
      income: { type: "string" },
      sort: { type: "string" },
      max: { type: "string", default: "100" },
      count: { type: "boolean" },
      filter: { type: "string" },
      "with-raw": { type: "boolean" },
      out: { type: "string" },
    },
  });
  const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
  const filter: Record<string, unknown> = values.filter
    ? JSON.parse(values.filter)
    : buildSearchFilter({
        keyword: values.keyword,
        occupations: list(values.occ),
        industries: list(values.ind),
        prefectures: list(values.pref),
        incomeMin: values.income ? Number(values.income) : undefined,
      });
  if (Object.keys(filter).length === 0) throw new Error("検索条件を1つ以上指定してください（--keyword / --occ / --ind / --pref / --income / --filter）");
  const sort = values.sort as SearchSort | undefined;
  if (sort !== undefined && !SEARCH_SORTS.includes(sort)) throw new Error(`--sort は ${SEARCH_SORTS.join(" / ")} のどれかです`);
  const max = Number(values.max);
  if (!Number.isInteger(max) || max < 1) throw new Error("--max は1以上の整数です");

  const port = await connect();
  if (values.count) {
    await output({ filter, total: await port.countJobs(filter) });
    return 0;
  }
  const { total, jobs } = await port.searchJobs(filter, { sort, max });
  log(`${total} 件中 ${jobs.length} 件`);
  await output(values["with-raw"] ? jobs : stripRaw(jobs), values.out);
  return 0;
}

async function mine(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { type: { type: "string" } } });
  const type = values.type as MyJobsType | undefined;
  if (!type || !MY_JOBS_TYPES.includes(type)) throw new Error(`--type は ${MY_JOBS_TYPES.join(" / ")} のどれかです`);
  const { jobs } = await (await connect()).myJobs(type);
  await output(stripRaw(jobs));
  return 0;
}

async function procedures(): Promise<number> {
  const samplesDir = join(configDir(), "samples");
  const samples = await readdir(samplesDir).catch(() => [] as string[]);
  await output({
    overrideFile: proceduresPath(),
    procedures: await loadProcedures(),
    samples: samples.map((f) => join(samplesDir, f)),
  });
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv.slice(2);
  try {
    switch (cmd) {
      case "auth":
        if (rest[0] === "import-curl") return await authImportCurl(rest.slice(1));
        if (rest[0] === "status") return await authStatus();
        break;
      case "recommend":
        return await recommend(rest);
      case "hide":
        if (rest.includes("--log-only")) {
          const args = rest.filter((a) => a !== "--log-only");
          return await bulk(args, "not_apply_log", true, (p) => (j) => p.notApplyLog(j));
        }
        return await bulk(rest, "hide", true, (p) => (j) => p.hide(j));
      case "unhide":
        return await bulk(rest, "unhide", false, (p) => (j) => p.unhide(j.id));
      case "interest":
        return await bulk(rest, "interest", true, (p) => (j) => p.interest(j));
      case "uninterest":
        return await bulk(rest, "uninterest", true, (p) => (j) => p.uninterest(j));
      case "show":
        return await show(rest);
      case "applied":
        return await applied(rest);
      case "interview":
        return await interview(rest);
      case "similar": {
        if (!rest[0]) throw new Error("求人 ID を指定してください");
        const { jobs, raw } = await (await connect()).similarJobs(rest[0]);
        await output(jobs.length ? stripRaw(jobs) : raw);
        return 0;
      }
      case "search":
        return await search(rest);
      case "mine":
        return await mine(rest);
      case "apply":
        return await apply(rest);
      case "filter":
        return await filter(rest);
      case "call":
        return await call(rest);
      case "page":
        if (!rest[0]) throw new Error("パスを指定してください");
        await output(await (await connect()).nextData(rest[0]));
        return 0;
      case "procedures":
        return await procedures();
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        return 0;
    }
    log(`不明なコマンド: ${[cmd, ...rest].join(" ")}\n`);
    process.stderr.write(USAGE);
    return 64;
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      log(e.message);
      return 3;
    }
    if (e instanceof MaintenanceError) {
      log(e.message);
      return 4;
    }
    if (e instanceof ProcedureError) {
      log(e.message);
      if (e.detail !== undefined) log(JSON.stringify(e.detail, null, 2));
      return 1;
    }
    log(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
