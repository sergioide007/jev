# Code review

**Scope.** All 39 files. Baseline before touching anything: `tsc` clean, 86/86 tests green.
Every defect below was **reproduced with a probe** before it was fixed, and every fix has a
regression test in `test/hardening.test.ts` (30 tests; the sandbox and binder ones were
confirmed to fail against the original code). After: `tsc` clean, 116/116 green, `build`,
`demo` and the keyless `smoke` path all work.

**Verdict.** A strong foundation: the `Decider` seam, a pure policy module, fail-closed
defaults, an honest "what the tests do and don't prove" section. The problems were places where
the code *said* more than it *did*, mostly in the safety story.

## Findings

| # | Sev. | Finding | Evidence | Fix |
|---|---|---|---|---|
| 1 | High | The gate ignored the tool's declared `effect`. The only thing between the model and `rm -rf` inside the sandbox was the model's own probability. | `evaluateGate` with a benign answer for a `delete` tool → `allow` | `alwaysAskEffects` floor (default `delete`), overridable |
| 2 | High | Blast radius was read as an argmax. `single_record 0.45 / system 0.30 / external 0.20` passed as harmless. | Same | `severeMass` rule (≥ 0.30 on system+external → `ask_user`); `deny` stays on the argmax |
| 3 | High | The step-limit backstop could be disabled: `hardStepLimit: NaN` never fires (`n >= NaN` is false). | `evaluateLoop(…, 50, NaN)` → `continue` | `assertValidThresholds` at start; comparison written `!(n < limit)` |
| 4 | Med | Sandbox: `link/new.txt`, with `link` → outside, passed a lexical check because `realpath` failed on the missing leaf. Dangling symlinks likewise. Latent (no write tool yet) but the docs invite one. | Probe resolved to a path under root | Resolve the deepest existing ancestor; refuse dangling links; `path.relative` containment |
| 5 | Med | A comment claimed the Score length check ran "before we ever get here". `assertQuestionSet` lived in the **test double** and `JevDecider` never called it. The 10-level Score cap was checked nowhere. | grep | Moved to `questionsets.ts`; called by `JevDecider` and `FakeDecider` |
| 6 | Med | Apostrophes were parsed as quotes: `Don't … 'ledger'` bound `t stop until you search for`. | Probe | Quotes must open after a non-word char and close on the same char |
| 7 | Med | The Quick start said `cp .env.example .env`, but nothing loads `.env` (the SDK reads `process.env` only). | SDK source | Scripts use `--env-file-if-exists=.env`; `engines.node` ≥ 22.9 |
| 8 | Med | A decider failure (5xx, quota) escaped `runAgent` and the trail was lost. | Reading | `AgentError` with `steps`, `transcript`, `cause` |
| 9 | Low | `listModels()` returned the `Models` resource, not the list. | Probe | `client.models.list()` |
| 10 | Low | `read_file`, `search`, `count_matches` read whole files before capping; a 2 GB log allocates 2 GB. | Reading | Capped reads; oversized files skipped **and reported** |
| 11 | Low | Docs: Decision 4's rationale was inverted (a model reporting *completion* stops the loop; the risk is *continue* forever). "~1–2 s a step" overstated 3 × 70–500 ms. Stale "request early access" text. | Reading | Rewritten |
| 12 | Low | Caret range on a 0.x SDK while the docs say to pin. | `package.json` | Exact `0.6.0` |

## Deliberately not changed

Documented in `architecture.md` → *Known limitations* instead, because each is a design
decision that belongs to the owner:

- No "none of these applies" option in the selection Choice; the instruction says to pick the
  least harmful tool. Add a sentinel.
- A low-confidence selection ends the run without consulting the `EscalationHandler`.
- The default binder returns empty args when the last observation already has the term, which
  produces a failing step and a paid gate call.
- Adversarial text in `state` can still move the model's probabilities. Field separation stops
  question-rewriting only; the effect floor and sandbox are the real defence.
- `FakeDecider`'s `choiceAnswer` does not sum to 1 when weights differ from 1 or `others` is
  empty. Test double only; the new tests pass explicit distributions.
- The hard limit is checked before completion, so a goal met on the last step is labelled
  `step_limit`. Conservative and defensible; it changes only the label.
- Thresholds are unvalidated. Measure calibration on a labelled set before tuning.

## External claims, checked

| Claim | Result |
|---|---|
| Launch 15 Sep 2026; System One; `jev-1.13.0`; 70–500 ms; $0.042/MTok in, output free | Consistent across the launch coverage. Latency, price and evals are **vendor-reported**; independent benchmarks are still emerging. |
| Choice up to 255 options; Score 2–10 levels; Noul yes/no probability | Matches the code and the published guides. |
| Node SDK `client.systemOne`, `choice/score/noul` builders, retry and timeout options | Matches `@typesafe-ai/sdk@0.6.0` types. |
| Python SDK in the LinkedIn post (`TypeSafeClient.system_one`, `Choice/Score/Noul`) | Matches `typesafe-sdk@0.7.2` on PyPI. |

## `linkedin-post.md`

Mostly accurate. Three edits: the "one million tickets ≈ $4" line now states its assumption
(~100 tokens each ≈ 100 MTok ≈ $4.20); "calibrated" is attributed to TypeSafe, since the evals
are the vendor's own; and a limit was added: early access, pin the model id.
