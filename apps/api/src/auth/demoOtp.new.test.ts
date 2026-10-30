import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, shouldExposeOtp } from "../config.js";

const base = {
  DATABASE_URL: "postgres://unused",
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};

test("production never exposes an OTP unless the account is on an allow-listed demo domain", () => {
  const prod = { otpDevExpose: false, otpDemoEmailDomains: ["alpharetail.example", "filspay.test"] };
  assert.equal(shouldExposeOtp(prod, "owner@alpharetail.example"), true);
  assert.equal(shouldExposeOtp(prod, "finance@filspay.test"), true);
  assert.equal(shouldExposeOtp(prod, "owner@ALPHARETAIL.EXAMPLE"), true);
  assert.equal(shouldExposeOtp(prod, "owner@realbank.com"), false);
  assert.equal(shouldExposeOtp(prod, "owner@alpharetail.example.com"), false, "suffix tricks don't match");
  assert.equal(shouldExposeOtp(prod, "owner@evilalpharetail.example"), false, "must be the domain or a subdomain");
  assert.equal(shouldExposeOtp(prod, "not-an-email"), false);
  assert.equal(shouldExposeOtp({ otpDevExpose: false, otpDemoEmailDomains: [] }, "owner@alpharetail.example"), false);
});

test("OTP_DEMO_EMAIL_DOMAINS only accepts reserved TLDs, so real domains can't be exposed by mistake", () => {
  const ok = loadConfig({ ...base, OTP_DEMO_EMAIL_DOMAINS: "alpharetail.example, filspay.test" });
  assert.deepEqual(ok.otpDemoEmailDomains, ["alpharetail.example", "filspay.test"]);
  assert.throws(() => loadConfig({ ...base, OTP_DEMO_EMAIL_DOMAINS: "gmail.com" }), /not a reserved demo domain/);
  assert.deepEqual(loadConfig(base).otpDemoEmailDomains, []);
});
