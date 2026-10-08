import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { KvSessionStore } from "../../driven/session/kv.ts";
import { BASE_URL, TrpcClient } from "../../driven/trpc/client.ts";
import { DEFAULT_PROCEDURES } from "../../driven/trpc/procedures.ts";
import { TrpcRecruitAgent } from "../../driven/trpc/recruit-agent.ts";
import { handleAuthorize } from "./authorize.ts";
import { createMcpServer } from "./mcp-server.ts";
import { RecruitAgentTools } from "./tools.ts";

const MCP_ROUTE = "/mcp";
const AUTHORIZE_PATH = "/authorize";
const SCOPE = "jobs";

function toolsFor(env: Env): RecruitAgentTools {
  return new RecruitAgentTools({
    store: new KvSessionStore(env.SESSION_KV),
    connect: (session, onRefresh) =>
      new TrpcRecruitAgent(
        new TrpcClient(session, (input, init) => fetch(input, init), BASE_URL, async (s) => onRefresh(s)),
        DEFAULT_PROCEDURES,
      ),
  });
}

const apiHandler = {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createMcpServer(toolsFor(env)), { route: MCP_ROUTE })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

const defaultHandler = {
  async fetch(request, env) {
    if (new URL(request.url).pathname === AUTHORIZE_PATH) {
      return handleAuthorize(request, {
        helpers: env.OAUTH_PROVIDER,
        ownerPassword: env.AUTH_PASSWORD,
        limiter: env.AUTHORIZE_LIMITER,
      });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const providers = new Map<string, OAuthProvider<Env>>();

/** resource はデプロイ先の URL で決まるので、リクエストの origin ごとに作る */
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_ROUTE,
      apiHandler,
      defaultHandler,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: {
        resource: `${origin}${MCP_ROUTE}`,
        authorization_servers: [origin],
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
  /**
   * ログインセッションは使うたびに 24 時間延びるので、数時間おきに使って切れないようにする。
   * 切れていたら何もしない（次に MCP から使ったときに import_session を案内する）
   */
  async scheduled(_controller, env) {
    const status = await toolsFor(env).sessionStatus();
    if (!status.ok) console.warn(`session keep-alive: ${status.reason}`);
  },
} satisfies ExportedHandler<Env>;
