import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, verifyOtp } from "../../api/auth.js";
import { describeError } from "../../api/client.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import type { AdminLoginResponse } from "../../types.js";
import { CheckIcon } from "../../components/Icons.js";

type Step =
  | { kind: "credentials" }
  | { kind: "otp"; challenge: AdminLoginResponse };

/**
 * Two-step admin login: email + password creates a *pending* session
 * and issues an OTP challenge; the OTP step is what actually authenticates
 * it. Neither step is told which half of a bad credential pair was wrong —
 * the API answers a single generic `invalid_credentials`, and this screen
 * repeats it verbatim rather than guessing at something more specific.
 */
export function LoginPage() {
  const { status, refresh } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectTo =
    (location.state as { from?: string } | null)?.from ?? "/merchants";

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const challenge = await login({ email, password });
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // YA: admin verify re-issues the cookie with the full TTL
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await verifyOtp({ code });
      // The session cookie is now authenticated server-side; re-read `me`
      // so the rest of the console renders from the server's answer, not
      // from the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-login">
      <aside className="admin-login-aside">
        <div className="admin-brand">
          <span className="admin-brand-mark" aria-hidden="true">
            F
          </span>
          <span>
            FilsPay
            <small>Admin console</small>
          </span>
        </div>
        <div>
          <h2>Operations, settlement and merchant care in one place.</h2>
          <p>Every money-adjacent action here is role-gated server-side and written to the admin audit log.</p>
          <ul className="admin-login-points">
            <li>
              <CheckIcon /> Two-step sign-in with a one-time code
            </li>
            <li>
              <CheckIcon /> Maker-checker approval for large credits
            </li>
            <li>
              <CheckIcon /> Read-only, audited merchant impersonation
            </li>
          </ul>
        </div>
        <div className="admin-login-foot">Internal use only &middot; Asia/Bahrain business day</div>
      </aside>

      <main className="admin-login-panel">
        <div className="admin-login-card">
      <h1>{step.kind === "credentials" ? "Sign in" : "Check your code"}</h1>
      <p className="admin-muted">
        {step.kind === "credentials"
          ? "Internal operations console."
          : "Enter the one-time code to finish signing in."}
      </p>

      {error ? <p className="admin-error">{error}</p> : null}

      {step.kind === "credentials" ? (
        <form onSubmit={(e) => void handleCredentials(e)} className="admin-form">
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "Signing in..." : "Continue"}
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => void handleOtp(e)} className="admin-form">
          <p>
            A one-time code was issued for <strong>{email}</strong>. It expires at{" "}
            {new Date(step.challenge.otpExpiresAt).toLocaleTimeString()}.
          </p>
          {step.challenge.devOtpCode ? (
            <p className="admin-muted">
              Development code: <code>{step.challenge.devOtpCode}</code>
            </p>
          ) : null}
          <label>
            One-time code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="admin-otp-input"
              maxLength={12}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "Verifying..." : "Verify"}
          </button>
          <button
            type="button"
            className="admin-link-button"
            onClick={() => {
              setStep({ kind: "credentials" });
              setCode("");
              setError(null);
            }}
          >
            Start over
          </button>
        </form>
      )}
        </div>
      </main>
    </div>
  );
}
