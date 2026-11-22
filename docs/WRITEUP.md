# MarkText → MarkText-GPUI: Managing "The Messy Middle" with Cursor Cloud Agents & Agent SDK

## 1. The Problem & Who Has It

Enterprise engineering organizations maintaining large, revenue-critical client applications (100k+ LOC Electron/JS desktop apps, legacy web frontends, or monolith services) face a classic trap: **they cannot freeze product delivery for 6–12 months to execute a big-bang rewrite**, yet staying on legacy stacks imposes compounding costs in memory footprint (500+ MB per Electron window), tail latency on large documents, and runtime type failures.

The hardest phase of any enterprise migration is **"the messy middle"**: months where legacy features keep shipping on `main` while individual subsystems are incrementally re-implemented in a higher-performance target stack (here, **Rust + Zed's GPUI**), running side-by-side behind feature flags across `dev`, `staging`, and `prod`. Naive chat-sidebar AI coding fails here because unguided agents break legacy behavior, drift outside component boundaries, skip edge cases (e.g., CJK word boundaries or Unicode heading anchors), or touch production rollout configs without human approval.

**Target Persona:** Platform / Client Infrastructure Engineering Lead migrating an active ~111k LOC Electron Markdown editor (**MarkText**) to native **Rust + GPUI** while product engineers continue merging legacy MarkText PRs undisturbed.

---

## 2. Architecture

The prototype combines a **Cursor Cloud Agent custom environment**, a **TypeScript `@cursor/sdk` orchestrator & QA CLI**, a **strangler-fig feature-flag control plane**, and **GitHub PR governance**:

1. **Legacy Baseline (`packages/desktop`, `packages/muya`):** Upstream MarkText (`develop`, v0.24.0-dev) remains intact and unblocked for parallel legacy feature work.
2. **Incremental Rust + GPUI Track (`rust/`):**
   - `rust/crates/marktext-core`: Pure Rust ports of real MarkText subsystems (`word-count` from `packages/muya/src/utils/index.ts`; `outline-toc` from `packages/desktop/src/renderer/src/util/sourceModeToc.ts` + `packages/muya/src/utils/slug.ts` issue `#5292`), plus an intentionally unmigrated `markdown-blocks` contract stub as the live Cloud Agent target.
   - `rust/crates/marktext-gpui`: Native desktop preview built on Zed's **`gpui` (`0.2.2`)** rendering migrated subsystems (interactive outline sidebar, live Rust word-count status bar, live `dev`/`staging`/`prod` flag switcher, and legacy fallback banner for unmigrated panes), backed by headless `#[gpui::test]` UI verification tests.
3. **Cloud Agent Custom Environment (`.cursor/Dockerfile`, `.cursor/environment.json`, `.cursor/rules/migration.mdc`):** Pre-bakes Node 22, pnpm 10, Rust stable, and Linux GPUI build dependencies, and pre-warms `pnpm install && cargo fetch && cargo build -p marktext-core` during Cloud Agent Builds.
4. **TypeScript AI SDLC CLI (`tools/migration-sdk/` on `@cursor/sdk@1.4.2`):**
   - **Dispatch (`migration:dispatch`):** Launches a Cursor Cloud Agent (`cloud: { repos }`, `autoCreatePR: true`, `skipReviewerRequest: true`) from a declarative component spec (`migrations/<component>.json`), logging `agentId` + `run.id` immediately and enforcing strict exit codes (`0` finished, `1` `CursorAgentError` startup/config failure, `2` mid-run error).
   - **Two-Phase Independent QA Gate (`migration:qa`, run identically locally and in `.github/workflows/migration-qa.yml` on `migration`-labeled PRs):**
     - **Phase A (Deterministic Harness — Zero Hallucination):** Runs `cargo test --workspace` (including headless GPUI tests), `cargo clippy -D warnings`, 5-file golden corpus deep-parity diff (ASCII, CJK/Unicode `#5292`, edge cases, empty, 68KB stress doc), Before/After latency & RSS memory benchmarks, and composable **Policy Guardrails** (hard-blocking any edit to `prod.json`, `.github/CODEOWNERS`, `.github/workflows/`, legacy paths, or out-of-scope files).
     - **Phase B (Scoped `@cursor/sdk` QA Agent):** Read-only local agent reviewing *only* the PR diff + Phase A structured JSON report for semantic regressions (panics/`unwrap()`, edge-case drift, fallback bypasses), outputting `PASS_FOR_HUMAN_REVIEW` or `BLOCK` and posting the scorecard PR comment.
5. **Human Approval & Staged Rollout:** `.github/CODEOWNERS` + branch protection ensure no Cloud Agent or CI workflow can self-merge. Rollout progresses `legacy` → `shadow` (dual-run diff) → `migrated` across `dev.json` → `staging.json` → `prod.json`.

---

## 3. Key Design Decisions & Trade-Offs

| Decision | Choice Made | Trade-Off & Rationale |
|---|---|---|
| **Deterministic vs. Agentic Split** | Deterministic code owns tests, parity diffs, benchmarks, RSS memory, and policy blocks; `@cursor/sdk` QA Agent only reviews semantic risk. | LLMs hallucinate metrics and waste tokens on rules better enforced deterministically. Keeping Phase A deterministic makes CI fast, cheap, and auditable. |
| **Strangler-Fig Seam** | Subprocess JSON CLI (`marktext-core-cli`) + native `marktext-gpui` preview instead of jumping straight to Electron `napi-rs` bindings. | Subprocess parity works identically on macOS, Linux Cloud VMs, and GitHub Actions with zero Electron native-ABI friction; trades ~1ms IPC overhead in the test harness (mitigated by in-process iteration timing) for portability during a 4-hour build. |
| **Dual Runtime Strategy** | **Cloud Agent** for isolated migration PR generation (`dispatch`); **Local SDK** inside CI/CLI for read-only QA review (`qa`). | Cloud Agents give fresh, reproducible Linux VMs with pre-warmed Rust toolchains and real PR creation; running `qa` locally inside GitHub Actions reuses the exact PR checkout without double-cloning or waiting for a second VM. |
| **Strict Governance** | `skipReviewerRequest: true` on Cloud Agent runs + mandatory `CODEOWNERS` + `no-prod-flag-mutation` hard block. | Prevents noisy auto-pages during iteration while guaranteeing an agent can never flip production traffic or modify its own CI gates. |
| **No Silent Mocks** | `--deterministic-only` and `--dry-run` print explicit banners and mark SDK verdict `SKIPPED`. | Preserves radical transparency for both local dev without API keys and live executive demos. |

---

## 4. How We Know It Works (Before / After & Rollout Metrics)

### Measured Before vs. After (`./run-demo.sh --deterministic-only`, 68 KB / 1,922-line corpus, 150 iterations)
- **`word-count`:** **5/5 (100.0%) exact parity** (including CJK `\u4E00-\u9FA5` and UTF-16 emoji lengths); **4.24x faster p50** (`0.492 ms` → `0.116 ms`), **3.56x faster p95** (`0.973 ms` → `0.273 ms`), **264x lower peak RSS** (`565.5 MB` Node → `2.1 MB` Rust).
- **`outline-toc`:** **5/5 (100.0%) exact parity** (ATX/setext headings, fence skipping, Unicode `#5292` slugs); **1.42x faster p50** (`0.508 ms` → `0.358 ms`), **2.28x faster p95** (`1.340 ms` → `0.587 ms`), **132x lower peak RSS** (`566.4 MB` → `4.3 MB`).
- **Governance & Safety Proof:** 31/31 TypeScript tests + 15/15 Rust/GPUI tests (including headless `#[gpui::test]`) pass; fallback drill confirms Rust `NOT_MIGRATED` safely falls back to `legacy-ts`; simulated unauthorized PR touching `prod.json` & `CODEOWNERS` is `HARD_BLOCK`ed across 4 policy rules.

### What We Would Measure in a Real Enterprise Rollout
1. **Cycle Time & Hours Saved:** Median time from migration spec creation to merged PR vs. historical manual Rust port baseline (target: 3–5 days → <4 hours including human review).
2. **PR Quality (Merged vs. Rejected):** First-pass QA gate pass rate, human PR merge rate vs. rework/rejection rate, and post-merge escaped defect count.
3. **Reliability & Retries:** Cloud Agent startup failure rate (`exit 1` / `CursorAgentError`), mid-run failure rate (`exit 2`), average retries per component, and shadow-mode parity mismatch rate in `staging` (target: <0.01% before `prod` promotion).
4. **Unit Economics (Cost per Merged Component):** Combined Cursor Cloud Agent VM/token cost + QA review tokens + CI runner minutes + human reviewer minutes per migrated module.

---

## 5. Built & Working vs. Design Only

- **Built & Working:** Real MarkText monorepo baseline; Rust `marktext-core` (`word-count`, `outline-toc`, `markdown-blocks` stub, benchmark CLI); native Zed `gpui 0.2.2` mid-migration desktop app + headless `#[gpui::test]` suite; `@cursor/sdk@1.4.2` Cloud Agent dispatcher + Phase A/B QA CLI + policy guardrails + telemetry ledger; `.cursor/environment.json` + `.cursor/Dockerfile` + `.cursor/rules/migration.mdc`; `.github/CODEOWNERS` + `.github/workflows/migration-qa.yml`; one-command `./run-demo.sh`.
- **Design Only:** In-process `napi-rs` Electron bridge inside `packages/desktop`; automated 7-day staging telemetry → `prod.json` promotion PR generator; perceptual cross-renderer (Chromium vs. Metal/Vulkan) screenshot diffing; LaunchDarkly & OpenTelemetry production integrations.

---

## 6. Where It Fails (Limitations & Failure Modes)

1. **Ambiguous Legacy Specs & Implicit JS Quirks:** JavaScript's UTF-16 `.length` and Unicode regex nuances caused subtle parity risks until explicitly codified in golden corpus fixtures (e.g., surrogate-pair emojis and `\n{2,}` paragraph splits). Without comprehensive golden corpora, agents can pass unit tests while diverging on real user documents.
2. **Cold Rust / GPUI Compile Times in CI:** Compiling `gpui` from an empty Cargo cache takes minutes on small CI runners; mitigations require `Swatinem/rust-cache` in GitHub Actions and pre-warmed `.cursor/environment.json` Builds.
3. **Cross-Renderer Visual Parity:** Headless `#[gpui::test]` validates layout state and transitions deterministically, but pixel-level parity between Electron/Chromium and native Metal/Vulkan GPUI fails naive pixel diffs due to OS font hinting and subpixel antialiasing.
4. **Non-Deterministic Agent Edits:** Cloud Agents can occasionally touch helper files outside `allowedPaths` or leave `.unwrap()` calls; hard policy rules catch boundary violations reliably, but require a retry turn to clean up.

---

## 7. What We Would Do With Another Week

1. **Wire `napi-rs` directly into `packages/desktop`** so MarkText Electron calls `marktext-core` in-process behind a real LaunchDarkly/local feature flag with live shadow-diff telemetry.
2. **Add Automated Feedback-Loop Retries:** On Phase A parity failure, resume the same Cloud Agent (`Agent.resume(agentId)`) with the exact failing corpus diff (capped at max 2 retries, respecting `isRetryable`) before escalating to a human.
3. **Expand Eval Corpus with Fuzzing / Real OSS Markdown:** Property-based fuzzing (`proptest` vs. `fast-check`) over 1,000+ GitHub READMEs to catch edge-case drift before `staging`.
4. **Add Staging-to-Prod Promotion Gate & Cost Dashboard:** Emit OpenTelemetry metrics per run (tokens, VM seconds, speedup, shadow mismatch rate) and auto-open human-approvable `prod.json` promotion PRs once a module holds 100% shadow parity for 7 days.
