type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const TONES: Record<string, Tone> = {
  active: "ok",
  approved: "ok",
  passed: "ok",
  live: "ok",
  posted: "ok",
  paid: "ok",
  succeeded: "ok",
  submitted: "info",
  under_review: "warn",
  pending: "warn",
  pending_approval: "warn",
  open: "warn",
  test: "info",
  rejected: "danger",
  suspended: "danger",
  failed: "danger",
  exhausted: "danger",
  disabled: "neutral",
  closed: "neutral",
  "not passed": "neutral",
};

/** A status pill. The tone comes from the value itself, so every screen
 *  colours "approved" or "suspended" the same way; the text is the value
 *  with underscores spaced out. */
export function Badge({ value, tone }: { value: string; tone?: Tone }) {
  const resolved = tone ?? TONES[value] ?? "neutral";
  const className = resolved === "neutral" ? "admin-badge" : `admin-badge admin-badge-${resolved}`;
  return <span className={className}>{value.replace(/_/g, " ")}</span>;
}
