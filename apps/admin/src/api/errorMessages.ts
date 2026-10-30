/**
 * Operator-facing text for an admin-plane API error. Pure (no import.meta,
 * no fetch) so it can be unit-tested with `tsx --test`.
 *
 * The old banner for every 403 was "Not permitted (forbidden) — your admin
 * role does not allow this action." — true but useless: it dropped the
 * server's own explanation (e.g. "replaying succeeded deliveries requires
 * finance or super_admin") and never said what role *would* work.
 */
export function messageForAdminError(
  statusCode: number,
  code: string,
  body: { message?: string; [key: string]: unknown },
  role?: string | null,
): string {
  const serverMessage = body.message && body.message !== code ? body.message : null;
  switch (code) {
    case "merchant_balance_not_found":
      return "This merchant has no cached balance yet, so there is nothing to adjust. Run “Rebuild balances” in Settlement ops first.";
    case "merchant_not_found":
      return "No merchant with this id exists.";
    case "webhook_endpoint_not_found":
      return "That webhook endpoint no longer exists for this merchant.";
    case "unauthenticated":
      return "Your admin session has ended. Sign in again to continue.";
    case "invalid_credentials":
      return "Those details don't match an admin account.";
    case "invalid_code":
      return "That code isn't right. Check the latest code and try again.";
    case "otp_expired":
      return "That code has expired. Request a new one.";
    case "too_many_attempts":
      return "Too many incorrect codes. Sign in again to get a new code.";
    default:
      break;
  }
  if (statusCode === 403) {
    const who = role ? `Your role (${role.replace(/_/g, " ")})` : "Your admin role";
    return serverMessage
      ? `Not permitted: ${serverMessage}. ${who} can't do this — ask a finance or super admin.`
      : `Not permitted. ${who} can't do this — ask a finance or super admin.`;
  }
  if (statusCode >= 500) {
    return serverMessage ?? "The server could not complete this action. Nothing was changed — try again shortly.";
  }
  return serverMessage ?? code.replace(/_/g, " ");
}
