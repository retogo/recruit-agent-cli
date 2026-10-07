import type { Transformer } from "./store.ts";

export interface ParsedCurl {
  url: URL;
  method: string;
  /** ヘッダー名は小文字 */
  headers: Record<string, string>;
  cookie: string | null;
  body: string | null;
}

/**
 * 再生しても意味がない、fetch が自分で付ける、またはリクエストの種類（ページ遷移か API か）で
 * 変わるヘッダー。ページを開いたときの cURL から取り込んでも API 呼び出しに混ざらないようにする。
 */
const DROP_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "accept-encoding",
  "connection",
  "cookie",
  "priority",
  "cache-control",
  "upgrade-insecure-requests",
]);

/**
 * DevTools の「Copy as cURL (bash)」をトークンに分割する。
 * '...'、"..."、$'...'、行末の \ 継続に対応する。
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  const s = input.replace(/\\\r?\n/g, " ");

  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const [text, len] = ansiEscape(s, i + 1);
          cur += text;
          i += 1 + len;
        } else cur += s[i++];
      }
      i++;
      has = true;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? s.length : end + 1;
      has = true;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) {
          cur += s[i + 1];
          i += 2;
        } else cur += s[i++];
      }
      i++;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
      has = true;
    } else {
      cur += c;
      i++;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

/** 「Copy as cURL (cmd)」の形か。`^"` で囲み、行末の `^` で継続する */
export function isCmdFormat(input: string): boolean {
  return /\^"/.test(input) || /\^\r?\n/.test(input);
}

/**
 * 「Copy as cURL (cmd)」をトークンに分割する。
 * まず cmd のエスケープ（`^X` → X、行末の `^` は継続）を外し、残りを Windows の argv 規則
 * （`"` で囲む、`\"` は文字としての `"`）で分ける。
 */
export function tokenizeCmd(input: string): string[] {
  let s = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c !== "^") {
      s += c;
      continue;
    }
    const next = input[i + 1];
    if (next === "\r" && input[i + 2] === "\n") {
      s += " ";
      i += 2;
    } else if (next === "\n") {
      s += " ";
      i += 1;
    } else if (next !== undefined) {
      s += next;
      i += 1;
    }
  }

  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === '"') {
      cur += '"';
      i++;
      has = true;
    } else if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

function ansiEscape(s: string, at: number): [string, number] {
  const c = s[at]!;
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
  if (c in simple) return [simple[c]!, 1];
  if (c === "u") return [String.fromCodePoint(Number.parseInt(s.slice(at + 1, at + 5), 16)), 5];
  if (c === "x") return [String.fromCharCode(Number.parseInt(s.slice(at + 1, at + 3), 16)), 3];
  return [`\\${c}`, 1];
}

export function parseCurl(input: string): ParsedCurl {
  const text = input.trim();
  const tokens = isCmdFormat(text) ? tokenizeCmd(text) : tokenize(text);
  // 「Copy all as cURL (cmd)」の区切りの & が末尾に残ることがある
  while (tokens.at(-1) === "&") tokens.pop();
  if (tokens[0] !== "curl" && tokens[0] !== "curl.exe") throw new Error("cURL コマンドではありません（先頭が curl ではない）");

  let url: string | null = null;
  let method: string | null = null;
  const headers: Record<string, string> = {};
  let cookie: string | null = null;
  let body: string | null = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = () => tokens[++i] ?? "";
    switch (t) {
      case "-H":
      case "--header": {
        const h = next();
        const colon = h.indexOf(":");
        if (colon <= 0) break;
        const name = h.slice(0, colon).trim().toLowerCase();
        const value = h.slice(colon + 1).trim();
        if (name === "cookie") cookie = value;
        else headers[name] = value;
        break;
      }
      case "-b":
      case "--cookie":
        cookie = next();
        break;
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        body = next();
        break;
      case "-X":
      case "--request":
        method = next().toUpperCase();
        break;
      case "--url":
        url = next();
        break;
      default:
        if (!t.startsWith("-") && url === null) url = t;
    }
  }

  if (!url) throw new Error("cURL から URL を取り出せませんでした");
  return {
    url: new URL(url),
    method: method ?? (body !== null ? "POST" : "GET"),
    headers,
    cookie,
    body,
  };
}

/** セッションとして保存する追加ヘッダーだけを残す */
export function replayableHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !DROP_HEADERS.has(name) && !name.startsWith(":") && !name.startsWith("sec-fetch-"),
    ),
  );
}

export interface CapturedCall {
  procedure: string;
  method: string;
  /** transformer の包みを外した入力 */
  input: unknown;
}

/** tRPC バッチ呼び出しの cURL から、procedure ごとの入力と transformer を取り出す */
export function extractTrpcCalls(parsed: ParsedCurl): { calls: CapturedCall[]; transformer: Transformer | null } {
  const m = parsed.url.pathname.match(/\/api\/trpc\/(.+)$/);
  if (!m) return { calls: [], transformer: null };
  const procedures = decodeURIComponent(m[1]!).split(",");

  let rawInputs: Record<string, unknown> = {};
  if (parsed.method === "GET") {
    const q = parsed.url.searchParams.get("input");
    if (q) rawInputs = JSON.parse(q);
  } else if (parsed.body) {
    rawInputs = JSON.parse(parsed.body);
  }

  let transformer: Transformer | null = null;
  const calls = procedures.map((procedure, idx) => {
    const raw = rawInputs[String(idx)];
    let input = raw;
    if (raw && typeof raw === "object" && "json" in raw) {
      transformer = "superjson";
      input = (raw as { json: unknown }).json;
    } else if (raw !== undefined && transformer === null) {
      transformer = "none";
    }
    return { procedure, method: parsed.method, input };
  });
  return { calls, transformer };
}
