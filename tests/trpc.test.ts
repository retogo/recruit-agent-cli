import { expect, test } from "bun:test";
import { TrpcClient } from "../src/adapters/driven/trpc/client.ts";
import { renderInput } from "../src/adapters/driven/trpc/procedures.ts";
import { MaintenanceError, ProcedureError, SessionExpiredError } from "../src/ports/driven/recruit-agent.ts";
import type { Session } from "../src/adapters/driven/session/store.ts";

const session: Session = {
  cookie: "session=abc",
  headers: { "x-csrf-token": "tok" },
  transformer: "superjson",
  importedAt: "test",
};

function fakeFetch(respond: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  };
  return { fn, calls };
}

test("POST: batch=1 で superjson に包み、cookie と追加ヘッダーを付ける", async () => {
  const f = fakeFetch(() => Response.json([{ result: { data: { json: { ok: true } } } }]));
  const client = new TrpcClient(session, f.fn);
  const res = await client.call("features.activities.notApplications", { jobofferId: "J1" }, "POST");

  expect(res).toEqual({ ok: true });
  const { url, init } = f.calls[0]!;
  expect(url.pathname).toBe("/api/trpc/features.activities.notApplications");
  expect(url.searchParams.get("batch")).toBe("1");
  expect(JSON.parse(String(init.body))).toEqual({ "0": { json: { jobofferId: "J1" } } });
  const headers = init.headers as Record<string, string>;
  expect(headers.cookie).toBe("session=abc");
  expect(headers["x-csrf-token"]).toBe("tok");
});

test("GET: input をクエリに載せる。undefined は superjson の undefined 表現", async () => {
  const f = fakeFetch(() => Response.json([{ result: { data: { json: [] } } }]));
  await new TrpcClient(session, f.fn).call("features.activities.getMyJoboffers", undefined, "GET");
  const input = JSON.parse(f.calls[0]!.url.searchParams.get("input")!);
  expect(input).toEqual({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } });
});

test("transformer none ならそのまま送る", async () => {
  const f = fakeFetch(() => Response.json([{ result: { data: 1 } }]));
  const res = await new TrpcClient({ ...session, transformer: "none" }, f.fn).call("p", { a: 1 }, "POST");
  expect(res).toBe(1);
  expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ "0": { a: 1 } });
});

test("エラー応答は ProcedureError、UNAUTHORIZED とリダイレクトは SessionExpiredError", async () => {
  const err = (json: unknown) => new TrpcClient(session, fakeFetch(() => Response.json([{ error: { json } }])).fn);
  expect(err({ message: "求人を非表示にできませんでした", data: { httpStatus: 500 } }).call("p", {}, "POST")).rejects.toBeInstanceOf(
    ProcedureError,
  );
  expect(err({ message: "x", data: { code: "UNAUTHORIZED", httpStatus: 401 } }).call("p", {}, "POST")).rejects.toBeInstanceOf(
    SessionExpiredError,
  );
  const redirect = new TrpcClient(
    session,
    fakeFetch(() => new Response(null, { status: 307, headers: { location: "/login" } })).fn,
  );
  expect(redirect.call("p", {}, "POST")).rejects.toBeInstanceOf(SessionExpiredError);
});

test("メンテナンス画面への転送は MaintenanceError（ログイン切れとは分ける）", async () => {
  const to = (location: string) =>
    new TrpcClient(session, fakeFetch(() => new Response(null, { status: 302, headers: { location } })).fn);
  expect(to("/maintenance.html").call("p", {}, "POST")).rejects.toBeInstanceOf(MaintenanceError);
  expect(to("/login").call("p", {}, "POST")).rejects.toBeInstanceOf(SessionExpiredError);
});

test("renderInput: プレースホルダの差し込み・数値化・欠けたキーの除去", () => {
  expect(renderInput({ id: "{{jobId}}", n: "{{jobId:number}}", q: "{{keyword}}", s: "x-{{jobId}}" }, { jobId: "42" })).toEqual({
    id: "42",
    n: 42,
    s: "x-42",
  });
  expect(renderInput(undefined, {})).toBeUndefined();
  expect(renderInput({ request_id: "{{requestId}}", page_token: "{{pageToken:nullable}}" }, { requestId: "r" })).toEqual({
    request_id: "r",
    page_token: null,
  });
  expect(renderInput({ filter: "{{filter:json}}" }, { filter: '{"a":[1]}' })).toEqual({ filter: { a: [1] } });
  expect(renderInput({ ok: true, n: 0 }, {})).toEqual({ ok: true, n: 0 });
  expect(renderInput({ ids: ["{{jobId}}"] }, { jobId: "1" })).toEqual({ ids: ["1"] });
});
