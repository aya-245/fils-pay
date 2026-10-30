import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import "../dashboard.css";

/** Shown for an unknown URL and for anything a route throws while
 *  rendering — instead of React Router's bare "Unexpected Application
 *  Error!" screen. Deliberately dependency-free (no auth context), because
 *  it can render above the dashboard's providers. */
export function RouteError(props: { notFound?: boolean }) {
  const error = useRouteError();
  const notFound = props.notFound === true || (isRouteErrorResponse(error) && error.status === 404);

  return (
    <main className="dash-centered dash-error-page">
      <div className="dash-brand">
        <span className="dash-brand-mark" aria-hidden="true">
          F
        </span>
        FilsPay
      </div>
      <p className="dash-error-code">{notFound ? "404" : "Error"}</p>
      <h1>{notFound ? "Page not found" : "Something went wrong"}</h1>
      <p className="dash-muted">
        {notFound
          ? "That address doesn't match any page. If you followed a payment link, check it was copied in full."
          : "This page hit an unexpected problem. Reloading usually fixes it; if not, sign in again."}
      </p>
      <div className="dash-actions">
        <Link className="dash-button-link dash-button-primary" to="/dashboard">
          Go to dashboard
        </Link>
        {!notFound ? (
          <button type="button" className="dash-button" onClick={() => window.location.reload()}>
            Reload
          </button>
        ) : null}
      </div>
    </main>
  );
}
