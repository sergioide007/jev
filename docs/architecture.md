# Architecture

## The problem this shape solves

An agent that calls tools needs three judgements on every step: which tool fits, whether the
resulting call is safe, and whether the goal is already met. Those are small, bounded,
high-frequency questions sitting in the hot path — the exact shape a System One model is built
for, and the worst shape for a text-generating LLM, where every one of them costs a parse.

This harness puts Jev in the control layer and leaves everything else to code.

## Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ agent.ts            loop: select → gate → execute → judge        │
├──────────────────────────────────────────────────────────────────┤
│ policy.ts           every threshold, as pure functions          │
│ decider/            Decider interface + questionsets + adapters  │
│ tools/, sandbox.ts  effects, and the boundary they cannot cross  │
│ arguments.ts        deterministic argument derivation           │
│ trace.ts            JSONL forensics, cost accounting             │
└──────────────────────────────────────────────────────────────────┘
```

## Decision 1 — our own `Decider` interface

```ts
interface Decider {
  decide(request: DecideRequest): Promise<DecideResult>;
  readonly source: string;
}
```

`JevDecider` is a thin pass-through to `client.systemOne()`. `FakeDecider` implements the same
interface deterministically.

**Why not use the SDK types directly?** Because the control layer has to be verifiable without
credentials, in CI, at zero cost. With the seam, the entire policy and loop suite runs offline.

**What it costs.** The SDK's mapped-type inference (`ResultFor<Q[K]>`) is gone, so
`answers.tool.choice` is `string` rather than a union of our literals. We compensate by
authoring the question sets ourselves and narrowing every read through `expectChoice`,
`expectScore` and `expectNoul`, which throw `AnswerShapeError` on a type mismatch. Type safety
is enforced at the boundary that actually matters — the place where a question set and the code
reading it could drift apart — rather than everywhere.

## Decision 2 — three calls per step, not one

Select and gate are necessarily sequential: the gate needs the arguments of the tool that was
selected. Judge is independent of both and could be fused into the next select, but keeping it
separate makes the trace readable and the failure modes debuggable.

Within each call, all questions go in a single request because the API evaluates them in
parallel. The four gate questions cost one round trip. At $0.042 per million input tokens with
output free, the dominant cost is *how much state you send*, not how many questions you ask.

## Decision 3 — `deny` is reachable without a human

Most gate designs collapse to a binary: allow, or ask a person. That makes unattended operation
impossible, and it is why gates get tuned down.

Here a hard delete (`destructive >= 0.9`) against a `system` or `external` blast radius returns
`deny` outright. It is not a judgement call, and putting it in front of a human just teaches
people to click approve.

## Decision 4 — the hard step limit is checked first

`evaluateLoop` tests the step limit before it tests completion. If a miscalibrated model
reported 0.99 completion forever, the agent would never stop. The backstop has to be the thing
that cannot be argued with.

A model watching a loop is a *better* stop condition, never the only one — particularly when the
state it is reading was produced by the agent it is supervising.
## Decision 5 — arguments are deterministic

A `Choice` answer is a label, not a call. Jev cannot generate the arguments for the tool it
picked, because it cannot generate text.

So `arguments.ts` derives them: quoted term first, then a term introduced by a keyword, then a
path-like token. `bindArguments` is pluggable.

This is the honest cost of the pattern. Everything a frontier LLM would have done implicitly
between "the user wants the ledger count" and `count_matches({ pattern: "ledger" })` has to be
rebuilt as explicit code. It is deterministic, testable and reviewable — and it is work. The
alternative, a planner LLM upstream, is a different architecture and reintroduces the string
parsing this design exists to avoid.

## Decision 6 — hostile text is data, never instructions

Instructions in `questionsets.ts` are fixed strings that reference state fields *by name*. Tool
arguments, file contents and model output travel as named fields in `state`. Nothing from the
untrusted world is ever concatenated into a question.

If argument text could reach the instruction, the argument could rewrite the question judging
it. `test/security.test.ts` pins this with a fixture that argues for its own safety.

Layered on top: `sandbox.ts` refuses absolute paths, `..` traversal, null bytes and symlinks
that resolve outside the root — and the containment check requires a separator after the root,
so `/tmp/root-sibling` is not treated as inside `/tmp/root`.

## Decision 7 — log the distribution, not the verdict

`trace.ts` records every decision as JSON Lines with the complete probability distribution, the
model id, token usage and cost. When something gets through that should not have, the verdict
alone cannot tell you whether the model was wrong or the threshold was. The distribution is the
only forensic trail available.

## Known limitations

- **Thresholds are unvalidated against real data.** They are a defensible starting point, not a
  tuned configuration. Measure calibration on your own labelled set.
- **Selection is bounded by the catalogue.** Jev picks from the tools you registered; it cannot
  compose a sequence of tools you did not list.
- **Three round trips per step.** At 70–500 ms each, a step is ~1–2 s. Fine at $0.042/MTok, but
  not a sub-100 ms path.
- **The built-in argument binder is a heuristic.** Three regexes. Replace it for real use.
- **No planner, no streaming, no fine-tuning.** Out of scope by design.
- **The model is early access.** Pin the version and log it.

## Sources

- [TypeSafe — Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
  (launch, 15 September 2026)
- [TypeSafe — Confidence](https://docs.typesafe.ai/confidence) and
  [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing)
- [TypeSafe — Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents)
- [TypeSafe — JavaScript SDK reference](https://docs.typesafe.ai/sdk/javascript/)