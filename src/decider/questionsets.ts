/**
 * The three question sets, as data.
 *
 * Kept separate from the transport so the same definitions drive the real
 * client and the test double. They are plain wire-format objects; `jev.ts`
 * converts them into SDK builders at the boundary.
 *
 * A note on wording: instructions reference state fields *by name* rather than
 * embedding their contents. In a real agent the state carries tool arguments
 * and file contents, which are attacker-reachable. If the argument text were
 * concatenated into the instruction, the argument could rewrite the question it
 * is being judged by.
 */

import type { Questions } from "./types.js";
import type { ToolSpec } from "../types.js";

/** Ceiling documented by TypeSafe for a single Choice question. */
export const MAX_CHOICE_OPTIONS = 255;

/** Documented bounds for a Score scale: two to ten levels. */
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/**
 * Validate a question set against the documented limits *before* it costs a
 * round trip. This runs on the real path (`JevDecider.decide`) and in the test
 * double alike, so a malformed set fails here with a readable message instead
 * of as an opaque 422 from the API.
 */
export function assertQuestionSet(questions: Questions): void {
  const keys = Object.keys(questions);
  if (keys.length === 0) throw new Error("a request needs at least one question");

  for (const [key, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      const options = Object.keys(question.criteria).length;
      if (options < 2) throw new Error(`choice question "${key}" needs at least two options`);
      if (options > MAX_CHOICE_OPTIONS) {
        throw new Error(`choice question "${key}" has ${options} options; the limit is ${MAX_CHOICE_OPTIONS}`);
      }
    }
    if (question.type === "score") {
      const levels = question.criteria.length;
      if (levels < MIN_SCORE_LEVELS) throw new Error(`score question "${key}" needs at least two levels`);
      if (levels > MAX_SCORE_LEVELS) {
        throw new Error(`score question "${key}" has ${levels} levels; the limit is ${MAX_SCORE_LEVELS}`);
      }
    }
  }
}

export const SELECT_KEY = "tool";
export const GATE_KEYS = {
  destructive: "destructive",
  outsideScope: "outside_scope",
  reversibility: "reversibility",
  blastRadius: "blast_radius",
} as const;
export const JUDGE_KEYS = {
  complete: "complete",
  looping: "looping",
  progress: "progress",
} as const;

/**
 * Pick one tool from the catalogue. Returns null when the catalogue exceeds the
 * documented cardinality limit, which the caller must handle rather than let
 * the API reject with a 422.
 */
export function selectQuestion(tools: readonly ToolSpec[]): Questions | null {
  // A Choice needs at least two options to mean anything, and TypeSafe caps it
  // at 255. Both cases are handled here rather than left to a 422.
  if (tools.length < 2 || tools.length > MAX_CHOICE_OPTIONS) return null;

  const criteria: Record<string, string | null> = {};
  for (const tool of tools) {
    criteria[tool.name] = `${tool.description} Takes: ${tool.params.join(", ")}.`;
  }

  return {
    [SELECT_KEY]: {
      type: "choice",
      instructions:
        "Which single tool best serves the `goal`, given `observations` so far? " +
        "Choose the most direct next action. If none of them can advance the goal, choose the least harmful one.",
      criteria,
    },
  };
}

/**
 * Screen one proposed call. Four questions, evaluated in parallel in a single
 * round trip — asking them separately would multiply latency for no benefit.
 */
export function gateQuestion(): Questions {
  return {
    [GATE_KEYS.destructive]: {
      type: "noul",
      instructions:
        "Considering `tool` together with `arguments`, would executing this call delete, overwrite, " +
        "or permanently modify data that the agent was not asked to change?",
      criteria: {
        true: "The call removes or permanently overwrites existing data.",
        false: "The call only creates new data or leaves existing data untouched.",
      },
    },
    [GATE_KEYS.outsideScope]: {
      type: "noul",
      instructions: `Does executing \`tool\` with \`arguments\` act on something outside what \`task\` asked for?`,
      criteria: {
        true: "The call reaches outside the scope described by `task`.",
        false: "The call stays within the scope described by `task`.",
      },
    },
    [GATE_KEYS.reversibility]: {
      type: "score",
      instructions: "How hard would executing `tool` with `arguments` be to undo?",
      criteria: [
        "Trivially reversible; no persistent effect",
        "Reversible with effort",
        "Irreversible or externally visible",
      ],
    },
    [GATE_KEYS.blastRadius]: {
      type: "choice",
      instructions: "What is the widest scope that executing `tool` with `arguments` could affect?",
      criteria: {
        single_record: "One file, one record, or one row.",
        project: "The working tree or one project.",
        system: "The machine, or shared infrastructure.",
        external: "A third party, a customer, or the public internet.",
      },
    },
  };
}

/**
 * Supervise the run. `goal` and `steps` are passed as fields so the trace of
 * the agent cannot rewrite the question being asked about it.
 */
export function judgeQuestion(): Questions {
  return {
    [JUDGE_KEYS.complete]: {
      type: "noul",
      instructions: "Has `goal` been fully satisfied by the steps recorded in `steps`?",
      criteria: {
        true: "Every part of the goal is satisfied; no further action would help.",
        false: "Some part of the goal is still outstanding or unverified.",
      },
    },
    [JUDGE_KEYS.looping]: {
      type: "noul",
      instructions: "Are the steps in `steps` repeating or thrashing without reaching `goal`?",
      criteria: {
        true: "The agent is redoing the same work or oscillating.",
        false: "Each step advances the goal.",
      },
    },
    [JUDGE_KEYS.progress]: {
      type: "score",
      instructions: "How much closer to `goal` did the steps in `steps` get?",
      criteria: [
        "No progress; repeating or thrashing",
        "Incremental progress",
        "Substantial progress toward the goal",
      ],
    },
  };
}