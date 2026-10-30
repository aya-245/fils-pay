import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import {
  CalendarCheckIcon,
  ChartIcon,
  LinkIcon,
  LogOutIcon,
  MenuIcon,
  ReceiptIcon,
  ScaleIcon,
  WebhookIcon,
} from "./Icons.js";
import "../dashboard.css";

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile drawer whenever a link is followed.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  const brand = (
    <div className="dash-brand">
      <span className="dash-brand-mark" aria-hidden="true">
        F
      </span>
      FilsPay
    </div>
  );

  return (
    <div className={navOpen ? "dash-shell is-nav-open" : "dash-shell"}>
      <a className="dash-skip-link" href="#dash-main">
        Skip to content
      </a>

      <div className="dash-topbar">
        {brand}
        <button
          type="button"
          className="dash-icon-button"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((open) => !open)}
        >
          <MenuIcon />
        </button>
      </div>

      <header className="dash-header">
        {brand}
        {me ? (
          <div className="dash-merchant-card">
            <div className="dash-merchant-card-label">Merchant</div>
            <div className="dash-merchant-card-name" title={me.merchant.displayName}>
              {me.merchant.displayName}
            </div>
          </div>
        ) : null}
        <nav className="dash-nav" aria-label="Dashboard">
          <NavLink to="/dashboard/overview">
            <ChartIcon /> Overview
          </NavLink>
          <NavLink to="/dashboard/transactions">
            <ReceiptIcon /> Transactions
          </NavLink>
          <NavLink to="/dashboard/payment-links">
            <LinkIcon /> Payment links
          </NavLink>
          <NavLink to="/dashboard/settlement">
            <CalendarCheckIcon /> Settlement
          </NavLink>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/reconciliation">
              <ScaleIcon /> Reconciliation
            </NavLink>
            <NavLink to="/dashboard/webhooks">
              <WebhookIcon /> Webhooks
            </NavLink>
          </RequireRole>
        </nav>
        <div className="dash-identity">
          {me ? (
            <>
              <span className="dash-avatar" aria-hidden="true">
                {me.email.slice(0, 2)}
              </span>
              <span className="dash-identity-text">
                <span className="dash-identity-email" title={me.email}>
                  {me.email}
                </span>
                <span className="dash-role-chip">{me.role}</span>
              </span>
            </>
          ) : (
            <span className="dash-identity-text" />
          )}
          <button
            type="button"
            className="dash-icon-button"
            aria-label="Log out"
            title="Log out"
            onClick={() => void handleSignOut()}
          >
            <LogOutIcon />
          </button>
        </div>
      </header>

      <main className="dash-main" id="dash-main" tabIndex={-1}>
        {error ? (
          <p className="dash-error" role="alert">
            {error}
          </p>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
