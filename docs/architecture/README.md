# Architecture

Steady turns one room photo into an approved, evidence-backed shopping action. A Workflow SDK run drives each case. Steps do all the I/O and record everything to the recorder (SingleStore or JSONL), and pure TypeScript rules make every decision.

```text
 POST /api/cases (photo) ─▶ start(steadyCase)
                                 │
  recordCase ─▶ analyzePhoto ──────────▶ Gemma 4 31B (SIE chatCompletions, strict JSON schema)
                    │                     └─ validateVisionResult: contract violations stop the run
                    ▼
  defineRequirements ── rules/requirements.ts (deterministic hazard → requirement table)
                    │
                    ├─ open questions? ─▶ contextHook ◀── POST /api/cases/:id/context
                    ▼
  researchProducts (per requirement) ──▶ Exa search + page text ─▶ ProductCandidate + ProductEvidence
                    ▼
  decideProduct (per candidate) ───────▶ GLiNER2.5 Decide (SIE extract, typed questions) ─▶ ProductClassification
                    ▼                     └─ classificationConcern: advisory, can only downgrade
  evaluateProducts ── rules/engine.ts ─▶ ConstraintDecision (eligible / rejected / needs_verification)
                    ▼
  preparePurchase ── simulated adapter ─▶ ShoppingAction (awaiting_approval)
                    ▼
  approvalHook ◀── POST /api/cases/:id/actions/:actionId/approval
                    ▼
  recordApprovalDecision ── approve() + executeApproved() ─▶ executed (simulated) or declined

  Every step: recorder upserts (deterministic IDs) · audit events · syncCase (stage/status) · progress event
  Any error: markFailed records status=failed, then the run fails visibly in the Workflow UI
```

## Workflow SDK

- `src/workflows/steady-case.ts` is the only `"use workflow"` function. It runs in a deterministic sandbox and is replayed from the event log, so it does no I/O. It calls steps, awaits hooks, and returns a small result.
- `src/workflows/steps.ts` holds the `"use step"` functions. Steps are retried on unhandled errors. Missing configuration (`IntegrationUnavailableError`) and broken model output are fatal, because retrying won't fix them.
- **Idempotency.** Everything a step writes gets an ID derived from what it is (`stableId`), so a retried step upserts the same rows.
- **Hooks.** `contextHook` and `approvalHook` (`src/workflows/hooks.ts`) have deterministic tokens built from case and action IDs. The tokens are not credentials, so every `/api` route requires `STEADY_API_TOKEN`.
- **Monitoring.** Run `aube run workflow:web` to see runs, steps, retries, hooks and stream output. Locally the run state lives in `.workflow-data/`.
- **Datastar.** `GET /api/runs/:runId/stream` reads the run's progress stream and sends each event as a `datastar-patch-signals` SSE event. It's a stub for the future web app.

## Case state (`src/lib/case/state.ts`)

`CASE_CREATED → PHOTO_ANALYZED → REQUIREMENTS_DEFINED → PRODUCTS_RESEARCHED → PRODUCTS_EVALUATED → PURCHASE_PREPARED → APPROVAL_PENDING → ACTION_COMPLETED`

- **`stage`** is how far the case has got. **`status`** says whether it can keep moving: `in_progress`, `needs_input`, `escalated`, `failed` or `completed`.
- Gates are pure functions of the case snapshot. After every step, `syncCase` advances the stage as far as the gates allow and derives the status. The workflow's control flow and the gates check each other.
- Gates need *at least one* ready item, so a handrail that needs a professional doesn't block a night light that is ready to buy.

## Recorder (`src/lib/recorder/`)

| Backend | When | Notes |
|---|---|---|
| SingleStore (`mysql2`) | `SINGLESTORE_HOST/USER/PASSWORD` set | Every table stores the full entity in `body JSON`, plus typed filter columns. `SHARD KEY (case_id)`. TLS on by default. |
| JSONL | otherwise | `.data/records/<table>.jsonl`, append-only `{op, at, row}`, same row shape as `body` |
| Memory | tests | |

`STEADY_RECORDER=jsonl|singlestore` forces one. The audit log is append-only in every backend.

## Safety rules enforced in code

| Rule | Where |
|---|---|
| A "present" hazard needs visible evidence; all 11 categories must be labeled | `validateVisionResult` |
| Invisible properties (anchoring, slipperiness, load) go in `notEstablishedFromPhoto`, never in findings as fact | prompt + `HazardFinding` type |
| Only "present" findings create shopping requirements | `deriveRequirements` |
| Search queries come from the rules table, not from a model | `RequirementRule.searchQuery` |
| Missing product evidence is `unknown`, which means `needs_verification`; never an assumed pass | `evaluateConstraint` |
| Unit mismatch is `unknown`; there is no silent conversion | `evaluateConstraint` |
| Decide output can only downgrade eligible to needs_verification; a "yes" is never a pass | `classificationConcern`, `evaluateCandidate` |
| Model confidence is never a gate | `HazardFinding.modelConfidence`, Decide probabilities are recorded, not used as gates |
| Safety-critical items carry an "in-person check recommended" note | `evaluateCandidate` |
| Nothing executes without explicit approval from the adapter that prepared it | `approvalHook` → `approve` → `executeApproved` |
| Simulated actions are labeled | `ShoppingAction.simulated` |
| The audit log has no secrets and no hidden reasoning | `createAuditEvent` |
| Photos need explicit consent; uploads stay on local disk, never at a public URL | `POST /api/cases` |

## Hazard taxonomy

H01–H11 (`HAZARD_CATEGORIES`) match the taxonomy used for the prep evaluation set, so model output can be scored against it.
