import { join } from "node:path";
import { configDir } from "../session/store.ts";
import { type Action, DEFAULT_PROCEDURES, type ProcedureDef } from "./procedures.ts";

/** CLI 用。設定ディレクトリの procedures.json で既定の入力を上書きする（Worker は既定のまま使う） */
export const proceduresPath = () => join(configDir(), "procedures.json");

export async function loadProcedures(): Promise<Record<Action, ProcedureDef>> {
  const file = Bun.file(proceduresPath());
  if (!(await file.exists())) return DEFAULT_PROCEDURES;
  const overrides: Partial<Record<Action, Partial<ProcedureDef>>> = await file.json();
  const merged = { ...DEFAULT_PROCEDURES };
  for (const [action, def] of Object.entries(overrides) as [Action, Partial<ProcedureDef>][]) {
    if (!(action in DEFAULT_PROCEDURES)) throw new Error(`procedures.json: 未知のアクション "${action}"`);
    merged[action] = { ...DEFAULT_PROCEDURES[action], ...def, status: "override" };
  }
  return merged;
}
