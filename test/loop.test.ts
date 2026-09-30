/**
 * Loop supervision: the deterministic backstop, the model's judgement, and the
 * boundary between them.
 */

import { describe, expect, it } from "vitest";

import { runAgent } from "../src/agent.js";
import { FakeDecider } from "../src/decider/fake.js";
import { GATE_KEYS, JUDGE_KEYS } from "../src/decider/questionsets.js";
import { KEEP_GOING, LOOPING, SAFE_GATE, harness, pickTool, readTool, searchToolStub } from "./helpers.js";

/** Always select the same tool; judge behaviour is what varies. */
function repeatingAgent(judge: Record<string, unknown>, hardStepLimit?: number) {
  const decider = new FakeDecider((request) => {
    if (JUDGE_KEYS.complete in request.questions) return judge as never;
    if (GATE_KEYS.destructive in request.questions) return SAFE_GATE;
    return pickTool("search");
  });

  const { registry, tracer } = harness([readTool(), searchToolStub()]);

  return runAgent("find the thing", {
    decider,
    registry,
    tracer,
    ...(hardStepLimit === undefined ? {} : { hardStepLimit }),
  });
}

describe("loop supervision", () => {
  it("stops on a detected loop well before the hard limit", async () => {
    const run = await repeatingAgent(LOOPING);

    expect(run.stopReason).toBe("loop_detected");
    expect(run.summary).toMatch(/looping/);
  });

  it("keeps going when repetition is still making progress", async () => {
    // The model reports looping but also real progress: not a stop condition.
    const run = await repeatingAgent({
      ...LOOPING,
      [JUDGE_KEYS.progress]: { type: "score", score: 1.5, legend: {}, probabilities: {}, confidence: 0.8 },
    });

    expect(run.stopReason).toBe("step_limit");
  });

  it("lets the hard limit win even when the model says it is done", async () => {
    // Every judge signal is healthy; only the step count can stop this.
    const run = await repeatingAgent({ ...KEEP_GOING }, 3);

    expect(run.stopReason).toBe("step_limit");
    expect(run.steps).toHaveLength(3);
    expect(run.summary).toMatch(/hard limit/);
  });

  it("does not let a completion claim shortcut the backstop", async () => {
    const decider = new FakeDecider((request) => {
      if (JUDGE_KEYS.complete in request.questions) {
        return { ...KEEP_GOING, [JUDGE_KEYS.complete]: { type: "noul", noul: 0.99 } };
      }
      if (GATE_KEYS.destructive in request.questions) return SAFE_GATE;
      return pickTool("search");
    });
    const { registry, tracer } = harness([readTool(), searchToolStub()]);

    // At the limit the model insists it is finished; the limit is what fires.
    const run = await runAgent("endless", { decider, registry, tracer, hardStepLimit: 1 });

    expect(run.stopReason).toBe("step_limit");
  });
});

describe("the loop really loops", () => {
  it("keeps iterating until a stop condition fires", async () => {
    let judgeCalls = 0;

    const decider = new FakeDecider((request) => {
      if (JUDGE_KEYS.complete in request.questions) {
        judgeCalls += 1;
        // Completes only on the fourth look.
        return judgeCalls >= 4
          ? { [JUDGE_KEYS.complete]: { type: "noul", noul: 0.97 }, [JUDGE_KEYS.looping]: { type: "noul", noul: 0.02 }, [JUDGE_KEYS.progress]: { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.9 } }
          : KEEP_GOING;
      }
      if (GATE_KEYS.destructive in request.questions) return SAFE_GATE;
      return pickTool("search");
    });

    const { registry, tracer } = harness([readTool(), searchToolStub()]);
    const run = await runAgent("search repeatedly", { decider, registry, tracer });

    expect(run.stopReason).toBe("complete");
    expect(run.steps).toHaveLength(4);
    expect(judgeCalls).toBe(4);
  });

  it("asks the model exactly three times per step", async () => {
    const decider = new FakeDecider((request) => {
      if (JUDGE_KEYS.complete in request.questions) return KEEP_GOING;
      if (GATE_KEYS.destructive in request.questions) return SAFE_GATE;
      return pickTool("search");
    });

    const { registry, tracer } = harness([readTool(), searchToolStub()]);
    const run = await runAgent("count the calls", { decider, registry, tracer, hardStepLimit: 3 });

    // One select, one gate and one judge per iteration.
    expect(run.steps).toHaveLength(3);
    expect(decider.calls).toHaveLength(9);
  });

  it("asks the gate all four questions in a single round trip", async () => {
    const decider = new FakeDecider((request) => {
      if (JUDGE_KEYS.complete in request.questions) return KEEP_GOING;
      if (GATE_KEYS.destructive in request.questions) return SAFE_GATE;
      return pickTool("read_file");
    });
    const { registry, tracer } = harness([readTool(), searchToolStub()]);

    await runAgent("read it", { decider, registry, tracer, hardStepLimit: 1 });

    const gateCall = decider.calls.find((call) => GATE_KEYS.destructive in call.questions);
    expect(gateCall).toBeDefined();
    expect(Object.keys(gateCall!.questions).sort()).toEqual(
      [GATE_KEYS.blastRadius, GATE_KEYS.destructive, GATE_KEYS.outsideScope, GATE_KEYS.reversibility].sort(),
    );
  });
});