-- lifetime_net_payout_monitoring_estimate was REAL (float4, 24-bit mantissa).
-- Above ~16,777,216 fils (~16,777 BD) each "+ net payout" is rounded away,
-- so high-volume merchants' lifetime estimate drifts and then stops moving.
-- Money is integer fils (ADR-0001).
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;
