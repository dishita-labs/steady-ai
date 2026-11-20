# Steady

**An AI shopping agent that helps families find possible fall hazards in an aging parent's home and buy the right safety improvements, with evidence and their approval at every step.**

Built for the Personal Agents Hackathon (2026-11-20).

1. Upload a room photo.
2. **Gemma 4 31B on Superlinked SIE** flags hazards it can actually see, with visual evidence and stated uncertainty.
3. A **deterministic rules table** turns hazards into product requirements and asks for missing context.
4. **Exa** finds products and retrieves page content, keeping sources.
5. **GLiNER2.5 Decide on Superlinked SIE** answers typed questions about each product page. Its output is advisory.
6. A **deterministic rules engine** decides: eligible, rejected, or needs verification.
7. Steady prepares a (simulated) purchase request and **waits for explicit approval**.
8. Every step is recorded to **SingleStore** (or local JSONL), with an audit trail. The **Workflow SDK** runs the pipeline durably, and its run trace shows each step.

> Steady is a shopping assistant, not a certified home-safety inspector. A photo can't establish hidden structural safety, and safety-critical installs may need a professional.

## Status

The scaffolding works end to end with no API keys: a case is recorded, the run stops cleanly at photo analysis, and the failure is recorded. **No external integration has been verified with a real call yet.** The vision prompt, requirement rules and Decide concern policy are drafts for us to evaluate. There is no web app yet. See [`docs/decisions.md`](docs/decisions.md).

## Getting started

Uses [aube](https://aube.sh) (`mise install` provides it) and Node ≥ 22.12.

```bash
aube install
cp .env.example .env        # set STEADY_API_TOKEN at least; never commit real values
aubr dev                    # Nitro dev server on http://localhost:3000
aubr workflow:web           # Workflow SDK UI: runs, steps, hooks, streams
aubr check                  # lint + typecheck + tests
aubr build                  # production build in .output/
aubr db:migrate             # apply the SingleStore schema (needs SINGLESTORE_*)
```

Start a case and drive it from the command line:

```bash
curl -H "Authorization: Bearer $STEADY_API_TOKEN" \
  -F photo=@bathroom.jpg -F room=bathroom -F consent=true \
  http://localhost:3000/api/cases
# → { "caseId": "...", "runId": "..." }

curl -H "Authorization: Bearer $STEADY_API_TOKEN" http://localhost:3000/api/cases/<caseId>
curl -N -H "Authorization: Bearer $STEADY_API_TOKEN" http://localhost:3000/api/runs/<runId>/stream   # Datastar SSE

# When the run waits on a hook (the Workflow UI shows it):
curl -H "Authorization: Bearer $STEADY_API_TOKEN" --json '{"answeredBy":"me","answers":[{"questionId":"q_...","answer":"tile"}]}' \
  http://localhost:3000/api/cases/<caseId>/context
curl -H "Authorization: Bearer $STEADY_API_TOKEN" --json '{"approved":true,"approvedBy":"me"}' \
  http://localhost:3000/api/cases/<caseId>/actions/<actionId>/approval
```

## Layout

```text
nitro.config.ts             Nitro + workflow/nitro module; all routes → src/server.ts
src/
  server.ts                 Hono API: start case, read case, answer context, approve, Datastar SSE stub
  workflows/
    steady-case.ts          "use workflow": the orchestration only
    steps.ts                "use step": every I/O operation, with recording and audit
    hooks.ts                Context and approval hooks (where a run waits for a person)
    events.ts               Progress events written to the run stream
  types/domain.ts           Shared domain types
  lib/
    case/state.ts           Stages, statuses, gates (pure)
    config.ts               Integration registry and env
    sie.ts                  Shared Superlinked SIE client
    vision/                 Gemma 4 adapter, prompt + JSON schema (draft), output contract validator
    product-search/         Exa adapter
    product-decisions/      GLiNER2.5 Decide adapter: typed questions, chunking
    rules/engine.ts         Deterministic constraint engine + Decide concern policy
    rules/requirements.ts   Deterministic hazard → requirement rules (draft table)
    recorder/               CaseRepository: SingleStore (mysql2), JSONL, memory; schema.sql
    shopping/               Approval guard + simulated adapter
    audit/                  Audit event builder (rejects secrets and hidden reasoning)
scripts/migrate.ts          Apply schema.sql to SingleStore
tests/                      Vitest unit tests
docs/
  architecture/README.md    How the pieces fit, safety rules in code
  decisions.md              Confirmed vs. open decisions
```
