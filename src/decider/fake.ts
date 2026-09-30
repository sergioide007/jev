/**
 * A deterministic Decider for tests and offline runs.
 *
 * It exists because the control layer has to be verifiable without credentials
 * and without spending money. Be clear about what it proves: a scripted double
 * validates *our branch logic and our policy*, not Jev's answers. Thresholds can
 * only be trusted against the real API and a labelled eval set.
 */

import { GATE_KEYS, JUDGE_KEYS, SELECT_KEY, assertQuestionSet } from "./questionsets.js";
import { extractTerm } from "../arguments.js";
import type { Answer, DecideRequest, DecideResult, Decider } from "./types.js";
import type { BlastRadius, ToolEffect, ToolSpec } from "../types.js";

export type Script = Partial<Record<string, Answer>>;

export type Responder = (request: DecideRequest) => Script;

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

/** Build a `choice` answer with a consistent probability distribution. */
export function choiceAnswer(choice: string, confidence: number, others: Record<string, number> = {}): Answer {
  const rest = 1 - confidence;
  const entries = Object.entries(others);
  const each = entries.length > 0 ? rest / entries.length : 0;

  const probabilities: Record<string, number> = { [choice]: confidence };
  for (const [label, weight] of entries) probabilities[label] = weight * each;

  return { type: "choice", choice, probabilities, confidence };
}

/**
 * Build a `score` answer whose probabilities sum to one.
 *
 * The selected level takes `confidence`; the remaining mass is shared equally
 * across the other levels. Assigning the peak first and then splitting whatever
 * is left would double-count, so the split is computed from 1 directly.
 */
export function scoreAnswer(score: number, confidence = 0.9, levels = 3): Answer {
  const top = Math.min(Math.max(Math.round(score), 0), levels - 1);
  const others = levels - 1;
  const share = others === 0 ? 0 : (1 - confidence) / others;

  const probabilities: Record<string, number> = {};
  for (let level = 0; level < levels; level += 1) {
    probabilities[String(level)] = level === top ? confidence : share;
  }

  return { type: "score", score, legend: {}, probabilities, confidence };
}

export function noulAnswer(noul: number): Answer {
  return { type: "noul", noul };
}

type StepLike = { tool?: unknown };

function blastRadiusFor(effect: ToolEffect): BlastRadius {
  switch (effect) {
    case "read":
      return "single_record";
    case "write":
      return "project";
    case "delete":
      return "system";
    case "network":
      return "external";
  }
}

export class FakeDecider implements Decider {
  readonly source: string;

  private readonly responder: Responder;

  /** Full request history, for asserting on what was actually asked. */
  readonly calls: DecideRequest[] = [];

  constructor(responder: Responder, source = "fake") {
    this.responder = responder;
    this.source = source;
  }

  /** Reply from a fixed script. Every question present in the script is answered. */
  static scripted(script: Script, source = "fake:scripted"): FakeDecider {
    return new FakeDecider(() => script, source);
  }

  /**
   * Replay a queue of scripts, one per call. Throws when exhausted, because a
   * test that runs past its script is a test that stopped asserting something.
   */
  static sequence(scripts: readonly Script[], source = "fake:sequence"): FakeDecider {
    let cursor = 0;
    return new FakeDecider(() => {
      const script = scripts[cursor];
      if (script === undefined) {
        throw new Error(`FakeDecider script exhausted after ${cursor} call(s); the agent kept running`);
      }
      cursor += 1;
      return script;
    }, source);
  }
  /**
   * A heuristic stand-in good enough to drive the demo end to end offline.
   *
   * It is intentionally not clever: it answers from the tool catalogue's own
   * `effect` metadata, which is exactly the signal a real model would have to
   * infer from a description.
   */
  static heuristic(tools: readonly ToolSpec[], source = "fake:heuristic"): FakeDecider {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    return new FakeDecider((request) => {
      const state = (request.state ?? {}) as Record<string, unknown>;

      if (SELECT_KEY in request.questions) {
        const goal = String(state["goal"] ?? "");
        const tokens = goal.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

        let best = tools[0]?.name ?? "";
        let bestHits = -1;
        for (const tool of tools) {
          const haystack = `${tool.name} ${tool.description}`.toLowerCase();
          const hits = tokens.filter((token) => haystack.includes(token)).length;
          if (hits > bestHits) {
            best = tool.name;
            bestHits = hits;
          }
        }

        const alternatives = Object.fromEntries(tools.filter((t) => t.name !== best).map((t) => [t.name, 1]));
        // No keyword overlap at all means no clear winner, which is exactly the
        // low-confidence case the policy is supposed to escalate.
        const confidence = bestHits === 0 ? 0.45 : Math.min(0.6 + 0.1 * bestHits, 0.97);
        return { [SELECT_KEY]: choiceAnswer(best, confidence, alternatives) };
      }

      if (GATE_KEYS.destructive in request.questions) {
        const effect = byName.get(String(state["tool"] ?? ""))?.effect ?? ("read" as ToolEffect);

        return {
          [GATE_KEYS.destructive]: noulAnswer(effect === "delete" ? 0.95 : effect === "write" ? 0.3 : 0.05),
          [GATE_KEYS.outsideScope]: noulAnswer(effect === "network" ? 0.8 : 0.15),
          [GATE_KEYS.reversibility]: scoreAnswer(effect === "delete" ? 2 : effect === "write" ? 1 : 0, 0.85),
          [GATE_KEYS.blastRadius]: choiceAnswer(blastRadiusFor(effect), 0.8),
        };
      }

      if (JUDGE_KEYS.complete in request.questions) {
        const goal = String(state["goal"] ?? "");
        const steps = Array.isArray(state["steps"]) ? (state["steps"] as unknown[]) : [];
        const observations = Array.isArray(state["observations"]) ? (state["observations"] as unknown[]) : [];
        const count = steps.length;

        // Completion is judged on evidence, like a real model would: the goal's
        // salient term has to show up in an observation.
        const term = extractTerm(goal);
        const evidence = observations
          .map((entry) => String(entry))
          .join(" ")
          .toLowerCase();
        const found = term !== null && term !== "" && evidence.includes(term.toLowerCase());

        // Looping is judged on repetition: one tool, over and over.
        const uniqueTools = new Set(steps.map((step) => String((step as StepLike).tool)));
        const looping = uniqueTools.size === 1 && count >= 3 ? 0.88 : 0.12;
        const progress = found ? 2 : looping > 0.5 ? 0.2 : Math.min(uniqueTools.size, 1);

        return {
          [JUDGE_KEYS.complete]: noulAnswer(found ? 0.93 : 0.08),
          [JUDGE_KEYS.looping]: noulAnswer(looping),
          [JUDGE_KEYS.progress]: scoreAnswer(progress, 0.8),
        };
      }

      throw new Error(`FakeDecider has no heuristic for question keys: ${Object.keys(request.questions).join(", ")}`);
    }, source);
  }

  async decide(request: DecideRequest): Promise<DecideResult> {
    this.calls.push(request);

    // Mirror the real path: the same limits are enforced before any answer is produced.
    assertQuestionSet(request.questions);

    const script = this.responder(request);
    const answers: Record<string, Answer> = {};

    for (const [key, question] of Object.entries(request.questions)) {
      const answer = (script as Record<string, Answer | undefined>)[key];
      if (answer === undefined) continue;

      // Mirror the real API's guarantee: a question can only ever be answered
      // with its own type. Checking it here means the double cannot paper over a
      // mismatch between a question set and the code that reads it.
      if (answer.type !== question.type) {
        throw new Error(`fake answer "${key}" has type "${answer.type}" but the question is "${question.type}"`);
      }
      answers[key] = answer;
    }

    const missing = Object.keys(request.questions).filter((key) => !(key in answers));
    if (missing.length > 0) {
      throw new Error(`fake script did not answer: ${missing.join(", ")}`);
    }

    return { answers, model: "fake-1.0.0", usage: ZERO_USAGE };
  }
}

/** Re-exported so existing imports keep working; the implementation now lives with the questions. */
export { assertQuestionSet };
