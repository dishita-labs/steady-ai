-- Steady: SingleStore schema. Apply with `aube run db:migrate`.
--
-- Three tables, because the free shared tier allows 10 per database (see src/lib/recorder/tables.ts).
-- Every row keeps the full domain entity in `body`, plus a few typed columns copied out of it
-- for filtering. Reads use `body`.
-- Audit events are append-only: the app never UPDATEs or DELETEs them.
-- SHARD KEY (case_id) keeps all of one case's rows on one partition.

CREATE TABLE IF NOT EXISTS cases (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  workflow_run_id VARCHAR(128),
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

-- Every per-case collection: kind is the CollectionName (images, hazards, questions,
-- requirements, candidates, evidence, classifications, decisions, actions).
-- status is that kind's main state field (ITEM_STATUS in tables.ts), or NULL.
CREATE TABLE IF NOT EXISTS case_items (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  status VARCHAR(32),
  body JSON NOT NULL,
  PRIMARY KEY (case_id, kind, id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  at DATETIME(6) NOT NULL,
  type VARCHAR(48) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id),
  KEY (case_id, at)
);
