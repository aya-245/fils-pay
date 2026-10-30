import type { PaymentLinkDto } from "../../types.js";

/**
 * What the merchant should see for a link. The list endpoint returns the
 * *stored* status, and an expired link is still stored as `active` — so the
 * list used to show "active" next to an expiry in the past, for a link the
 * server now refuses to take payment on. Display only; filters still use the
 * stored status, exactly as the API does.
 */
export function displayLinkStatus(
  link: Pick<PaymentLinkDto, "status" | "expiresAt">,
  now: Date = new Date(),
): "active" | "reserved" | "paid" | "canceled" | "expired" {
  if ((link.status === "active" || link.status === "reserved") && new Date(link.expiresAt).getTime() <= now.getTime()) {
    return "expired";
  }
  return link.status;
}
