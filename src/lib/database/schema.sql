-- Steady: SingleStore schema. DRAFT: not yet run against a cluster.
-- One table per entity in src/types/domain.ts. Nested structures are stored as JSON.
-- Audit events are append-only: the app never UPDATEs or DELETEs them.

CREATE TABLE IF NOT EXISTS cases (
  id VARCHAR(64) PRIMARY KEY,
  stage VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  status_reason TEXT,
  household JSON,
  agent_session_id VARCHAR(128),
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL
);

CREATE TABLE IF NOT EXISTS uploaded_images (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type VARCHAR(32) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  width INT, height INT,
  room VARCHAR(32) NOT NULL,
  consent_confirmed BOOL NOT NULL,
  analysis_status VARCHAR(16) NOT NULL,
  uploaded_at DATETIME(6) NOT NULL,
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS hazard_findings (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  image_id VARCHAR(64) NOT NULL,
  category CHAR(3) NOT NULL,
  label VARCHAR(24) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  body JSON NOT NULL,              -- summary, visibleEvidence, location, notEstablishedFromPhoto, flags, source
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS context_questions (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  body JSON NOT NULL,
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS shopping_requirements (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  product_type VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  safety_critical BOOL NOT NULL,
  body JSON NOT NULL,              -- hazardIds, mandatory, preferred, installation, openQuestionIds
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS product_candidates (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  status VARCHAR(24) NOT NULL,
  body JSON NOT NULL,              -- requirementIds, price, availability, attributes, evidenceIds, discoveredBy
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS product_evidence (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  source_url TEXT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  excerpt LONGTEXT NOT NULL,
  content_sha256 CHAR(64),
  source JSON NOT NULL,
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS product_classifications (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  requirement_id VARCHAR(64) NOT NULL,
  concern BOOL NOT NULL,
  body JSON NOT NULL,
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS constraint_decisions (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  candidate_id VARCHAR(64) NOT NULL,
  requirement_id VARCHAR(64) NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  engine_version VARCHAR(32) NOT NULL,
  body JSON NOT NULL,              -- ruleResults, evidenceIds, classificationIds, notes
  decided_at DATETIME(6) NOT NULL,
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS shopping_actions (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL,
  simulated BOOL NOT NULL,
  adapter VARCHAR(64) NOT NULL,
  body JSON NOT NULL,              -- candidateIds, decisionIds, approval, externalRef, error
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  KEY (case_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(64) PRIMARY KEY,
  case_id VARCHAR(64) NOT NULL,
  at DATETIME(6) NOT NULL,
  type VARCHAR(48) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  actor JSON NOT NULL,
  subject JSON,
  summary TEXT NOT NULL,
  data JSON,
  tool_call JSON,
  KEY (case_id, at)
);
