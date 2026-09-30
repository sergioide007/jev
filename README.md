# jev — an agent control layer built on Jev

An agent harness where **Jev** ([TypeSafe AI's](https://typesafe.ai) System One model) does the
three jobs a model is actually good at in a control loop — *which tool fits*, *is this call
safe*, and *are we done yet* — while code keeps ownership of state, permissions and effects.

Jev does not generate text. That is not a limitation to work around; it is the reason it fits
here. It returns typed answers with probabilities, so there is no prose to parse, no schema to
validate, and no retry loop wrapped around a `JSON.parse`.

![Architecture: Jev decides, code enforces](docs/img/architecture.svg)

*Green is deterministic code you own and can unit-test. Indigo is the only probabilistic part.
The model advises; the runtime enforces. (PNG copies of every diagram sit next to the SVGs in
[`docs/img/`](docs/img/).)*

## Quick start

```bash
npm install
npm test          # 116 tests, offline, no credentials needed
npm run demo      # run an agent end to end against a fixture workspace
```

Requires **Node ≥ 22.9** (the scripts use `--env-file-if-exists`). Against the real API:

```bash
cp .env.example .env      # then set TYPESAFE_API_KEY; the scripts load it for you
npm run smoke             # one real call; prints the probability distributions
npm run demo -- --live    # the whole agent, live
```

## One step of the loop

![One step of the control loop](docs/img/control-loop.svg)

Three Jev calls per step, each carrying several questions that the API evaluates in parallel,
so the four gate questions cost **one** round trip, not four. Select and gate are sequential
(the gate needs the arguments of the selected tool); judge is independent and kept separate so
the trace stays readable.

## How the gate decides

![evaluateGate: from probabilities to a verdict](docs/img/gate-decision.svg)

The gate looks at the whole distribution and at a fact the model cannot argue with — the
tool's declared `effect` — not just at the model's top label. See
[`docs/architecture.md`](docs/architecture.md) for why.

### The default policy

Every number lives in `src/policy.ts`; nothing else in the codebase compares a probability to a
threshold.

| Stage | Rule | Outcome |
|---|---|---|
| Select | confidence < 0.6 | `escalated` — no clear winner means ask, not guess |
| Gate | destructive ≥ 0.9 **and** argmax blast radius ∈ {system, external} | `deny` |
| Gate | reversibility > 1.5 · argmax ∈ {system, external} · P(system)+P(external) ≥ 0.30 · destructive > 0.6 **and** outside_scope > 0.5 · tool effect ∈ `alwaysAskEffects` (`delete`) | `ask_user` |
| Judge | steps ≥ 8 (checked first) | `step_limit` |
| Judge | complete ≥ 0.85 | `complete` |
| Judge | looping ≥ 0.7 **and** progress < 0.6 | `loop_detected` |

`alwaysAskEffects` and `severeMass` are overridable; `assertValidThresholds` refuses to start an
agent whose backstop would be silently disabled (a `NaN`, zero or fractional step limit).

## What each layer is responsible for

| Layer | File | Responsibility |
|---|---|---|
| Thresholds | `src/policy.ts` | Every number that turns a probability into a decision. Pure functions. |
| Transport | `src/decider/` | How we ask. `JevDecider` (real) and `FakeDecider` (deterministic double). |
| Questions | `src/decider/questionsets.ts` | The three question sets as data, and the limit checks both deciders enforce. |
| Effects | `src/tools/`, `src/sandbox.ts` | What can actually happen, and where. |
| Loop | `src/agent.ts` | Orchestration. I/O only. Failures surface as `AgentError` with the partial trail. |
| Forensics | `src/trace.ts` | Full probability distribution per decision, as JSON Lines. |
| Arguments | `src/arguments.ts` | Deterministic argument derivation (see below). |

**The gate advises; the runtime enforces.** A path outside the sandbox is refused in
`sandbox.ts` no matter what the model concluded, and a tool declared `delete` never runs
unattended no matter what the model estimated. That separation is the entire design.

## The three primitives

| Primitive | Question | Returns | Limits |
|---|---|---|---|
| `Choice` | which of these options? | `choice`, `probabilities`, `confidence` | 2–255 options |
| `Score` | which level of this rubric? | `score`, `legend`, `probabilities`, `confidence` | 2–10 levels |
| `Noul` | is this true? | `noul` (0–1) — **no** `confidence` field | — |

## Things worth knowing before you rely on this

**1. The test suite proves your policy, not the model's answers.** `FakeDecider` scripts
distributions and asserts what the runtime does with them. That is enough to trust the branch
logic, the sandbox and the loop. It says nothing about whether 0.85 is the right threshold *for
your data*. Run `npm run smoke`, then measure calibration on a labelled set before you tune
anything.

**2. A Choice answer is a label, not a call.** Jev can tell you which tool fits; it cannot
produce that tool's arguments, because it cannot generate text. Arguments come from
`src/arguments.ts`, deterministically. Pass your own `bindArguments` when the built-in
extraction is too naive.

**3. Data in `state` is not automatically safe.** Instructions are fixed strings that reference
state fields by name, so untrusted text can never *rewrite a question*. But the model still
reads that text, and adversarial content can shift its probabilities. The defence is layered:
the declared-effect floor and the sandbox do not depend on the model being right.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Full suite, offline and deterministic |
| `npm run test:watch` | Same, in watch mode |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm run build` | Emit `dist/` with declarations |
| `npm run demo` | Agent run against a throwaway fixture workspace |
| `npm run smoke` | One real API call, needs `TYPESAFE_API_KEY` |

To regenerate the diagrams: `python3 docs/img/build_diagrams.py` (add `pip install cairosvg`
for the PNGs).

## Versions

Jev launched in early access on 15 September 2026 and is moving. The harness pins `jev-1.13.0`
and the SDK at an exact version, and records the versioned model id from every response.
Tuning a threshold couples your code to the distribution that produced it — keep the model id in
your logs so you can tell when it moves underneath you.

More: [`docs/architecture.md`](docs/architecture.md) (design decisions and tradeoffs) ·
[`docs/REVIEW.md`](docs/REVIEW.md) (what a code review found, what was fixed, what was left).
