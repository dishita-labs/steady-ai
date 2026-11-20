# Decisions

Each decision is short and dated. **Confirmed** means we've decided it. **Open** means it's still undecided. An integration is **verified** only after a real API call succeeds, and gets a dated line under "Verified integrations".

## Confirmed (2026-11-20)

1. **Stack:** Workflow SDK (`workflow` 5.7) + Hono, served and built by Nitro 3 (`workflow/nitro` module). TypeScript 6, ESLint (typescript-eslint), Vitest. **aube** for packages. The Next.js app is removed.
2. **Secrets come from fnox** (`fnox exec` in the `dev`, `start` and `db:migrate` scripts). `.env` is only for non-secret settings.
3. **The web UI is the only interface, driven by Datastar.** No JSON API, no `/api` prefix. The server renders HTML (`src/ui/`) and the page posts forms with Datastar; the server answers with SSE events that patch the HTML. Left pane: photo + the family's own concern (sent as `notes`) + room + consent, then any context questions. Right pane: decision trail and shopping request, including the approval buttons. The Workflow SDK web UI (`aube run workflow:web`) is still the place to debug runs.
4. **Guild AI is dropped for now.** The Workflow SDK owns orchestration, durable state and the run trace. It can come back later as a boundary.
5. **Models on Superlinked SIE:** Gemma 4 31B (`google/gemma-4-31B-it`) for vision via `chatCompletions` with a strict JSON schema, and GLiNER2.5 Decide (`fastino/GLiNER2.5-Decide`) for typed decisions via `extract` + `outputSchema`. Both model IDs are configurable through env.
6. **Recorder chosen by env:** SingleStore when `SINGLESTORE_*` is set, otherwise local JSONL with the same row shape.
7. **SingleStore client is `mysql2`, not `singlestore-nodejs`.** aube's supply-chain check refused `singlestore-nodejs` (505 weekly downloads, under its 1000 threshold). SingleStore speaks the MySQL wire protocol.
8. **The rules engine is the authority.** Model outputs are advisory and can only add a concern. A missing attribute is `unknown`, never a pass.
9. **No purchase without explicit approval.** It goes through the approval hook, then `approve`, then `executeApproved`. Shopping defaults to `SHOPPING_MODE=simulated`.
10. **Store observable things only:** findings, evidence excerpts with source URLs, tool results, rule results and actions. Never hidden model reasoning.
11. **Use the hazard taxonomy H01–H11** from the prep work.
12. **Supply-chain exceptions** (`aube-workspace.yaml`), reviewed and pinned to exact versions: `@vercel/functions@3.11.3`, `@vercel/oidc@4.0.9` and `@vercel/oidc@3.8.10`, `@vercel/cli-config@0.4.0` and `@vercel/cli-config@0.3.1`, `@vercel/cli-exec@1.0.1`, and the ten `@swc/core-*@1.15.3` platform binaries. They come in through `@workflow/*` and have no trusted-publisher provenance. Every other resolved package passed `aube trust check`.
13. **The app has no auth of its own: it is a frontend that sits behind an auth proxy.** The proxy decides who can reach it, so the app has no token, login or per-user check, and the public case-photo URL (`/cases/:id/photo`) and the approval route are acceptable for now. This only holds while the app is reachable only through the proxy; don't expose it directly.

## Open

| Topic | Question | Notes |
|---|---|---|
| Typed answers → attributes | Should a Decide "yes" (with what probability, from which chunk) become an evidence-backed `ProductAttribute`, or should attributes come only from parsing page text? | Today nothing produces attributes, so every candidate is `needs_verification` and the approval path isn't reachable with real data |
| Requirement rules | Mandatory constraints, `decideQuestion`s, and context questions per hazard | `REQUIREMENT_RULES` has three placeholder rules (H09, H10, H11) and no constraints |
| Context answers → constraints | How an answered `field` (e.g. `wall_type`) changes a requirement's constraints | `applyContextAnswers` records answers only |
| Decide chunking | Combine answers across 512-token chunks (any-concern? max? per-question?) | Each chunk is its own classification today |
| Vision prompt and profile | Prompt wording, image resolution profile (`:h100-…-hires`), and max tokens | Measure on the 24 held-out eval images |
| Self-hosted SIE | Gemma 4 (`sglang-cu130` bundle) and Decide (`transformers5`) need different images, so possibly two base URLs | One `SIE_BASE_URL` today; Serverless lists both models |
| Price/availability | Parse from page text, or a retailer API | Not extracted; would be flagged unverified |
| Real auth | Per-user auth for approvals | Handled by the auth proxy in front of the app (decision 13). The app itself has no auth, so approvals aren't tied to a verified user (`approvedBy` is a typed name). Revisit if the app is ever exposed without the proxy |
| Production world | Workflow SDK world for deployment (Postgres world, Vercel) | Local world (`.workflow-data`) for now |
| Image storage | Local disk vs. object storage | `.data/uploads`, private |

## Sponsor facts (from docs and installed SDK types, 2026-11-20; no call has been made yet)

| Service | Package | Auth env | Key operations |
|---|---|---|---|
| Superlinked SIE | `@superlinked/sie-sdk` 0.11.1 | `SIE_API_KEY`, optional `SIE_BASE_URL` | `chatCompletions({ model, messages, response_format })` (image parts as `data:` URLs); `extract(model, { text }, { outputSchema })` → `data`; `systemOne(...)` is an alternative typed-decision surface |
| Exa | `exa-js` 2.29.0 | `EXA_API_KEY` | `search(q, { numResults, contents: { text, highlights } })`, `getContents(urls, …)` |
| SingleStore | `mysql2` 3.24 | `SINGLESTORE_*` (ours) | `INSERT … ON DUPLICATE KEY UPDATE`; JSON columns; primary keys must include the shard key |
| Workflow SDK | `workflow` 5.7.0 | none locally | `start`, `getRun(...).getReadable()`, `defineHook().create/resume`, `getWritable`, `FatalError` |

## Verified integrations

None yet. A no-keys smoke test (2026-11-20) confirmed the Nitro build, API auth, workflow start, JSONL recording, the failure path (step-level `guarded`), the Datastar SSE stream and `workflow inspect runs`.
