# AGENTS.md — Workspace Guide for Local & Cloud Cursor Agents

This repository houses a timeboxed (4–5 hour) enterprise AI SDLC prototype built with the **Cursor Cloud Agent** (with custom environment) and/or **Cursor Agent SDK** (`@cursor/sdk` or `cursor-sdk`).

Read this file first before planning, coding, reviewing, or running validation tasks.

---

## 1. Mission & Hard Constraints

- **Scope discipline:** A small, well-scoped prototype that **clearly works end-to-end** beats a big one that half works.
- **Timebox:** Total build effort is 4–5 hours. Cut non-essential polish; never cut reliability, reproducibility, or clear proof that it works.
- **Explicitly OUT OF SCOPE:** Do **not** build or depend on Cursor Automations, BugBot, or Security Review.
- **Synthetic / public data only:** Never include confidential, employer, or real customer code/secrets.
- **One-command runnable:** Everything needed to run the core demo must execute via a single documented command in `README.md`.
- **Live-extension ready:** Keep clean, modular extension points (e.g., policy/rules config, eval checks, environment/repo targets, tool hooks) so a new requirement can be added and verified in <15 minutes live.
- **Radical honesty:** Clearly separate **Built & Working** from **Design Only** in `README.md` and `docs/WRITEUP.md`. Never fabricate live metrics or hide mocked steps as real runs.

---

## 2. Cursor SDK & Cloud Agent Guardrails

All agents writing SDK or Cloud Agent code must follow these non-negotiable practices:

1. **Always set runtime explicitly:** Pass `cloud: { repos: [...] }` or `local: { cwd }` (TS) / `cloud=CloudAgentOptions(...)` or `local=LocalAgentOptions(...)` (Python). Never omit both.
2. **Always dispose agents:** Use `await using agent = await Agent.create(...)` (TS) or `with Agent.create(...) as agent:` (Python), or `Agent.prompt(...)` for true one-shots. Never leak handles/processes.
3. **Always call `wait()`:** Even when streaming `run.stream()` / `run.messages()`, always `await run.wait()` / `run.wait()` to capture terminal status and prevent watcher leaks.
4. **Separate startup vs. execution failures:**
   - Thrown `CursorAgentError` → startup/auth/config/network failure (exit code `1`). Respect `err.isRetryable` / `err.retry_after` before retrying.
   - Returned `result.status === "error"` → run started and failed mid-flight (exit code `2`). Inspect transcript/artifacts.
   - `result.status === "finished"` → success (exit code `0`).
5. **Log IDs immediately:** Log `agent.agentId` (or `agent_id`) and `run.id` right after `send()` before streaming so failed or hung runs can be inspected via `Agent.get` / `Agent.getRun`.
6. **Explicit credentials:** Pass `apiKey` / `api_key` explicitly from environment config rather than relying implicitly on ambient globals; never hardcode keys or commit `.env`.
7. **Cloud Agent hygiene:**
   - Set `skipReviewerRequest: true` / `skip_reviewer_request=True` for automated/demo runs unless intentionally requesting human review.
   - Do not call `agent.summarize()` on cloud agents (local-only API).
   - Guard optional run ops (`cancel`, `conversation`) with `run.supports(...)`.
   - Do not load ambient user/IDE settings (`local.settingSources`) unless explicitly intended.
   - Inline MCP servers are not persisted across `Agent.resume(...)` and per-send MCP overrides replace rather than merge creation-time servers.

---

## 3. Repository Layout & Ownership Boundaries

| Path | Purpose | Ownership / Notes |
|---|---|---|
| `AGENTS.md` | Agent operating rules & parallel workflow protocol | Coordinator |
| `README.md` | One-command quickstart (`./run-demo.sh`), Cloud Agent env setup, built vs. design-only | Keep strictly in sync with working commands |
| `docs/WRITEUP.md` | 1–2 page executive/technical write-up deliverable | Keep concise (max 2 pages) |
| `docs/ARCHITECTURE.md` | Detailed architecture, data flow, extension seams | Shared contract spec |
| `packages/` | Upstream MarkText (`desktop`, `muya`, `website`) ~111k LOC legacy baseline | Legacy track (never break strangler-fig fallback) |
| `config/migration-flags/` | Per-environment rollout flags (`dev.json`, `staging.json`, `prod.json`) | `prod.json` is human-only (`HARD_BLOCK`) |
| `migrations/` | Declarative component migration contracts (`word-count.json`, `outline-toc.json`, `markdown-blocks.json`) | Defines allowed/forbidden paths & perf budgets |
| `rust/` | Cargo workspace (`marktext-core` parity CLI + `marktext-gpui` native Zed GPUI desktop app & headless tests) | Rust/GPUI workstream |
| `tools/migration-sdk/` | TypeScript `@cursor/sdk` orchestrator (`dispatch`, `qa`, `demo`, `flags`), policy gates & Vitest tests | SDK/QA workstream |
| `evals/` | Golden Markdown parity corpus (`evals/corpus/`) & telemetry ledger (`evals/runs/`) | Proof-of-work & before/after metrics |
| `.cursor/` | Cloud Agent custom environment (`Dockerfile`, `environment.json`, `rules/migration.mdc`) | Must be reproducible on a fresh Cloud Agent VM |
| `.github/` | `CODEOWNERS` + `workflows/migration-qa.yml` (runs SDK QA gate on `migration`-labeled PRs) | Governance (immutable to migration agents) |
| `context/` | Local-only interview prep & prompt notes (**gitignored**) | Never reference from production code or commit |

---

## 4. Parallel Multi-Agent Execution Protocol

When multiple **local agents** and **remote Cloud Agents** work in parallel during the build sprint:

### Coordination Rules
1. **Worktree / branch isolation:** Each parallel implementation agent should work on a scoped task with explicit file ownership (e.g., `agent-orchestrator`, `agent-fixtures`, `agent-evals`, `agent-ui-docs`). Do not edit files outside your assigned scope without coordinating.
2. **Contract-first interfaces:** Define shared types, JSON schemas, CLI flags, and artifact paths in `docs/ARCHITECTURE.md` (and a shared `types` module) **before** fanning out parallel agents.
3. **Small, verifiable commits:** Every task ends with passing tests/checks and a clear summary of what was verified.
4. **No silent mocks:** If a component has a `--dry-run` or replay mode for fast iteration/demo fallback, label it explicitly in CLI output and logs; keep live Cloud Agent / SDK execution as the primary path.

### Role Split for Parallel Agents
- **Builder Agents (Local):** Implement disjoint modules against agreed interfaces (e.g., SDK orchestration core, synthetic enterprise fixture repo + CI, eval/metrics harness, CLI/web viewer).
- **Validation / QA Agents (Remote Cloud Agents or Local Subagents):**
  - Run fresh-environment install + one-command demo/test suite.
  - Validate error paths (missing API key, failed CI gate, retry behavior, timeout/cancel handling).
  - Audit `README.md` commands word-for-word against actual behavior.
  - Verify telemetry/metrics artifacts accurately reflect actual runs.
  - Check for accidental secret leaks, out-of-scope features, or unstated mocks.

---

## 5. Definition of Done (for Every Task & QA Pass)

Before marking any workstream complete, verify:
- [ ] Code compiles / typechecks / lints cleanly with zero errors.
- [ ] Automated tests and/or eval checks pass locally (and in Cloud Agent VM where applicable).
- [ ] One-command run path in `README.md` works from a clean state.
- [ ] Failure modes return clear, structured diagnostics and proper exit codes (`0` success, `1` startup/config error, `2` run/verification failure).
- [ ] Observability/metrics output is captured (duration, status, retries, pass/fail checks, estimated cost/tokens where available).
- [ ] `README.md` accurately distinguishes **Built & Working** vs. **Design Only**.
- [ ] No secrets, `.env` files, or `context/` files are staged or committed.
