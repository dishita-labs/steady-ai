# Steady

**An AI shopping agent that helps families find possible fall hazards in an aging parent's home and buy the right safety improvements, with evidence and their approval at every step.**

Built for the Personal Agents Hackathon (2026-11-20).

1. Upload a room photo.
2. A vision-language model flags hazards it can actually see, with visual evidence and stated uncertainty.
3. Steady turns hazards into product requirements and asks for missing context.
4. **Exa** finds products and retrieves page content, keeping sources.
5. **Superlinked SIE (GLiNER2.5 Decide)** classifies product text against requirements. Its output is advisory.
6. A **deterministic rules engine** decides: eligible, rejected, or needs verification.
7. Steady prepares a cart or purchase request and **waits for explicit approval**.
8. Every step is written to an **audit trail** in **SingleStore**. The agent runs on **Guild AI**.

> Steady is a shopping assistant, not a certified home-safety inspector. A photo can't establish hidden structural safety, and safety-critical installs may need a professional.

## Status

This is the foundation only: the types, workflow, rules engine, approval guard, audit helper and integration interfaces. **No sponsor integration is connected yet**, so none is claimed to work. See [`docs/decisions.md`](docs/decisions.md).

## Getting started

Requires **Node 22** (`nvm use`).

```bash
npm install
cp .env.example .env.local   # fill in keys; never commit real values
npm run dev                  # http://localhost:3000
npm run check                # lint + typecheck + tests
npm run build
```

## Layout

```text
src/
  app/                      Next.js routes and UI
  components/               UI components
  types/domain.ts           Shared domain types (case, image, hazard, requirement, product, evidence, decision, action, audit)
  lib/
    agent/workflow.ts       Stages, statuses, gates
    agent/runtime.ts        Guild AI boundary
    vision/                 Vision model boundary and output validator
    product-search/         Exa boundary
    product-classification/ Superlinked SIE boundary
    rules/engine.ts         Deterministic constraint engine
    database/               Repository interface, in-memory dev store, SingleStore schema draft
    shopping/               Shopping adapter interface and approval guard
    audit/                  Audit event builder
    integrations.ts         Service registry and env vars
tests/                      Vitest unit tests
docs/
  architecture/README.md    How the pieces fit, safety rules in code
  decisions.md              Confirmed vs. open decisions, sponsor API notes
```
