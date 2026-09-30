/**
 * Policy: every threshold in the system lives here, and nowhere else.
 *
 * Everything in this module is a pure function of its inputs. That is the point:
 * a reviewer can read the whole risk posture of the agent without opening a
 * single file that performs I/O, and every branch is unit-testable.
 *
 * WARNING — threshold/model coupling: these numbers were chosen against
 * jev-1.13.0's probability distribution. Tuning a threshold couples your code to
 * the distribution of the model version that produced it. Re-measure on your own
 * labelled data before changing anything, and pin the model id when you do.
 */

import type { BlastRadius, LoopAction, Verdict } from "./types.js";

export const JEV_MODEL_ID = "jev-1.13.0";

/** USD per million input tokens. Output tokens are not charged. */
export const COST_PER_MTOK_USD = 0.042;

/**
 * The full threshold set, in a shape callers can override.
 *
 * `as const` on the literal below gives compile-time safety to the defaults,
 * while this type lets a caller spread them and change one number.
 */
export type Thresholds = {
  readonly gate: {
    readonly destructive: number;
    readonly outsideScope: number;
    readonly irreversibleAbove: number;
    readonly hardDelete: number;
    readonly severeBlastRadius: readonly BlastRadius[];
  };
  readonly select: { readonly minConfidence: number };
  readonly loop: { readonly complete: number; readonly looping: number; readonly progressBelow: number };
  readonly hardStepLimit: number;
};

export const THRESHOLDS: Thresholds = {
  gate: {
    /** Noul above this counts as "this action destroys data". */
    destructive: 0.6,
    /** Noul above this counts as "this action is outside the requested task". */
    outsideScope: 0.5,
    /** Reversibility score above this is irreversible or externally visible. */
    irreversibleAbove: 1.5,
    /** Noul above this is a hard delete, not an edit. */
    hardDelete: 0.9,
    /** Blast radii that can never execute unattended. */
    severeBlastRadius: ["system", "external"],
  },
  select: {
    /** Below this the model has no clear winner; escalate rather than guess. */
    minConfidence: 0.6,
  },
  loop: {
    /** Noul above this means the goal is satisfied. */
    complete: 0.85,
    /** Noul above this means the agent is repeating itself. */
    looping: 0.7,
    /** Score below this means that repetition produced no progress. */
    progressBelow: 0.6,
  },
  /** Deterministic backstop. Runs even while the model is supervising. */
  hardStepLimit: 8,
};

export type GateSignals = {
  destructive: number;
  outsideScope: number;
  /** 0 trivially reversible, 1 reversible with effort, 2 irreversible. */
  reversibility: number;
  blastRadius: BlastRadius;
};

export type GateDecision = {
  verdict: Verdict;
  /** Every rule that fired. Empty for `allow`. Feeds the trace. */
  reasons: string[];
};

/**
 * Screen a proposed call. Ordered from most to least severe so the returned
 * reason is always the strongest one that applied.
 *
 * `deny` is deliberately reachable without a human: a hard delete of
 * system-wide or external data is not a judgement call.
 */
export function evaluateGate(signals: GateSignals, thresholds = THRESHOLDS.gate): GateDecision {
  const reasons: string[] = [];

  const severe = (thresholds.severeBlastRadius as readonly string[]).includes(signals.blastRadius);

  if (signals.destructive >= thresholds.hardDelete && severe) {
    return {
      verdict: "deny",
      reasons: [
        `destructive ${signals.destructive.toFixed(2)} >= ${thresholds.hardDelete} against "${signals.blastRadius}" scope: not recoverable by asking a human`,
      ],
    };
  }

  if (signals.reversibility > thresholds.irreversibleAbove) {
    reasons.push(
      `reversibility ${signals.reversibility.toFixed(2)} > ${thresholds.irreversibleAbove}: irreversible or externally visible`,
    );
  }

  if (severe) {
    reasons.push(`blast radius "${signals.blastRadius}" is not executable unattended`);
  }

  if (signals.destructive > thresholds.destructive && signals.outsideScope > thresholds.outsideScope) {
    reasons.push(
      `destructive ${signals.destructive.toFixed(2)} > ${thresholds.destructive} combined with outside-scope ${signals.outsideScope.toFixed(2)} > ${thresholds.outsideScope}`,
    );
  }

  return reasons.length > 0 ? { verdict: "ask_user", reasons } : { verdict: "allow", reasons: [] };
}

export type LoopSignals = {
  complete: number;
  looping: number;
  /** 0 no progress, 1 incremental, 2 substantial. */
  progress: number;
};

export type LoopDecision = {
  action: LoopAction;
  reason: string;
};

/**
 * Decide whether to keep going. The hard step limit is evaluated first on
 * purpose: it is the only stop condition that cannot be talked out of by a
 * miscalibrated model, and it must hold even when the model says "continue".
 */
export function evaluateLoop(
  signals: LoopSignals,
  stepCount: number,
  thresholds = THRESHOLDS,
): LoopDecision {
  if (stepCount >= thresholds.hardStepLimit) {
    return {
      action: "break",
      reason: `deterministic backstop: step ${stepCount} reached the hard limit of ${thresholds.hardStepLimit}`,
    };
  }

  if (signals.complete >= thresholds.loop.complete) {
    return { action: "finish", reason: `completion ${signals.complete.toFixed(2)} >= ${thresholds.loop.complete}` };
  }

  if (signals.looping >= thresholds.loop.looping && signals.progress < thresholds.loop.progressBelow) {
    return {
      action: "break",
      reason: `looping ${signals.looping.toFixed(2)} >= ${thresholds.loop.looping} with progress ${signals.progress.toFixed(2)} < ${thresholds.loop.progressBelow}`,
    };
  }

  return { action: "continue", reason: "no stop condition met" };
}

/**
 * Whether a selection is trustworthy enough to act on. Kept separate from the
 * gate: an unconfident *choice of tool* is not a dangerous call, it is just an
 * unknown one, and it needs a different response.
 */
export function evaluateSelection(confidence: number, thresholds = THRESHOLDS.select): GateDecision {
  if (confidence < thresholds.minConfidence) {
    return {
      verdict: "ask_user",
      reasons: [`selection confidence ${confidence.toFixed(2)} < ${thresholds.minConfidence}: no clear winner`],
    };
  }
  return { verdict: "allow", reasons: [] };
}

export function estimateCostUsd(usage: { input_tokens: number }): number {
  return (usage.input_tokens / 1_000_000) * COST_PER_MTOK_USD;
}