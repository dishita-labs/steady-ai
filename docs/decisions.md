# Decisions

Each decision is short and dated. **Confirmed** means we've decided it. **Proposed** means it's still open. An integration is **verified** only after a real API call succeeds, and gets a dated line under "Verified integrations".

## Confirmed (2026-11-20)

1. **Stack:** Next.js 16 (App Router), TypeScript, Tailwind CSS 4, ESLint, Vitest. **Node 22**, because Vitest 5 and `@superlinked/sie-sdk` both require it.
2. **The app owns workflow state.** Guild runs the agent and keeps session traces, but the case stage and status live in our DB. Guild session and event IDs are recorded on audit events.
3. **The rules engine is the authority.** Classifier and LLM outputs are advisory and can only add a concern. A missing attribute is `unknown`, never a pass.
4. **No purchase without explicit approval.** `executeApproved` is the only path, and it requires an approval record. Shopping defaults to `SHOPPING_MODE=simulated`, and the UI labels simulated actions.
5. **Store observable things only:** findings, evidence excerpts with source URLs, tool results, rule results and actions. Never hidden model reasoning.
6. **Use the hazard taxonomy H01–H11** from the prep work, so outputs are comparable to the held-out evaluation.

## Proposed / open

| Topic | Options | Notes |
|---|---|---|
| Vision model | not chosen | Must return the `VisionAnalysisResult` contract |
| Guild integration shape | build and publish the agent on Guild; the app calls the REST session API | `@guildai/agents-sdk` only runs inside Guild's runtime (not on public npm) |
| SIE access | SIE Serverless vs. self-hosted | Self-hosting Decide needs an NVIDIA GPU. Not confirmed whether Serverless serves Decide |
| SingleStore client | `singlestore-nodejs` (docs recommend it) vs. `mysql2` | Shared clusters require SSL |
| Shopping adapter | simulated cart vs. a real retailer cart link | Real checkout is out of scope without explicit approval and a payment decision |
| Image storage | local disk for the demo vs. object storage | Photos are private by default |

## Sponsor facts (from official docs, 2026-11-20; no call has been made yet)

| Service | Package (not installed) | Auth env | Key operations | Docs |
|---|---|---|---|---|
| Exa | `exa-js` 2.29.0 | `EXA_API_KEY` | `search(q, { contents: { text, highlights, summary } })`, `getContents(urls, {...})`. `searchAndContents` is deprecated. There is no "product" category. | docs.exa.ai/sdks/typescript-sdk-specification |
| Superlinked SIE | `@superlinked/sie-sdk` 0.11.1 (Node ≥ 22) | `SIE_API_KEY`, `SIE_BASE_URL` | `extract("fastino/GLiNER2.5-Decide", { text }, { labels \| outputSchema, instruction })`. 512-token limit. | superlinked.com/models/fastino-gliner2-5-decide |
| Guild AI | `@guildai/cli` 0.32.0 | not named in docs (`GUILD_*` are ours) | REST `api.guild.ai/v1`: create session, list/post session events | docs.guild.ai |
| SingleStore | `singlestore-nodejs` 1.0.1 | not named in docs (`SINGLESTORE_*` are ours) | `createConnection({ host, port, user, password, database })`, JSON and `VECTOR(n)` columns | docs.singlestore.com |

## Verified integrations

None yet.
