import { describe, expect, it } from "vitest";

import {
  COST_PER_MTOK_USD,
  THRESHOLDS,
  estimateCostUsd,
  evaluateGate,
  evaluateLoop,
  evaluateSelection,
} from "../src/policy.js";
import type { GateSignals, LoopSignals } from "../src/policy.js";

/** Signals that describe an obviously safe, read-only action. */
const SAFE: GateSignals = {
  destructive: 0.02,
  outsideScope: 0.05,
  reversibility: 0,
  blastRadius: "single_record",
};

const gate = (overrides: Partial<GateSignals> = {}): GateSignals => ({ ...SAFE, ...overrides });

const loop = (overrides: Partial<LoopSignals> = {}): LoopSignals => ({
  complete: 0.1,
  looping: 0.1,
  progress: 2,
  ...overrides,
});

describe("evaluateGate", () => {
  it("allows a plainly safe read", () => {
    const decision = evaluateGate(SAFE);

    expect(decision.verdict).toBe("allow");
    expect(decision.reasons).toEqual([]);
  });

  it("holds an irreversible action for approval", () => {
    const decision = evaluateGate(gate({ reversibility: 2 }));

    expect(decision.verdict).toBe("ask_user");
    expect(decision.reasons.join(" ")).toMatch(/irreversible/);
  });

  it("treats exactly-at-threshold reversibility as still reversible", () => {
    // 1.5 is the threshold and the rule is `>`, so the boundary itself is allowed.
    expect(evaluateGate(gate({ reversibility: THRESHOLDS.gate.irreversibleAbove })).verdict).toBe("allow");
  });

  it("holds system-wide and external blast radii", () => {
    expect(evaluateGate(gate({ blastRadius: "system" })).verdict).toBe("ask_user");
    expect(evaluateGate(gate({ blastRadius: "external" })).verdict).toBe("ask_user");
  });

  it("allows a project-wide write, which is not severe", () => {
    expect(evaluateGate(gate({ blastRadius: "project", reversibility: 1 })).verdict).toBe("allow");
  });

  it("needs both signals before flagging destructive and out of scope", () => {
    // Destructive alone is not enough: a delete can be exactly what was asked for.
    expect(evaluateGate(gate({ destructive: 0.9, outsideScope: 0.1 })).verdict).toBe("allow");
    // Out of scope alone is not enough either.
    expect(evaluateGate(gate({ destructive: 0.1, outsideScope: 0.9 })).verdict).toBe("allow");
    // Both together trip the rule.
    expect(evaluateGate(gate({ destructive: 0.9, outsideScope: 0.9 })).verdict).toBe("ask_user");
  });

  it("denies a hard delete against system or external scope without consulting a human", () => {
    const system = evaluateGate(gate({ destructive: 0.95, blastRadius: "system" }));
    const external = evaluateGate(gate({ destructive: 0.95, blastRadius: "external" }));

    expect(system.verdict).toBe("deny");
    expect(external.verdict).toBe("deny");
    expect(system.reasons.join(" ")).toMatch(/not recoverable/);
  });

  it("does not refuse a destructive action that is within the requested scope", () => {
    // Deleting one file is alarming, but if that is what the task asked for and
    // the blast radius is one record, there is nothing for a human to decide.
    expect(evaluateGate(gate({ destructive: 0.95, blastRadius: "single_record" })).verdict).toBe("allow");
  });

  it("still holds a destructive action once it leaves the requested scope", () => {
    expect(evaluateGate(gate({ destructive: 0.95, outsideScope: 0.9 })).verdict).toBe("ask_user");
  });

  it("reports every rule that fired, so the trace can explain itself", () => {
    const decision = evaluateGate(gate({ reversibility: 2, blastRadius: "external" }));

    expect(decision.reasons).toHaveLength(2);
  });
});

describe("evaluateLoop", () => {
  it("keeps going while nothing has triggered", () => {
    expect(evaluateLoop(loop(), 1).action).toBe("continue");
  });

  it("finishes on a high completion probability", () => {
    const decision = evaluateLoop(loop({ complete: 0.9 }), 3);

    expect(decision.action).toBe("finish");
    expect(decision.reason).toMatch(/completion/);
  });

  it("breaks on repetition with no progress", () => {
    const decision = evaluateLoop(loop({ looping: 0.9, progress: 0.2 }), 5);

    expect(decision.action).toBe("break");
    expect(decision.reason).toMatch(/looping/);
  });

  it("keeps going when repetition is still making progress", () => {
    // Looping alone is not a stop condition; a model retrying usefully is fine.
    expect(evaluateLoop(loop({ looping: 0.9, progress: 1 }), 5).action).toBe("continue");
  });

  it("treats the hard step limit as a backstop the model cannot override", () => {
    // Every signal says "keep going and you are done" — the limit still wins.
    const decision = evaluateLoop(loop({ complete: 0.99, looping: 0 }), THRESHOLDS.hardStepLimit);

    expect(decision.action).toBe("break");
    expect(decision.reason).toMatch(/deterministic backstop/);
  });

  it("checks the step limit before completion", () => {
    // At the limit, "complete" must not shortcut the backstop.
    expect(evaluateLoop(loop({ complete: 0.99 }), THRESHOLDS.hardStepLimit).action).toBe("break");
  });
});

describe("evaluateSelection", () => {
  it("allows a confident pick", () => {
    expect(evaluateSelection(0.8).verdict).toBe("allow");
  });

  it("escalates when there is no clear winner", () => {
    const decision = evaluateSelection(0.4);

    expect(decision.verdict).toBe("ask_user");
    expect(decision.reasons.join(" ")).toMatch(/no clear winner/);
  });
});

describe("estimateCostUsd", () => {
  it("charges the documented input rate", () => {
    expect(estimateCostUsd({ input_tokens: 1_000_000 })).toBeCloseTo(COST_PER_MTOK_USD, 10);
  });

  it("is free at zero tokens", () => {
    expect(estimateCostUsd({ input_tokens: 0 })).toBe(0);
  });

  it("scales linearly, so a million small calls stay affordable", () => {
    const perTicket = estimateCostUsd({ input_tokens: 1_000 });
    expect(perTicket * 1_000_000).toBeCloseTo(42, 6);
  });
});