import { expect, test } from "bun:test";
import { mergeSetCookies, type Session } from "../src/adapters/driven/session/store.ts";
import { TrpcClient } from "../src/adapters/driven/trpc/client.ts";

test("mergeSetCookies: 値の更新・追加・削除", () => {
  const merged = mergeSetCookies("session=old; keep=1; gone=x", [
    "session=new; Path=/; Expires=Thu, 08 Oct 2026 15:09:20 GMT; HttpOnly; Secure",
    "added=2; Max-Age=31536000; Path=/",
    "gone=; Max-Age=0; Path=/",
  ]);
  expect(merged).toBe("session=new; keep=1; added=2");
});

test("mergeSetCookies: Set-Cookie が無ければそのまま", () => {
  expect(mergeSetCookies("a=1; b=2", [])).toBe("a=1; b=2");
});

test("TrpcClient: 応答の Set-Cookie で Cookie を更新し、次のリクエストと保存に使う", async () => {
  const sent: string[] = [];
  const saved: Session[] = [];
  let n = 0;
  const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push((init?.headers as Record<string, string>).cookie ?? "");
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("set-cookie", `session=v${++n}; Path=/; HttpOnly`);
    return new Response(JSON.stringify([{ result: { data: { ok: true } } }]), { headers });
  };
  const session: Session = { cookie: "session=v0; other=1", headers: {}, transformer: "none", importedAt: "test" };
  const client = new TrpcClient(session, fetchFn, "https://example.test", async (s) => void saved.push(s));

  await client.call("a.b", {}, "GET");
  await client.call("a.b", {}, "GET");

  expect(sent).toEqual(["session=v0; other=1", "session=v1; other=1"]);
  expect(saved.map((s) => s.cookie)).toEqual(["session=v1; other=1", "session=v2; other=1"]);
  expect(saved[0]?.refreshedAt).toBeString();
});
