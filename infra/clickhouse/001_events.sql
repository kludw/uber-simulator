-- Every event of every run (ADR 0029). Redelivered messages share
-- stream_seq, so ReplacingMergeTree collapses them; exact queries use FINAL.
CREATE TABLE IF NOT EXISTS events (
  run_id      LowCardinality(String),
  type        LowCardinality(String),
  tick        UInt32,
  stream_seq  UInt64,
  trip_id     String,
  driver_id   LowCardinality(String),
  rider_id    String,
  payload     String,
  ingested_at DateTime
) ENGINE = ReplacingMergeTree
ORDER BY (run_id, type, tick, stream_seq)
