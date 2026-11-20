-- Steady: SingleStore schema. DRAFT: not yet run against a cluster.
-- Apply with `aube run db:migrate`.
--
-- Every table keeps the full domain entity in `body` (see src/lib/recorder/tables.ts) plus a
-- few typed columns copied out of it for filtering. Reads use `body`.
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

CREATE TABLE IF NOT EXISTS uploaded_images (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  room VARCHAR(32) NOT NULL,
  analysis_status VARCHAR(16) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS hazard_findings (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  image_id VARCHAR(64) NOT NULL,
  category CHAR(3) NOT NULL,
  label VARCHAR(24) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS context_questions (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  requirement_id VARCHAR(64),
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS shopping_requirements (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  rule_id VARCHAR(64) NOT NULL,
  product_type VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  safety_critical BOOL NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS product_candidates (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  url TEXT NOT NULL,
  status VARCHAR(24) NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS product_evidence (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  source_url TEXT NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS product_classifications (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  requirement_id VARCHAR(64) NOT NULL,
  concern BOOL NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS constraint_decisions (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  requirement_id VARCHAR(64) NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  engine_version VARCHAR(32) NOT NULL,
  decided_at DATETIME(6) NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
  SHARD KEY (case_id)
);

CREATE TABLE IF NOT EXISTS shopping_actions (
  id VARCHAR(64) NOT NULL,
  case_id VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL,
  simulated BOOL NOT NULL,
  adapter VARCHAR(64) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  body JSON NOT NULL,
  PRIMARY KEY (id, case_id),
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
