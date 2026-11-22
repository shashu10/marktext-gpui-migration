# Architecture — MarkText → MarkText-GPUI ("The Messy Middle" AI SDLC)

## 1. Enterprise Problem Statement

Enterprise software teams cannot freeze product development for 6–12 months to perform a big-bang rewrite of a 100k+ LOC client application. Yet maintaining legacy Electron/JavaScript codebases carries steep performance, memory, and runtime-reliability costs.

This prototype demonstrates **the messy middle** of an incremental, **strangler-fig ("Ship of Theseus") migration** of **[MarkText](https://github.com/marktext/marktext)** (a ~111k LOC open-source Electron/TypeScript Markdown editor) toward a native **Rust + Zed GPUI** desktop application — **while the legacy Electron app continues shipping features in parallel**.

---

## 2. System Overview

```
                    ┌──────────────────────────────────────────┐
                    │   Developer / Platform Lead (Human)      │
                    │  • Owns migrations/<component>.json      │
                    │  • Final required PR approver (CODEOWNERS)│
                    └──────────────────┬───────────────────────┘
                                       │
              ┌────────────────────────┴────────────────────────┐
              ▼                                                 ▼
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│  1. Dispatch Cloud Agent     │                 │  Parallel Legacy Track       │
│  pnpm migration:dispatch     │                 │  packages/desktop + muya     │
│  (@cursor/sdk Cloud Runtime) │                 │  (Normal feature PRs ship    │
│  • Custom .cursor/env VM     │                 │   without waiting on Rust)   │
│    (Node 22 + pnpm + Rust +  │                 └──────────────────────────────┘
│     GPUI deps pre-installed) │
│  • Opens PR labeled          │
│    `migration`               │
└──────────────┬───────────────┘
               │ GitHub PR (label: `migration`, auto-merge BLOCKED)
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  2. Independent QA & Verification Gate                                      │
│     (Identical CLI: `pnpm migration:qa` locally & in GitHub Actions)        │
│                                                                             │
│  Phase A — Deterministic Harness (Fast, Zero-Hallucination)                 │
│   1. Build & Tests: `cargo test --workspace` (incl. GPUI headless TestApp), │
│      `cargo clippy`, MarkText TS checks                                     │
│   2. Golden Corpus Parity: Legacy TS vs. Rust `marktext-core` on tricky     │
│      Markdown corpus (GFM tables, fences, unicode, malformed, stress docs)  │
│   3. Performance & Footprint Benchmark: p50/p95 latency, throughput,        │
│      peak RSS memory, binary/bundle delta                                   │
│   4. Enterprise Policy Gate:                                                │
│      • No direct edits to `config/migration-flags/prod.json`                │
│      • Legacy TS implementation preserved (strangler-fig intact)            │
│      • Diff stays within `migrations/<component>.json` allowed paths        │
│      • Meets performance & memory budgets                                   │
│                                                                             │
│  Phase B — Scoped `@cursor/sdk` QA Verification Agent                       │
│   • Reviews PR diff + Phase A artifacts for semantic regressions, unsafe    │
│     panics, flag leakage, edge-case drift                                   │
│   • Emits PASS_FOR_HUMAN_REVIEW / BLOCK + PR Scorecard + Eval Telemetry     │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  3. Human Approval & Staged Rollout (GitHub Branch Protection + Flags)      │
│     `legacy` → `shadow` (dual-run diff) → `migrated`                        │
│     Promoted per environment: `dev.json` → `staging.json` → `prod.json`     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Repository Layout & Parallel Agent Ownership Boundaries

| Path | Responsibility | Parallel Owner |
|---|---|---|
| `packages/desktop/`, `packages/muya/` | Upstream MarkText (~111k LOC Electron + TypeScript Muya editor) | Read-only baseline (except scoped feature-flag hooks / simulated legacy PR) |
| `config/migration-flags/{dev,staging,prod}.json` | Per-environment feature flags (`legacy` \| `shadow` \| `migrated`) | `agent-core` |
| `migrations/*.json` | Declarative component migration contracts (source, target, corpus, budgets, allowed paths) | `agent-core` |
| `rust/Cargo.toml`, `rust/crates/marktext-core/` | Pure Rust migrated subsystems (`word-count`, `outline-toc`, `markdown-blocks` target) + CLI runner for parity & benchmarks | `agent-rust-gpui` |
| `rust/crates/marktext-gpui/` | Native Zed GPUI desktop app rendering mid-migration MarkText UI + headless `#[gpui::test]` UI regression suite | `agent-rust-gpui` |
| `tools/migration-sdk/` | TypeScript CLI & `@cursor/sdk` integration (`dispatch`, `qa`, `demo`, deterministic harness, telemetry) | `agent-sdk-qa` |
| `evals/corpus/`, `evals/runs/` | Golden Markdown parity test corpus + JSON/Markdown run telemetry ledger | `agent-sdk-qa` |
| `.cursor/environment.json`, `.cursor/Dockerfile`, `.cursor/rules/migration.mdc` | Cursor Cloud Agent custom environment (Node 22 + pnpm + Rust + GPUI Linux deps) & agent guardrails | `agent-infra-gha` |
| `.github/workflows/migration-qa.yml`, `.github/CODEOWNERS` | GitHub Actions QA trigger on `migration`-labeled PRs + human-approval governance | `agent-infra-gha` |
| `README.md`, `docs/WRITEUP.md` | One-command quickstart, Cloud Agent env docs, 1–2 page executive/technical write-up | Coordinator |

---

## 4. Shared Contracts (Defined Before Parallel Fan-Out)

### 4.1 Environment Feature Flag Schema (`config/migration-flags/<env>.json`)
```json
{
  "environment": "staging",
  "components": {
    "word-count": {
      "mode": "migrated",
      "engine": "rust-core",
      "shadowSampleRate": 1.0,
      "fallbackOnError": true
    },
    "outline-toc": {
      "mode": "shadow",
      "engine": "legacy-ts",
      "shadowSampleRate": 1.0,
      "fallbackOnError": true
    },
    "markdown-blocks": {
      "mode": "legacy",
      "engine": "legacy-ts",
      "shadowSampleRate": 0.0,
      "fallbackOnError": true
    }
  }
}
```

### 4.2 Component Migration Spec (`migrations/<component>.json`)
```json
{
  "componentId": "outline-toc",
  "title": "Markdown Document Outline / TOC & GitHub Slug Extractor",
  "status": "migrated",
  "legacySource": "packages/desktop/src/renderer/src/util/sourceModeToc.ts & packages/muya/src/utils/slug.ts",
  "legacyHarnessEntry": "outline-toc",
  "rustModule": "rust/crates/marktext-core/src/outline_toc.rs",
  "rustSubcommand": "outline-toc",
  "gpuiView": "rust/crates/marktext-gpui/src/main.rs",
  "corpusDir": "evals/corpus",
  "allowedPaths": [
    "rust/crates/marktext-core/",
    "rust/crates/marktext-gpui/",
    "config/migration-flags/dev.json",
    "evals/corpus/"
  ],
  "forbiddenPaths": [
    "config/migration-flags/prod.json",
    ".github/CODEOWNERS",
    ".github/workflows/",
    "packages/desktop/src/renderer/src/util/sourceModeToc.ts",
    "packages/muya/src/utils/slug.ts"
  ],
  "perfBudget": {
    "minSpeedupRatio": 1.2,
    "maxP95Ms": 10.0,
    "requireExactParity": true
  }
}
```

### 4.3 `marktext-core` CLI Parity Interface
`marktext-core-cli <subcommand> --input <file.md> [--iterations N]`
- Subcommands: `word-count`, `outline-toc`, `markdown-blocks`
- Outputs deterministic JSON to stdout:
  ```json
  {
    "component": "outline-toc",
    "engine": "rust-core",
    "output": { "...": "..." },
    "metrics": {
      "iterations": 200,
      "p50Ms": 0.04,
      "p95Ms": 0.09,
      "meanMs": 0.05,
      "peakRssKb": 4120
    }
  }
  ```

### 4.4 Exit Code Contract (All CLI Commands)
- `0` — Success (`PASS_FOR_HUMAN_REVIEW` for QA, or `finished` for Cloud Agent dispatch)
- `1` — Startup, configuration, auth, or network failure (`CursorAgentError` — respect `isRetryable`)
- `2` — Execution or verification failure (`result.status === "error"`, parity mismatch, test failure, policy violation, or QA verdict `BLOCK`)

---

## 5. Built-In 15-Minute Live Extension Seams

The architecture is intentionally modular so any of these can be added and verified live in <15 minutes during the onsite:
1. **Add a new policy guardrail** in `tools/migration-sdk/src/qa/policy.ts` (e.g., max WASM/binary size delta or mandatory GPUI headless test check).
2. **Add a tricky edge-case Markdown fixture** to `evals/corpus/` and watch the parity harness + QA agent catch and block a regression live.
3. **Add a new migration spec** (`migrations/search-index.json`) and dispatch a Cloud Agent against it.
4. **Add an environment promotion gate** (`staging` shadow parity == 100% + p95 speedup ≥ 2x → generate `prod.json` promotion PR).
