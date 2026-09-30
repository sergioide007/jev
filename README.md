# jev — an agent control layer built on Jev

An agent harness where **Jev** ([TypeSafe AI's](https://typesafe.ai) System One model) does
the three jobs a model is actually good at in a control loop — *which tool fits*, *is this call
safe*, and *are we done yet* — while code keeps ownership of state, permissions and effects.

Jev does not generate text. That is not a limitation to work around; it is the reason it fits
here. It returns typed answers with calibrated probabilities, so there is no prose to parse,
no schema to validate, and no retry loop wrapped around a `JSON.parse`.

```
   ┌────────────────────────────────────────────────────────────┐
   │ 1. SELECT   Choice over the whole tool catalogue            │
   └───────────────────────────┬────────────────────────────────┘
                               ▼
   ┌────────────────────────────────────────────────────────────┐
   │ 2. GATE     Noul + Noul + Score + Choice on the call       │
   └───────────────────────────┬────────────────────────────────┘
                               ▼
   ┌────────────────────────────────────────────────────────────┐
   │ EXECUTE    deterministic sandboxed tool                    │
   └───────────────────────────┬────────────────────────────────┘
                               ▼
   ┌────────────────────────────────────────────────────────────┐
   │ 3. JUDGE    complete? looping? progress?                   │
   └───────────────────────────┬────────────────────────────────┘
                               └──▶ hard step limit (always active)
```

## Quick start

```bash
npm install
npm test          # 86 tests, offline, no credentials needed
npm run demo      # run an agent end to end against a fixture workspace
```

Against the real API:

```bash
cp .env.example .env      # then set TYPESAFE_API_KEY
npm run smoke             # one real call; prints the probability distributions
npm run demo -- --live    # the whole agent, live
```

## What each layer is responsible for

| Layer | File | Responsibility |
|---|---|---|
| Thresholds | `src/policy.ts` | Every number that turns a probability into a decision. Pure functions. |
| Transport | `src/decider/` | How we ask. `JevDecider` (real) and `FakeDecider` (deterministic double). |
| Questions | `src/decider/questionsets.ts` | The three question sets, as data. |
| Effects | `src/tools/`, `src/sandbox.ts` | What can actually happen, and where. |
| Loop | `src/agent.ts` | Orchestration. I/O only. |
| Forensics | `src/trace.ts` | Full probability distribution per decision, as JSON Lines. |
| Arguments | `src/arguments.ts` | Deterministic argument derivation (see below). |

**The gate advises; the runtime enforces.** A path outside the sandbox is refused in
`sandbox.ts` no matter what the model concluded. That separation is the entire design.

## The three primitives

| Primitive | Question | Returns |
|---|---|---|
| `Choice` | which of these options? | `choice`, `probabilities`, `confidence` |
| `Score` | which level of this rubric? | `score`, `legend`, `probabilities`, `confidence` |
| `Noul` | is this true? | `noul` (0–1) — **no** `confidence` field |

Every question in a request is evaluated in parallel, so the four gate questions cost one
round trip, not four.

## The default policy

All of it lives in `src/policy.ts` and nothing else in the codebase compares a probability to a
number.

- **Gate** — `deny` when destructive >= 0.9 against a `system`/`external` blast radius;
  `ask_user` when the action is irreversible, when the blast radius is severe, or when it is
  both destructive and outside the requested scope.
- **Selection** — `ask_user` below 0.6 confidence: no clear winner means escalate, not guess.
- **Loop** — `finish` at complete >= 0.85; `break` when looping >= 0.7 with progress < 0.6;
  and the hard step limit is checked *first*, so it holds even when the model insists it is
  finished.

## Two things worth knowing before you rely on this

**1. The test suite proves your policy, not the model's answers.** `FakeDecider` scripts
distributions and asserts what the runtime does with them. That is enough to trust the branch
logic, the sandbox and the loop. It says nothing about whether 0.85 is the right threshold
*for your data*. Run `npm run smoke`, then measure calibration on a labelled set before you tune
anything.

**2. A Choice answer is a label, not a call.** Jev can tell you which tool fits; it cannot
produce that tool's arguments, because it cannot generate text. So arguments come from
`src/arguments.ts`, deterministically. This is the real cost of the pattern: everything a
frontier LLM would have done implicitly between intent and a function call has to be rebuilt
explicitly. Pass your own `bindArguments` when the built-in extraction is too naive.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Full suite, offline and deterministic |
| `npm run test:watch` | Same, in watch mode |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm run build` | Emit `dist/` with declarations |
| `npm run demo` | Agent run against a throwaway fixture workspace |
| `npm run smoke` | One real API call, needs `TYPESAFE_API_KEY` |

## Versions

Jev is in early access and moving. The harness pins `jev-1.13.0` and records the versioned model
id from every response. Tuning a threshold couples your code to the distribution that produced
it — keep the model id in your logs so you can tell when it moves underneath you.

See `docs/architecture.md` for the design decisions and the tradeoffs.