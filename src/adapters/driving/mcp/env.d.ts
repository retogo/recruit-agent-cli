import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env {
    /** OAuthProvider が defaultHandler に渡す */
    OAUTH_PROVIDER: OAuthHelpers;
  }
}
