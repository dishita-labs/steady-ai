# End-to-end runner: Nathan's machine

Decided 2026-11-20: **one machine runs the end-to-end flow and every Firedrill drill: Nathan's.** All live credentials live there and nowhere else. Dishita writes code and scenarios, pushes to branches, and reads results through PRs and Firedrill reports. Nobody copies keys between laptops.

| Credential | Where it lives | Who sets it |
|---|---|---|
| `SIE_API_KEY`, `EXA_API_KEY` | Nathan's macOS keychain via fnox (already in `fnox.toml`) | Nathan |
| `SINGLESTORE_HOST`, `SINGLESTORE_USER`, `SINGLESTORE_PASSWORD` (+ `SINGLESTORE_DATABASE` if not `steady`) | Nathan's keychain via fnox (new entries) | Nathan, or Dishita shares them once over a password manager, never chat or git |
| `STEADY_API_TOKEN` | Nathan's keychain via fnox (new entry) | Nathan |
| Firedrill CLI sign-in | Nathan's keychain (Firedrill's own store) | Nathan, in a browser |

## One-time setup (on Nathan's machine)

```bash
# Repo and toolchain (Node 26.13.1, aube, fnox from mise.toml)
cd steady-ai && git fetch && mise install && aube install

# Eval photos: steady-ai expects them in a sibling checkout
git clone https://github.com/dishita-labs/steady-prep.git ../steady-prep

# Secrets: fnox prompts with hidden input and stores them in the keychain (default_provider).
# This adds the keys to fnox.toml; commit that change (names only, no values).
fnox set SINGLESTORE_HOST
fnox set SINGLESTORE_USER
fnox set SINGLESTORE_PASSWORD
fnox set STEADY_API_TOKEN
fnox check                       # every secret resolves; prints no values
```

`SINGLESTORE_PORT` (3333), `SINGLESTORE_DATABASE` (`steady`) and `SHOPPING_MODE` (`simulated`) have defaults, so they don't need to be secrets.

## Verify SingleStore (once, then after schema changes)

```bash
fnox exec -- aube run db:migrate
SINGLESTORE_SMOKE=1 fnox exec -- aube exec vitest run tests/singlestore.smoke.test.ts
```

Evidence goes to `.data/smoke/singlestore-<tag>.json`. Paste the summary into the PR. Then flip `INTEGRATIONS.singlestore.verified` and add a dated line under "Verified integrations" in `docs/decisions.md`.

## Run the app end to end

```bash
fnox exec -- aube run dev        # Nitro on :3000, recorder = SingleStore (all SINGLESTORE_* set)
aube run workflow:web            # run trace UI
```

Then follow the curl flow in `README.md` with one image from `../steady-prep/data/evaluation/images/`.

## Firedrill (once the flow runs)

```bash
mise exec -- npx firedrill-run@latest init --json --no-browser     # approve the link and code in a browser
mise exec -- npx firedrill-run@latest status --json                # confirm the workspace
```

- **Invite Dishita** to the same Firedrill workspace (web app → Team) so she can read reports and manage scenarios over MCP without running anything.
- **Drills run on this machine.** `firedrill run` passes the secrets named in the local plan's `local_secret_env` from the shell it runs in, so start it under fnox:
  `fnox exec -- npx firedrill-run@latest run --plan <local-plan.json> --descriptor <descriptor.json> --campaign <id> --approve --json`
- **The local plan stays on this machine.** Firedrill's docs say it holds absolute paths and must not be committed.

The scenario definitions, bridge design and the restricted-file changes the drills depend on are in `docs/integrations/firedrill.md` and `evals/README.md`.
