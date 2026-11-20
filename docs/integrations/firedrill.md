# Firedrill

Owner: Dishita (branch `feat/singlestore-firedrill`). Sources: <https://firedrill.run/agent-setup.md>, <https://firedrill.run/run-your-agent.md>, and <https://docs.firedrill.run/> (descriptor, local plan, drivers, tools and scenarios pages), read 2026-11-20. Nothing below relies on an API those pages don't document.

## Setup status (2026-11-20)

| Piece | Status |
|---|---|
| CLI | `npx firedrill-run@latest` → **3.0.11**, which meets the ≥ 3.0.5 minimum. It runs on Node 26.13.1 from `mise.toml`. Node 20, the shell default, is **not** supported. |
| CLI sign-in | **Not signed in.** `status --json` shows `signed_in: false`, macOS keychain available, and drivers `http.v1`, `jsonl-process.v1`, `function-wrapper.v1` and `signed-http-event.v1` available. |
| Remote MCP (`https://mcp.firedrill.run`) | **Not configured** in Claude Code. |
| Firedrill skill | Not installed. |
| Agent registered, world, plan, campaign | None. |

### Finish setup (needs the person, in a browser)

1. **MCP.** The docs say `claude mcp add --scope project --transport http firedrill https://mcp.firedrill.run`. `--scope project` writes `.mcp.json`, a shared repo file Nathan removed in `ce20d17`, so use `--scope local` while we work in parallel. Then open `/mcp` and authorize.
2. **CLI.** `mise exec -- npx firedrill-run@latest init --json --no-browser` prints a link and code. Approve them once, then confirm the workspace with `status --json`.
3. Optional: `npx skills add firedrill-tools/firedrill-skills`.

## How Firedrill will drive Steady (proposed, not built)

Steady isn't a chat endpoint. It's a multipart upload (`POST /api/cases`) behind a bearer token, followed by an asynchronous workflow that pauses on hooks. So `http.v1` (one synchronous JSON POST, no auth header) can't call it directly. Instead:

- **Driver:** `function-wrapper.v1`, with a wrapper at `evals/firedrill/bridge.mjs` (to be written, owned by Dishita). It reads one task per line:
  `{"photo": "<eval image id>", "room": "bathroom", "context": {...}, "approve": false}`.
  1. Uploads the photo from `steady-prep/data/evaluation/images/` to `POST /api/cases`, using `STEADY_API_TOKEN` from `local_secret_env`.
  2. Polls `GET /api/cases/:id` until the case is `failed`, `completed` or `needs_input`, or the run is waiting on a hook. Answers context questions if the task supplies them.
  3. Approves only when the task says `approve: true`. Scenario C never does.
  4. Reads the case history and returns `scoreScenario(...)` from `evals/scenarios.ts` together with the raw decisions, actions and audit types as the step output. A Firedrill evaluation then scores that JSON, so every criterion maps to a named assertion ID.
- **Scenarios:** `firedrill.native-scenario.v2` with `target_input: {kind: "task", ...}`. D uses an outage event on the Exa dependency (`dependency_unavailable`).
- **Services:** the Nitro server (`node .output/server/index.mjs`), `mode: launch` with `per_drill: true`, `port_env`, and readiness on `GET /health`. Per-drill `STEADY_DATA_DIR` and `WORKFLOW_LOCAL_DATA_DIR`. Recorder: JSONL per drill, or SingleStore with `concurrency: serial`.
- **Dependencies:** `exa` as an `http` synthetic dependency backed by a **custom tool** (`firedrill tools init exa-sim`). It returns the scripted pages for A, B and C (a low load rating, a missing specification, a passing specification) and can be made unavailable for D. SIE vision runs for real (needs `SIE_API_KEY`), or its output is pinned by choosing eval photos with known labels.

## Changes needed from Nathan (restricted files, not changed here)

1. **Route Exa to a Firedrill address** (`src/lib/product-search/index.ts`). Firedrill gives each dependency an address of the form `http://127.0.0.1:<port>/<key>/exa/v1/invoke` and expects `POST {"operation", "arguments"}`. Proposed: when `EXA_INVOKE_URL` is set, `search()` posts `{"operation": "search", "arguments": {query, numResults, includeDomains, contents}}` there and maps `results` the way `toPage` does. When it isn't set, nothing changes. Add `EXA_INVOKE_URL` to `INTEGRATIONS.exa.optional` in `src/lib/config.ts`.
2. **Empty search results must be explicit** (`src/workflows/steps.ts`, `researchProducts`, and the `nothing_eligible` path). Today, zero or unusable results end the run as `nothing_eligible` with the case still `in_progress` and no failure audited. That would fail scenario D. Proposed: when every ready requirement produced zero candidates, audit `integration.error` (or `product.searched` with `toolCall.ok: false`) and set the case to `escalated` or `needs_input` with a `statusReason`.
3. **Scenarios A and C need attribute extraction** (the open decision "Typed answers → attributes"). Until something writes evidence-backed `ProductAttribute`s, no candidate can be `rejected` or `eligible`.
4. **A readiness endpoint that reports run state** is optional. `GET /api/cases/:id` already gives stage and status, which is enough for the bridge to poll.
