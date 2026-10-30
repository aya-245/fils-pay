import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError, WEB_BASE_URL } from "../api/client.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";
import {
  CalendarCheckIcon,
  CoinsIcon,
  LogOutIcon,
  MenuIcon,
  StoreIcon,
  UploadIcon,
  WebhookIcon,
} from "./Icons.js";

/** Nav shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile drawer whenever a link is followed.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  const brand = (
    <div className="admin-brand">
      <span className="admin-brand-mark" aria-hidden="true">
        F
      </span>
      <span>
        FilsPay
        <small>Admin console</small>
      </span>
    </div>
  );

  return (
    <div className={navOpen ? "admin-shell is-nav-open" : "admin-shell"}>
      <ImpersonationBanner />

      <div className="admin-topbar">
        {brand}
        <button
          type="button"
          className="admin-icon-button"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((open) => !open)}
        >
          <MenuIcon />
        </button>
      </div>

      <aside className="admin-sidebar">
        {brand}
        <div className="admin-nav-label">Operations</div>
        <nav className="admin-nav" aria-label="Admin">
          <NavLink to="/merchants">
            <StoreIcon /> Merchants
          </NavLink>
          <NavLink to="/credits">
            <CoinsIcon /> Credits
          </NavLink>
          <NavLink to="/settlement">
            <CalendarCheckIcon /> Settlement ops
          </NavLink>
          <NavLink to="/adjustment-imports">
            <UploadIcon /> Import adjustments
          </NavLink>
          <NavLink to="/webhooks">
            <WebhookIcon /> Webhook replay
          </NavLink>
        </nav>

        <div className="admin-identity">
          {admin ? (
            <>
              <span className="admin-avatar" aria-hidden="true">
                {admin.email.slice(0, 2)}
              </span>
              <span className="admin-identity-text">
                <span className="admin-identity-email" title={admin.email}>
                  {admin.email}
                </span>
                <span className="admin-role-chip">{admin.role.replace(/_/g, " ")}</span>
              </span>
            </>
          ) : (
            <span className="admin-identity-text" />
          )}
          <button
            type="button"
            className="admin-icon-button"
            aria-label="Log out"
            title="Log out"
            onClick={() => void handleSignOut()}
          >
            <LogOutIcon />
          </button>
        </div>
      </aside>

      {impersonation ? (
        // An explicit "exit view-as-merchant" action is required before
        // admin-plane screens are shown again. This is a UX safeguard so the
        // two modes are never confused on screen; the privilege boundary
        // itself does not depend on it — /v1/admin/* never reads the
        // impersonation cookie, and the merchant side never reads the admin
        // session cookie.
        <main className="admin-main">
          {error ? <p className="admin-error">{error}</p> : null}
          <h1>Admin screens are paused</h1>
          <p>
            An impersonation grant is active. Use <strong>Exit impersonation</strong> above to end it
            and return to the admin console.
          </p>
          <p>
            Merchant screens are at <code>{WEB_BASE_URL}</code> while the grant lasts.
          </p>
        </main>
      ) : (
        <main className="admin-main">
          {error ? <p className="admin-error">{error}</p> : null}
          <Outlet />
        </main>
      )}
    </div>
  );
}
