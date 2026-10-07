import { MaintenanceError, SessionExpiredError } from "../ports/driven/recruit-agent.ts";

export interface ItemResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface BulkOptions {
  /** 呼び出し間隔。約0.7秒間隔で60件連続しても制限はかからなかった */
  intervalMs: number;
  onProgress?: (r: ItemResult, index: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 求人ごとに順番に操作する。個別の失敗（例：特定求人だけ非表示にできない）は記録して続け、
 * セッション切れのときだけ残りを打ち切る。同じ ID は最初の1件だけ処理する。
 */
export async function runSequential<T extends { id: string }>(
  items: T[],
  op: (item: T) => Promise<unknown>,
  opts: BulkOptions,
): Promise<ItemResult[]> {
  const sleep = opts.sleep ?? Bun.sleep;
  const unique = [...new Map(items.map((x) => [x.id, x])).values()];
  const results: ItemResult[] = [];

  for (const [i, item] of unique.entries()) {
    if (i > 0) await sleep(opts.intervalMs);
    let r: ItemResult;
    try {
      await op(item);
      r = { id: item.id, ok: true };
    } catch (e) {
      if (e instanceof SessionExpiredError || e instanceof MaintenanceError) throw e;
      r = { id: item.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    results.push(r);
    opts.onProgress?.(r, i, unique.length);
  }
  return results;
}
