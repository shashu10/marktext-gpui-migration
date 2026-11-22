# Enterprise Architecture Runbook

This document exercises **MarkText** legacy TypeScript subsystems alongside migrated **Rust + Zed GPUI** modules during an active strangler-fig rollout.

## Executive Summary

Migration teams operate in the messy middle: legacy Electron features continue shipping while high-frequency subsystems move incrementally to Rust behind environment-scoped feature flags.

- [x] Migrate `word-count` (CJK-aware statistics)
- [x] Migrate `outline-toc` (ATX & setext headings + Unicode GitHub slugs)
- [ ] Migrate `markdown-blocks` via Cursor Cloud Agent PR

### Code Fence Trap (Must Not Appear in Outline)

```markdown
# Not A Real Heading Inside Backticks
## Also Ignored In TOC
Fake Setext Inside Fence
========================
```

~~~rust
// Tilde-fenced code block with fake heading comments
# Not A Heading Either
fn main() {
    println!("Hello GPUI");
}
~~~

Legacy Setext Section
=====================

> Every automated migration PR requires deterministic parity verification, performance benchmarking, SDK QA review, and human CODEOWNERS approval before merge.

Subsection Under Setext
-----------------------

---

## Rollout Checklist

1. Verify `dev` mode renders natively in GPUI.
2. Run `staging` in shadow dual-run mode at 100% sample rate.
3. Require human-reviewed PR to promote `config/migration-flags/prod.json`.
