/**
 * The agent loop.
 *
 * Three Jev calls per iteration, each carrying parallel questions:
 *
 *   1. select  — one Choice over the whole tool catalogue
 *   2. gate    — Noul + Noul + Score + Choice on the selected call
 *   3. judge   — Noul + Noul + Score on the run so far
 *
 * Select and gate cannot be merged: the gate needs the arguments of the tool
 * that was selected, so they are necessarily sequential. Judge is independent of
 * both and could be fused into the next select, but keeping it separate makes the
 * trace far easier to read.
 *
 * This module performs I/O and orchestration only. Every threshold it applies
 * lives in `policy.ts` and every judgement comes back from the `Decider`.
 */

import { expectChoice, expectNoul, expectScore } from "./decider/types.js";
import { defaultArgumentBinder } from "./arguments.js";
import type { ArgumentBinder } from "./arguments.js";
import type { Answer, Decider } from "./decider/types.js";
import {
  GATE_KEYS,
  JUDGE_KEYS,
  SELECT_KEY,
  gateQuestion,
  judgeQuestion,
  selectQuestion,
} from "./decider/questionsets.js";
import { JEV_MODEL_ID, THRESHOLDS, evaluateGate, evaluateLoop, evaluateSelection } from "./policy.js";
import type { LoopDecision, Thresholds } from "./policy.js";
import type { BlastRadius, StopReason, Step, ToolCall, Verdict } from "./types.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { Tracer } from "./trace.js";

/**
 * What the caller does when the gate says `ask_user`.
 *
 * Returning `false` is a denial, and the default implementation denies. Failing
 * closed matters: an unattended agent must not read an unanswered escalation as
 * an approval.
 */
export type EscalationHandler = (request: {
  step: number;
  call: ToolCall;
  reasons: readonly string[];
}) => Promise<boolean>;

export interface AgentOptions {
  readonly decider: Decider;
  readonly registry: ToolRegistry;
  readonly tracer: Tracer;
  readonly escalation?: EscalationHandler;
  /** Pin a versioned model. Strongly recommended once thresholds are tuned. */
  readonly model?: string;
  readonly hardStepLimit?: number;
  /** Replace the default deterministic argument derivation. */
  readonly bindArguments?: ArgumentBinder;
}

export interface AgentRun {
  readonly stopReason: StopReason;
  readonly steps: readonly Step[];
  readonly summary: string;
  /** Every decision made, in order. */
  readonly transcript: readonly string[];
}

/** What the gate request needs to know about the selected tool. */
type GateSubject = { name: string; effect: string; args: Record<string, string> };

/** Flatten a step into the shape the judge questions expect to read. */
function stepForState(step: Step) {
  return {
    index: step.index,
    tool: step.call.tool,
    arguments: step.call.args,
    verdict: step.verdict,
    reasons: step.reasons,
    result: step.result === undefined ? null : { ok: step.result.ok, summary: step.result.summary },
  };
}

/**
 * The state we hand the model. Field names are referenced by the instructions in
 * `questionsets.ts`, so the two must stay in step.
 */
function buildState(goal: string, steps: readonly Step[], subject?: GateSubject): Record<string, unknown> {
  const state: Record<string, unknown> = {
    goal,
    steps: steps.map(stepForState),
    observations: steps.filter((step) => step.result !== undefined).map((step) => step.result?.summary ?? ""),
  };

  if (subject !== undefined) {
    state["task"] = goal;
    state["tool"] = subject.name;
    state["effect"] = subject.effect;
    // Arguments travel as their own named field. Concatenating them into the
    // instructions would let the argument text rewrite the question judging it.
    state["arguments"] = subject.args;
  }

  return state;
}

function pick(answers: Readonly<Record<string, Answer>>, keys: readonly string[]): Record<string, Answer> {
  const picked: Record<string, Answer> = {};
  for (const key of keys) {
    const answer = answers[key];
    if (answer !== undefined) picked[key] = answer;
  }
  return picked;
}

/** Phase 1 — choose one tool from the catalogue, or give up on confidence. */
export async function selectTool(
  goal: string,
  steps: readonly Step[],
  ctx: LoopContext,
): Promise<{ call: ToolCall } | { escalated: true }> {
  const result = await ctx.decider.decide({
    state: buildState(goal, steps),
    questions: ctx.selectQuestions,
    model: ctx.model,
  });

  const selection = expectChoice<string>(result.answers, SELECT_KEY);
  const policy = evaluateSelection(selection.confidence);

  ctx.tracer.record({
    step: steps.length,
    phase: "select",
    source: ctx.decider.source,
    model: result.model,
    answers: pick(result.answers, [SELECT_KEY]),
    verdict: policy.verdict,
    reasons: policy.reasons,
    usage: result.usage,
  });

  if (policy.verdict !== "allow") return { escalated: true };

  // A Choice answer is a label, not a call. Arguments are derived by
  // deterministic code, because a System One model cannot generate them.
  return {
    call: {
      tool: selection.choice,
      args: ctx.bindArguments({
        tool: selection.choice,
        goal,
        steps,
        effect: ctx.effectOf(selection.choice),
      }),
    },
  };
}

/**
 * Phase 2 — screen the selected call.
 *
 * Returns the verdict plus a step that is already recorded. The caller must not
 * execute on `ask_user` without going through the escalation handler.
 */
async function gateCall(
  goal: string,
  steps: Step[],
  call: ToolCall,
  ctx: LoopContext,
): Promise<{ call: ToolCall; step: Step; verdict: Verdict }> {
  const result = await ctx.decider.decide({
    state: buildState(goal, steps, {
      name: call.tool,
      effect: ctx.effectOf(call.tool),
      args: call.args,
    }),
    questions: gateQuestion(),
    model: ctx.model,
  });

  const policy = evaluateGate({
    destructive: expectNoul(result.answers, GATE_KEYS.destructive).noul,
    outsideScope: expectNoul(result.answers, GATE_KEYS.outsideScope).noul,
    reversibility: expectScore(result.answers, GATE_KEYS.reversibility).score,
    blastRadius: expectChoice<BlastRadius>(result.answers, GATE_KEYS.blastRadius).choice as BlastRadius,
  });

  ctx.tracer.record({
    step: steps.length,
    phase: "gate",
    source: ctx.decider.source,
    model: result.model,
    answers: result.answers,
    verdict: policy.verdict,
    reasons: policy.reasons,
    usage: result.usage,
  });

  const step: Step = { index: steps.length, call, verdict: policy.verdict, reasons: policy.reasons };
  steps.push(step);
  return { call, step, verdict: policy.verdict };
}

/** Phase 3 — supervise the run: keep going, finish, or break out. */
async function judgeRun(
  goal: string,
  steps: readonly Step[],
  ctx: LoopContext,
): Promise<LoopDecision> {
  const result = await ctx.decider.decide({
    state: buildState(goal, steps),
    questions: judgeQuestion(),
    model: ctx.model,
  });

  const decision = evaluateLoop(
    {
      complete: expectNoul(result.answers, JUDGE_KEYS.complete).noul,
      looping: expectNoul(result.answers, JUDGE_KEYS.looping).noul,
      progress: expectScore(result.answers, JUDGE_KEYS.progress).score,
    },
    steps.length,
    ctx.thresholds,
  );

  ctx.tracer.record({
    step: steps.length,
    phase: "judge",
    source: ctx.decider.source,
    model: result.model,
    answers: result.answers,
    verdict: decision.action,
    reasons: [decision.reason],
    usage: result.usage,
  });

  return decision;
}

type LoopContext = {
  readonly decider: Decider;
  readonly tracer: Tracer;
  readonly registry: ToolRegistry;
  readonly model: string;
  readonly thresholds: Thresholds;
  readonly selectQuestions: NonNullable<ReturnType<typeof selectQuestion>>;
  readonly effectOf: (tool: string) => string;
  readonly bindArguments: ArgumentBinder;
};

export async function runAgent(goal: string, options: AgentOptions): Promise<AgentRun> {
  const { decider, registry, tracer } = options;
  const escalation = options.escalation ?? (async () => false);
  const model = options.model ?? JEV_MODEL_ID;

  const transcript: string[] = [];
  const steps: Step[] = [];

  const specs = registry.specs();
  if (specs.length === 0) throw new Error("the tool registry is empty; there is nothing for the agent to select");

  const selectQuestions = selectQuestion(specs);
  if (selectQuestions === null) {
    throw new Error(`tool catalogue of ${specs.length} is not selectable (allowed: 2–255)`);
  }

  const ctx: LoopContext = {
    decider,
    tracer,
    registry,
    model,
    thresholds: { ...THRESHOLDS, hardStepLimit: options.hardStepLimit ?? THRESHOLDS.hardStepLimit },
    selectQuestions,
    effectOf: (tool) => specs.find((candidate) => candidate.name === tool)?.effect ?? "read",
    bindArguments: options.bindArguments ?? defaultArgumentBinder,
  };
  // The loop is unbounded on purpose: the only stop condition that always holds
  // is the hard step limit inside `evaluateLoop`, checked on every iteration.
  for (;;) {
    // ---- 1. select ---------------------------------------------------------
    const selection = await selectTool(goal, steps, ctx);
    if ("escalated" in selection) {
      transcript.push("selection escalated: no tool stood out confidently");
      return {
        stopReason: "escalated",
        steps,
        summary: "Tool selection had no clear winner",
        transcript,
      };
    }

    // ---- 2. gate -----------------------------------------------------------
    const gated = await gateCall(goal, steps, selection.call, ctx);

    if (gated.verdict === "deny") {
      const reason = gated.step.reasons.join("; ");
      transcript.push(`step ${gated.step.index}: ${gated.call.tool} denied — ${reason}`);
      return { stopReason: "denied", steps, summary: `Refused ${gated.call.tool}: ${reason}`, transcript };
    }

    if (gated.verdict === "ask_user") {
      const approved = await escalation({
        step: gated.step.index,
        call: gated.call,
        reasons: gated.step.reasons,
      });
      transcript.push(
        `step ${gated.step.index}: ${gated.call.tool} held for approval (${gated.step.reasons.join("; ")}) → ${approved ? "approved" : "not approved"}`,
      );
      if (!approved) {
        return {
          stopReason: "escalated",
          steps,
          summary: `Approval denied for ${gated.call.tool}`,
          transcript,
        };
      }
    }

    // ---- execute -----------------------------------------------------------
    const result = await registry.invoke(gated.call);
    steps[steps.length - 1] = { ...gated.step, result };
    transcript.push(`step ${gated.step.index}: ${gated.call.tool} → ${result.summary}`);

    // ---- 3. judge ----------------------------------------------------------
    const decision = await judgeRun(goal, steps, ctx);

    if (decision.action === "finish") {
      transcript.push(`run complete: ${decision.reason}`);
      return {
        stopReason: "complete",
        steps,
        summary: `Goal satisfied after ${steps.length} step(s)`,
        transcript,
      };
    }

    if (decision.action === "break") {
      // Only the hard-limit case is a statement about our own configuration; a
      // model-detected loop is a statement about the agent's behaviour.
      const reason: StopReason = steps.length >= ctx.thresholds.hardStepLimit ? "step_limit" : "loop_detected";
      transcript.push(`run stopped: ${decision.reason}`);
      return { stopReason: reason, steps, summary: decision.reason, transcript };
    }
  }
}

export { JEV_MODEL_ID } from "./policy.js";
