# SingleStore recorder

Owner: Dishita (branch `feat/singlestore-firedrill`). Code: `src/lib/recorder/`, `scripts/migrate.ts`.

## Status (2026-11-20)

| Check | Status |
|---|---|
| Real cluster connection, migration, insert, update and read | **Not verified yet. No credentials are configured on this machine.** The smoke test is ready (below). |
| Contract (create, update, read back every collection, retries, audit, history) | Passes against memory and JSONL (`tests/recorder.test.ts`). The same suite runs against SingleStore in the smoke test. |
| SQL shape, TLS defaults, error classification | Unit-tested with a fake pool (`tests/recorder.test.ts`), so no network. |

`INTEGRATIONS.singlestore.verified` stays `false` until the smoke test passes against a real cluster. Then record the date under "Verified integrations" in `docs/decisions.md` (Nathan's file).

## Configure

Put these in `.env` at the repo root (git-ignored), or export them in the shell:

```
SINGLESTORE_HOST=<workspace endpoint, e.g. svc-xxxx.svc.singlestore.com>
SINGLESTORE_PORT=3306
SINGLESTORE_USER=<user>
SINGLESTORE_PASSWORD=<password>
SINGLESTORE_DATABASE=steady
# SINGLESTORE_SSL=false   only for a local, non-TLS cluster
```

On a Starter or shared workspace that comes with a single database, set `SINGLESTORE_DATABASE` to that database's name. Migration skips `CREATE DATABASE` when the server refuses it.

## Verify against a real cluster

```bash
aube run db:migrate                                                   # applies schema.sql (idempotent)
SINGLESTORE_SMOKE=1 aube exec vitest run tests/singlestore.smoke.test.ts
```

The smoke test does the following:
1. Runs `scripts/migrate.ts`.
2. Checks that the server is SingleStore (`@@memsql_version`), that the session uses TLS (`Ssl_cipher`), and that all 11 tables exist.
3. Runs the full recorder contract through `SingleStoreCaseRepository` under unique `smoke_*` case IDs. That covers insert, update, reading back every collection, idempotent retries, isolation, ordered and idempotent audit, and rebuilding the full history.
4. Checks that the typed filter columns match the JSON bodies.
5. Writes evidence (server version, TLS cipher, row counts; no credentials) to `.data/smoke/singlestore-<tag>.json`, then deletes its own rows. Set `SINGLESTORE_SMOKE_KEEP=1` to keep them.

With `SINGLESTORE_SMOKE=1` and no credentials, the test **fails**. It never skips silently.

## What changed on this branch

| Area | Change |
|---|---|
| SQL | Every identifier is backtick-quoted, and every value is a `?` parameter. Reads filter on the shard key (`case_id`). Lists come back in a stable order (`ORDER BY id`; audit uses `ORDER BY at, id`). |
| Pool | TLS 1.2+ with certificate verification by default, plus `connectTimeout` 10 s, keep-alive and 5 connections. Options are built by `singleStorePoolOptions()`, which can be tested without connecting. |
| Errors | Failures are wrapped in `SingleStoreRecorderError` with the operation, table and driver code. Messages never contain credentials or row values. Errors a retry can't fix (access denied, unknown database, missing table or column, TLS or certificate failure, data too long) are marked `fatal: true`. Workflow SDK's `FatalError.is` treats them as fatal, so the step stops instead of retrying. Connection blips stay retryable. |
| No silent fallback | `selectRecorder` throws when `STEADY_RECORDER` has an unknown value, or when some but not all of the required `SINGLESTORE_*` vars are set. A forced `singlestore` without config throws `IntegrationUnavailableError`. Once SingleStore is selected, its errors surface as they are. |
| Idempotency | `createCase` is a plain INSERT, and a duplicate gives `Case … already exists` (it no longer overwrites silently). `appendAudit` is an INSERT that treats a duplicate `id` as already recorded, never as an update. Memory matches this. |
| History | `loadCaseHistory(repo, caseId)` rebuilds the case, all 9 collections and the ordered audit trail from the recorder alone. |
| Migration | Loads `.env` when present, validates the database name, and tolerates `CREATE DATABASE` being refused on Starter workspaces. |

## Known gaps for Nathan (restricted files, not changed here)

1. **Audit IDs are random, so retries duplicate audit events.** `createAuditEvent` (`src/lib/audit/index.ts`) uses `newId("evt")`. If a step fails after writing an audit event and is retried, the event is written again under a new ID. The recorder can't tell these apart.
   *Proposed patch:* let steps pass a deterministic ID:
   ```ts
   // src/lib/audit/index.ts
   export type NewAuditEvent = Omit<AuditEvent, "id" | "at"> & { at?: string; id?: string };
   return { id: input.id ?? newId("evt"), at: input.at ?? new Date().toISOString(), ...input };
   // src/workflows/steps.ts, e.g. in decideProduct:
   await audit(repo, { id: stableId("evt", "product.classified", k.id), ... });
   ```
   The SingleStore and memory recorders already treat a re-append of the same ID as a no-op.
2. **JSONL keeps duplicate audit appends.** SingleStore's `PRIMARY KEY (id, case_id)` rejects them, so JSONL records can't be loaded into SingleStore as they are. `tests/boundaries.test.ts:242` currently asserts the duplicate (`toHaveLength(2)`).
   *Proposed patch:* in `JsonlCaseRepository.appendAudit`, skip when an event with the same ID already exists, and change that assertion to `toHaveLength(1)`.
3. **Parallel steps can lose a case update.** `researchProducts` runs in parallel per requirement, and each call does a read-modify-write on the `cases` row through `syncCase`. The last writer wins with whatever snapshot it read. Stage and status are re-derived on the next step, so this heals itself, but an intermediate `statusReason` can be lost. No recorder change is needed unless we want optimistic concurrency, for example an `updated_at` check.
