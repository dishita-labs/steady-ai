# Architecture

Steady turns one room photo into an approved, evidence-backed shopping action. The app owns the workflow state. Each external service sits behind a small interface in `src/lib/`.

```text
 Photo ─▶ Vision model ─▶ HazardFinding[] ─▶ ShoppingRequirement[] ◀─ ContextQuestion (ask the user)
                                                    │
                                     Exa search + page contents ─▶ ProductCandidate + ProductEvidence
                                                    │
                       Superlinked SIE (GLiNER2.5 Decide) ─▶ ProductClassification (advisory)
                                                    │
                          Rules engine (deterministic TS) ─▶ ConstraintDecision
                                                    │                eligible / rejected / needs_verification
                               Shopping adapter ─▶ ShoppingAction ─▶ explicit user approval ─▶ execute
                                                    │
        Every step ─▶ AuditEvent      All state ─▶ SingleStore      Agent orchestration + traces ─▶ Guild
```

## Workflow (`src/lib/agent/workflow.ts`)

`CASE_CREATED → PHOTO_ANALYZED → REQUIREMENTS_DEFINED → PRODUCTS_RESEARCHED → PRODUCTS_EVALUATED → PURCHASE_PREPARED → APPROVAL_PENDING → ACTION_COMPLETED`

- **`stage`** is how far the case has got. **`status`** is whether it can keep moving: `in_progress`, `needs_input` (missing context or evidence), `escalated` (needs a human expert), `failed` (retryable tool error) or `completed`.
- **Gates** are pure functions of the case snapshot. They need *at least one* ready item, so a handrail that needs a professional doesn't block a night light that is ready to buy.
- **Stages are never skipped.** `ACTION_COMPLETED` needs an action that was executed *and* carries an explicit approval record.

## Module map

| Folder | Responsibility | State |
|---|---|---|
| `src/types/domain.ts` | Shared types: HomeownerCase, UploadedImage, HazardFinding, ContextQuestion, ShoppingRequirement, ProductCandidate, ProductEvidence, ProductClassification, ConstraintDecision, ShoppingAction, AuditEvent | Done |
| `lib/agent/workflow.ts` | Stages, statuses, gates, `tryAdvance`, `deriveStatus` | Done, tested |
| `lib/agent/runtime.ts` | `AgentRuntime` interface (Guild sessions and events) | Interface only |
| `lib/vision/` | `VisionAnalyzer` interface and `validateVisionResult` (output contract) | Interface + validator, tested |
| `lib/product-search/` | `ProductSearchProvider` (Exa search and getContents) | Interface only |
| `lib/product-classification/` | `ProductClassifier` (SIE GLiNER2.5 Decide) | Interface only |
| `lib/rules/engine.ts` | Deterministic constraint evaluation | Done, tested |
| `lib/shopping/` | `ShoppingAdapter` interface, `approve`, `executeApproved` guard | Guard done, tested; no adapter |
| `lib/database/` | `CaseRepository`, in-memory dev store, SingleStore `schema.sql` (draft) | Memory store done; SingleStore not connected |
| `lib/audit/` | `createAuditEvent` (rejects secrets and hidden-reasoning fields) | Done, tested |
| `lib/integrations.ts` | Registry of services, env vars, `verified` flags; `notImplemented()` | Done |

Unimplemented providers throw `IntegrationUnavailableError` rather than returning placeholder data.

## Safety rules enforced in code

| Rule | Where |
|---|---|
| A "present" hazard needs visible evidence; all 11 categories must be labeled | `validateVisionResult` |
| Invisible properties (anchoring, slipperiness, load) go in `notEstablishedFromPhoto`, never in findings as fact | `HazardFinding` type |
| Missing product evidence means `unknown`, which means `needs_verification`; never an assumed pass | `evaluateConstraint` |
| Unit mismatch is `unknown`; there is no silent conversion | `evaluateConstraint` |
| The classifier can only downgrade eligible to needs_verification, never upgrade | `evaluateCandidate` |
| Model confidence is never a gate | `HazardFinding.modelConfidence` is informational only |
| Unverified prices are flagged as possibly stale | `ObservedPrice.verified`, decision notes |
| Safety-critical items carry an "in-person check recommended" note | `evaluateCandidate` |
| Nothing executes without explicit approval from the adapter that prepared it | `executeApproved` |
| Simulated actions are labeled | `ShoppingAction.simulated` |
| The audit log has no secrets and no hidden reasoning | `createAuditEvent` |

## Hazard taxonomy

H01–H11 (`HAZARD_CATEGORIES`) match the taxonomy used for the prep evaluation set, so model output can be scored against it. Only the IDs and slugs are defined here. No dataset was imported.

## Diagram

The team's architecture diagram is the conceptual reference. It isn't committed to this repo; the sketch above mirrors it in text.
