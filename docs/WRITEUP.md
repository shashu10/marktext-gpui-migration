# Architecture & Rollout Write-Up (1–2 Pages Max)

> Deliverable template aligned with the AI SDLC take-home brief. Keep final version crisp and under 2 pages.

## 1. The Problem & Who Has It
- Enterprise persona, industry context, and exact SDLC bottleneck.
- Why existing manual or naive chat-sidebar workflows fail under enterprise constraints (multiple environments, CI, permissions, approval gates).

## 2. Architecture
- System components: orchestrator / Agent SDK / Cloud Agent custom environment / deterministic gates / human approval boundary.
- Clear boundary between what is **deterministic** vs. **agentic**.

## 3. Key Design Decisions & Trade-Offs
- Runtime choice (Cloud Agent vs. Local SDK vs. hybrid) and why.
- Safety, blast-radius containment, and permission model.
- Why specific alternatives were rejected for this scope.

## 4. How We Know It Works (Before / After & Rollout Metrics)
- **Before vs. After** on the chosen synthetic enterprise workflow.
- **Production Rollout Metrics:**
  - Time saved / cycle time reduction
  - PRs merged vs. rejected
  - Failure and retry rates
  - Cost per run (compute/tokens + human review minutes)

## 5. Built & Working vs. Design Only
- Explicit breakdown of what runs live today vs. what is architectural design for production hardening.

## 6. Where It Fails (Limitations & Failure Modes)
- Concrete failure modes observed or expected (flaky CI, ambiguous specs, environment drift, context limits, non-deterministic edits) and current mitigations.

## 7. What We Would Do With Another Week
- Highest-leverage next steps to move from prototype to durable customer-owned production rollout.
