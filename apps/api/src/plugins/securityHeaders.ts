import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface SecurityHeadersOptions {
  /** Send Strict-Transport-Security on every response. Set from
   *  config.cookieSecure (true in production): if cookies are Secure the
   *  deployment is HTTPS-only. HSTS is also sent on any request that arrived
   *  over https (request.protocol honours X-Forwarded-Proto via trustProxy). */
  hsts: boolean;
}

const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/**
 * Baseline response headers for a JSON API (OWASP API8: security
 * misconfiguration). The API never serves HTML meant to render, so the CSP
 * forbids everything: this also neutralises a stored-XSS attempt through an
 * uploaded KYC file served back by routes/kyc.ts.
 *
 * Cache-Control: every /v1 response that doesn't choose its own caching is
 * `no-store` — they carry merchant data, session state or Set-Cookie and
 * must never sit in a shared or browser cache.
 */
export const securityHeaders = fp<SecurityHeadersOptions>(async (app: FastifyInstance, opts) => {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    if (opts.hsts || request.protocol === "https") {
      reply.header("strict-transport-security", HSTS_VALUE);
    }
    if (request.url.startsWith("/v1/") && !reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
});
