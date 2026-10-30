-- total_processed_fils was INTEGER (max 2,147,483,647 fils = 2,147,483.647 BD),
-- which overflows on CloseBatch and sits barely above the 2,000,000,000 fils
-- volume-tier threshold. ADR-0001: money columns are BIGINT.
ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;
