/**
 * The seam between this harness and Jev.
 *
 * Everything above this line speaks `Decider`; everything below it speaks the
 * SDK. That is what makes the control layer testable without an API key and
 * lets a different provider be dropped in behind the same interface.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** State accepted by the System One API: text, a record, or a list of texts. */
export type State = string | Record<string, unknown> | unknown[];

// --- Questions (wire format, mirroring the SDK builders) --------------------

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  /** Option label to description. `null` when the label speaks for itself. */
  readonly criteria: Readonly<Record<string, string | null>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  /** Ordered low to high. At least two entries. */
  readonly criteria: readonly string[];
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Readonly<Record<string, Question>>;

// --- Answers ---------------------------------------------------------------

export interface ChoiceAnswer<T extends string = string> {
  readonly type: "choice";
  readonly choice: T;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly type: "noul";
  readonly noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

// --- Transport -------------------------------------------------------------

export interface Usage {
  readonly input_tokens: number;
  /** Reported but not charged: Jev bills input tokens only. */
  readonly output_tokens: number;
}

export interface DecideRequest {
  readonly state: State;
  readonly questions: Questions;
  /** Pin a versioned model id. Omit to use the SDK default alias. */
  readonly model?: string;
}

export interface DecideResult {
  readonly answers: Readonly<Record<string, Answer>>;
  /** Versioned id of the model that actually answered. Log this. */
  readonly model: string;
  readonly usage: Usage;
}

export interface Decider {
  decide(request: DecideRequest): Promise<DecideResult>;
  /** Human-readable identity of the backing implementation, for traces. */
  readonly source: string;
}

// --- Answer narrowing ------------------------------------------------------
//
// The `Decider` seam is intentionally loosely typed, so every read of an
// answer goes through one of these. A mismatch means the question set and the
// verifier have drifted apart, and we want a loud failure rather than a
// silently wrong branch.

export class AnswerShapeError extends Error {
  constructor(key: string, expected: Answer["type"], actual: unknown) {
    super(
      `answer "${key}" was expected to be a ${expected} but got ${
        typeof actual === "object" && actual !== null && "type" in actual
          ? String((actual as { type: unknown }).type)
          : typeof actual
      }`,
    );
    this.name = "AnswerShapeError";
  }
}

function fetchAnswer(answers: Readonly<Record<string, Answer>>, key: string, expected: Answer["type"]): Answer {
  const found = answers[key];
  if (found === undefined) throw new Error(`answer "${key}" is missing from the response`);
  if (found.type !== expected) throw new AnswerShapeError(key, expected, found);
  return found;
}

export function expectChoice<T extends string = string>(answers: Readonly<Record<string, Answer>>, key: string): ChoiceAnswer<T> {
  return fetchAnswer(answers, key, "choice") as ChoiceAnswer<T>;
}

export function expectScore(answers: Readonly<Record<string, Answer>>, key: string): ScoreAnswer {
  return fetchAnswer(answers, key, "score") as ScoreAnswer;
}

export function expectNoul(answers: Readonly<Record<string, Answer>>, key: string): NoulAnswer {
  return fetchAnswer(answers, key, "noul") as NoulAnswer;
}