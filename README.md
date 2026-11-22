# MarkText → MarkText-GPUI: "The Messy Middle" AI SDLC Prototype

An enterprise AI SDLC prototype built with the **Cursor Cloud Agent (custom `.cursor/environment.json`)** and **Cursor Agent SDK (`@cursor/sdk`)** demonstrating an incremental, feature-flagged **strangler-fig ("Ship of Theseus") migration** of **[MarkText](https://github.com/marktext/marktext)** (~111k LOC Electron/TypeScript Markdown editor) toward a native **Rust + Zed GPUI** desktop application — while the legacy Electron app continues shipping features in parallel.

> See [`docs/WRITEUP.md`](docs/WRITEUP.md) for the concise 1–2 page executive & technical write-up (problem, architecture, trade-offs, before/after metrics, failure modes, and next-week plan), and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module contracts and live-extension seams.

---

## Quickstart (One Command)

### Prerequisites
- **Node.js ≥ 22** and **pnpm ≥ 10**
- **Rust stable** (`rustc` / `cargo`) — install via `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- *(Optional for live Cursor SDK QA / Cloud Agent dispatch)* `CURSOR_API_KEY` in `.env` (see `.env.example`)

### Run End-to-End in One Command

```bash
# Full demo (runs deterministic parity/perf/policy checks + live @cursor/sdk QA Agent when CURSOR_API_KEY is set)
./run-demo.sh

# Explicit deterministic-only mode (no API key required — skips Phase B SDK QA Agent transparently)
./run-demo.sh --deterministic-only
```

What `./run-demo.sh` executes automatically:
1. Installs `tools/migration-sdk` dependencies and compiles `rust/target/release/marktext-core-cli` (if not already built).
2. Prints the multi-environment **Feature Flag Control Plane** (`config/migration-flags/{dev,staging,prod}.json`).
3. Runs live **Strangler-Fig routing** (`migrated`, `shadow` dual-run parity diff, `legacy`, and forced Rust-failure → legacy fallback drill).
4. Benchmarks **Before (Legacy MarkText TS)** vs. **After (Rust `marktext-core`)** across all 5 golden corpus files in `evals/corpus/` (ASCII, CJK/Unicode `#5292`, edge cases, empty, 68KB stress doc).
5. Runs enterprise **Policy Guardrails** (including a simulated unauthorized PR self-test proving `prod.json` and `CODEOWNERS` mutations are `HARD_BLOCK`ed).
6. Invokes the scoped **`@cursor/sdk` QA Verification Agent** (unless `--deterministic-only` is passed) and persists run telemetry to `evals/runs/`.

### Additional Commands

```bash
# Launch the native Zed GPUI mid-migration desktop preview window (macOS Metal / Linux Wayland/X11)
pnpm migration:gpui

# Run the full test suite (31 TypeScript SDK/policy/router tests + 15 Rust core & headless GPUI tests)
pnpm migration:test

# Run the QA gate on a single component (exit 0=PASS, 1=startup/auth error, 2=BLOCKED/regression)
pnpm migration:qa -- --component outline-toc --deterministic-only

# Preview or launch a live Cursor Cloud Agent migration PR for the unmigrated `markdown-blocks` subsystem
pnpm migration:dispatch -- --component markdown-blocks --repo shashu10/marktext-gpui-migration --dry-run
export CURSOR_API_KEY="cursor_..."
pnpm migration:dispatch -- --component markdown-blocks --repo shashu10/marktext-gpui-migration
```

---

## Cloud Agent Custom Environment Setup

This repository commits a complete Cursor Cloud Agent environment under `.cursor/`:

| File | Purpose |
|---|---|
| [`.cursor/Dockerfile`](.cursor/Dockerfile) | Ubuntu 24.04 image (`USER ubuntu`, `WORKDIR /home/ubuntu`) pre-installing **Node 22, pnpm 10, Rust stable (`rustc`/`cargo`/`clippy`/`rustfmt`)**, and Linux GPUI dependencies (`libxkbcommon`, `libwayland`, `libxcb`, `libfontconfig`, `libvulkan`, `mesa-vulkan-drivers`, `libasound2`). |
| [`.cursor/environment.json`](.cursor/environment.json) | Configures the Docker build and runs `"install"` during each Cloud Agent Build to install `tools/migration-sdk`, fetch Cargo crates, and pre-build `marktext-core` so Cloud Agents start warm. |
| [`.cursor/rules/migration.mdc`](.cursor/rules/migration.mdc) | Persistent guardrails for both local and Cloud Agents (respect `migrations/<component>.json` boundaries, never edit `prod.json`/`CODEOWNERS`, preserve legacy fallback, zero `.unwrap()` on untrusted input, require parity + headless GPUI tests). |

### Setup Steps for Live Cloud Agent + GitHub Actions Runs
1. Fork or push this repo to GitHub and configure a Cloud Agent environment pointing at `.cursor/environment.json` (Cursor auto-detects it on first single-repo Cloud Agent run).
2. Add `CURSOR_API_KEY` to local `.env` (for CLI dispatch/QA) and to **GitHub Repo Settings → Secrets → Actions** (so `.github/workflows/migration-qa.yml` runs Phase B SDK review on `migration`-labeled PRs).
3. Create labels `migration`, `component:word-count`, `component:outline-toc`, and `component:markdown-blocks`, and enable **Branch Protection on `main`** requiring both the `Migration QA Gate` status check and `CODEOWNERS` human approval (no agent can self-merge).

---

## Architecture Summary

```
Human Platform Lead (CODEOWNERS / Final Approver)
   ├── Parallel Legacy Track: packages/desktop + packages/muya (ships features normally)
   └── Migration Track:
        1. `pnpm migration:dispatch` (@cursor/sdk Cloud Runtime + .cursor/environment.json)
               └─► Opens PR labeled `migration` (`autoCreatePR: true`, `skipReviewerRequest: true`)
        2. `pnpm migration:qa` (Identical CLI locally & in `.github/workflows/migration-qa.yml`)
               ├─► Phase A (Deterministic): cargo test (incl. headless GPUI #[gpui::test]), clippy,
               │   5-file Golden Corpus Parity diff, p50/p95 + RSS benchmark, Policy Guardrails
               └─► Phase B (Agentic, @cursor/sdk): Scoped QA review over diff + Phase A artifacts
               └─► Posts PR Scorecard comment & blocks merge on exit code 1 or 2
        3. Staged Rollout via `config/migration-flags/{dev,staging,prod}.json`
               `legacy` ─► `shadow` (dual-run diff) ─► `migrated`
```

---

## Measured Before vs. After Results (Verified Locally)

Measured on `evals/corpus/05-large-benchmark.md` (68 KB, 1,922 lines, 150 iterations) via `./run-demo.sh --deterministic-only`:

| Component | Golden Corpus Parity | p50 Latency (Legacy TS → Rust) | p95 Latency (Legacy TS → Rust) | Peak RSS Memory (Node TS → Rust) | Status |
|---|---|---|---|---|---|
| `word-count` | **5/5 (100.0%)** | `0.492 ms` → **`0.116 ms` (4.24x faster)** | `0.973 ms` → **`0.273 ms` (3.56x faster)** | `565.5 MB` → **`2.1 MB` (264x lower)** | `dev`/`staging`: migrated, `prod`: shadow (25%) |
| `outline-toc` | **5/5 (100.0%)** | `0.508 ms` → **`0.358 ms` (1.42x faster)** | `1.340 ms` → **`0.587 ms` (2.28x faster)** | `566.4 MB` → **`4.3 MB` (132x lower)** | `dev`: migrated, `staging`: shadow (100%), `prod`: legacy |
| `markdown-blocks` | Target (`NOT_MIGRATED`) | Routed safely to `legacy-ts` | Fallback drill verified (`fellBackToLegacy=true`) | — | Ready for Cloud Agent dispatch |

---

## Built & Working vs. Design Only

### Built & Working (Verified End-to-End)
- **Upstream MarkText monorepo (`packages/desktop`, `packages/muya`)** integrated intact as the ~111k LOC legacy baseline.
- **Rust workspace (`rust/crates/marktext-core`)** with 100% parity ports of MarkText's `wordCount` (CJK `\u4E00-\u9FA5` + UTF-16 lengths) and `outline-toc` (ATX/setext headings, fence skipping, Unicode GitHub slugs `#5292`), plus the unmigrated `markdown-blocks` contract stub and `marktext-core-cli` benchmark runner (13/13 unit tests, 0 clippy warnings).
- **Native Zed GPUI desktop app (`rust/crates/marktext-gpui`, `gpui 0.2.2`)** rendering live mid-migration MarkText UI (environment switcher `dev`/`staging`/`prod`, migration flag pills, interactive outline sidebar, document pane with legacy fallback banner, live Rust stats status bar) + **headless `#[gpui::test]` UI verification suite** (2/2 tests passing without a display server).
- **TypeScript `@cursor/sdk@1.4.2` CLI (`tools/migration-sdk/`)**: Cloud Agent dispatcher (`dispatch`), deterministic Phase A + `@cursor/sdk` Phase B QA gate (`qa`), strangler-fig router (`legacy`/`shadow`/`migrated` + automatic fallback), composable policy guardrails (`prod.json` & `CODEOWNERS` hard blocks), JSON telemetry ledger (`evals/runs/`), and one-command `demo` (31/31 Vitest tests passing).
- **Cursor Cloud Agent environment (`.cursor/Dockerfile`, `.cursor/environment.json`, `.cursor/rules/migration.mdc`)** and **GitHub governance (`.github/CODEOWNERS`, `.github/workflows/migration-qa.yml`)**.
- **Explicitly out of scope (not used):** Cursor Automations, BugBot, and Security Review.

### Design Only / Future Production Hardening
- **In-process Electron ↔ Rust IPC (`napi-rs`) inside `packages/desktop`:** Currently `tools/migration-sdk` bridges to `marktext-core-cli` over a subprocess JSON contract so benchmarks and parity checks are portable across Node, CI, and Cloud VMs; wiring a `napi-rs` native addon directly into MarkText's Electron renderer is next.
- **Automated `staging` → `prod` Flag Promotion Bot:** Production flag changes are intentionally human-only today (`no-prod-flag-mutation` hard block); an automated promotion-PR generator gated on 7-day staging shadow telemetry (parity ≥ 99.99%, crash-free rate) is designed but not implemented.
- **Pixel-level Electron vs. GPUI visual screenshot diffing:** Headless GPUI structural/state tests (`#[gpui::test]`) run in CI today; cross-renderer Chromium-vs-Metal/Vulkan perceptual image diffing (SSIM/LPIPS tolerant to subpixel font antialiasing) is left for week 2.
- **Enterprise SSO / LaunchDarkly / Datadog export:** Feature flags live in git-versioned JSON files and telemetry writes to local JSON artifacts; integrating LaunchDarkly SDK + OpenTelemetry export is documented in `docs/WRITEUP.md`.
