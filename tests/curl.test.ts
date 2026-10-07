import { expect, test } from "bun:test";
import { extractTrpcCalls, parseCurl, replayableHeaders, tokenize } from "../src/adapters/driven/session/curl.ts";

// Chrome の「Copy as cURL (bash)」の形。値はダミー
const CURL = String.raw`curl 'https://mypage.r-agent.com/api/trpc/rmpLogging.sendLog,features.activities.notApplications?batch=1' \
  -H 'accept: */*' \
  -H 'content-type: application/json' \
  -b 'session=abc; other=1' \
  -H 'x-csrf-token: tok123' \
  -H 'content-length: 99' \
  --data-raw $'{"0":{"json":{"event":"click"}},"1":{"json":{"jobofferId":"J001","memo":"it\'s"}}}'`;

test("tokenize: 各種クォートと行継続", () => {
  expect(tokenize(`curl 'a b' "c\\"d" $'e\\nf' g\\ h`)).toEqual(["curl", "a b", 'c"d', "e\nf", "g h"]);
});

test("parseCurl: URL・ヘッダー・cookie・ボディを取り出す", () => {
  const p = parseCurl(CURL);
  expect(p.method).toBe("POST");
  expect(p.url.pathname).toBe("/api/trpc/rmpLogging.sendLog,features.activities.notApplications");
  expect(p.cookie).toBe("session=abc; other=1");
  expect(p.headers["x-csrf-token"]).toBe("tok123");
  expect(replayableHeaders(p.headers)).toEqual({ "x-csrf-token": "tok123" });
});

test("extractTrpcCalls: superjson の包みを外して procedure ごとに分ける", () => {
  const { calls, transformer } = extractTrpcCalls(parseCurl(CURL));
  expect(transformer).toBe("superjson");
  expect(calls[1]).toEqual({
    procedure: "features.activities.notApplications",
    method: "POST",
    input: { jobofferId: "J001", memo: "it's" },
  });
});

// Chrome の「Copy as cURL (cmd)」の形。値はダミー
const CMD = [
  'curl --url ^"https://mypage.r-agent.com/recommend^" ^',
  '  -H ^"accept: text/html^" ^',
  '  -b ^"a=1; d=2026-09-20T15^%^3A27; m=id:010^&token:x; h=^[^{^\\^"1080^\\^":1^}^]; g=s1^$o19^" ^',
  '  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"154^\\^", ^\\^"Not A^(Brand^\\^";v=^\\^"99^\\^"^" ^',
  '  -H ^"sec-fetch-dest: document^" ^',
  '  -H ^"user-agent: Mozilla/5.0 ^(Windows NT 10.0^)^"',
].join("\r\n");

test("parseCurl: cmd 形式のエスケープを外す", () => {
  const p = parseCurl(CMD);
  expect(p.method).toBe("GET");
  expect(p.url.toString()).toBe("https://mypage.r-agent.com/recommend");
  expect(p.cookie).toBe('a=1; d=2026-09-20T15%3A27; m=id:010&token:x; h=[{"1080":1}]; g=s1$o19');
  expect(p.headers["sec-ch-ua"]).toBe('"Chromium";v="154", "Not A(Brand";v="99"');
  expect(p.headers["user-agent"]).toBe("Mozilla/5.0 (Windows NT 10.0)");
  // ページ遷移用のヘッダーは API 呼び出しに持ち込まない
  expect(Object.keys(replayableHeaders(p.headers)).sort()).toEqual(["sec-ch-ua", "user-agent"]);
});

test("extractTrpcCalls: GET の input クエリ", () => {
  const input = encodeURIComponent(JSON.stringify({ "0": { json: { a: 1 } } }));
  const { calls } = extractTrpcCalls(
    parseCurl(`curl 'https://mypage.r-agent.com/api/trpc/features.activities.getMyJoboffers?batch=1&input=${input}' -H 'cookie: s=1'`),
  );
  expect(calls).toEqual([{ procedure: "features.activities.getMyJoboffers", method: "GET", input: { a: 1 } }]);
});
