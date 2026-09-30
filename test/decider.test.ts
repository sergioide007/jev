/**
 * The decider seam and the question sets.
 *
 * The fake exists to make the control layer testable offline, so these tests
 * mostly assert that it cannot silently lie: a mismatched answer type or an
 * unanswered question must fail loudly rather than paper over a drift between a
 * question set and the code reading it.
 */

import { describe, expect, it } from "vitest";

import {
  FakeDecider,
  assertQuestionSet,
  choiceAnswer,
  noulAnswer,
  scoreAnswer,
} from "../src/decider/fake.js";
import {
  GATE_KEYS,
  JUDGE_KEYS,
  MAX_CHOICE_OPTIONS,
  SELECT_KEY,
  gateQuestion,
  judgeQuestion,
  selectQuestion,
} from "../src/decider/questionsets.js";
import { AnswerShapeError, expectChoice, expectNoul, expectScore } from "../src/decider/types.js";
import type { ToolSpec } from "../src/types.js";

const tool = (name: string, description = `${name} description`): ToolSpec => ({
  name,
  description,
  effect: "read",
  mutating: false,
  params: ["path"],
});

describe("question sets", () => {
  it("builds one choice option per tool, using the description as the rubric", () => {
    const questions = selectQuestion([tool("read_file"), tool("search")]);
    const question = questions?.[SELECT_KEY];

    expect(question?.type).toBe("choice");
    if (question?.type !== "choice") throw new Error("unreachable");
    expect(Object.keys(question.criteria)).toEqual(["read_file", "search"]);
    expect(question.criteria["read_file"]).toContain("read_file description");
  });

  it("refuses to build a selection that could not be answered", () => {
    expect(selectQuestion([])).toBeNull();
    expect(selectQuestion([tool("only_one")])).toBeNull();
  });

  it("refuses a catalogue past the documented cardinality limit", () => {
    const many = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, index) => tool(`t${index}`));

    expect(selectQuestion(many)).toBeNull();
    expect(selectQuestion(many.slice(0, MAX_CHOICE_OPTIONS))).not.toBeNull();
  });

  it("asks the four gate questions with the documented types", () => {
    const questions = gateQuestion();

    expect(questions[GATE_KEYS.destructive]?.type).toBe("noul");
    expect(questions[GATE_KEYS.outsideScope]?.type).toBe("noul");
    expect(questions[GATE_KEYS.reversibility]?.type).toBe("score");
    expect(questions[GATE_KEYS.blastRadius]?.type).toBe("choice");
    assertQuestionSet(questions);
  });

  it("orders the reversibility rubric from reversible to irreversible", () => {
    const question = gateQuestion()[GATE_KEYS.reversibility];
    if (question?.type !== "score") throw new Error("unreachable");

    expect(question.criteria).toHaveLength(3);
    expect(question.criteria[0]).toMatch(/reversible/i);
    expect(question.criteria[2]).toMatch(/Irreversible/);
  });

  it("asks the three judge questions", () => {
    const questions = judgeQuestion();

    expect(questions[JUDGE_KEYS.complete]?.type).toBe("noul");
    expect(questions[JUDGE_KEYS.looping]?.type).toBe("noul");
    expect(questions[JUDGE_KEYS.progress]?.type).toBe("score");
    assertQuestionSet(questions);
  });

  it("sends only the fields the System One API accepts", () => {
    const payload = { state: "a ticket", questions: gateQuestion(), model: "jev-1.13.0" };

    // The API rejects anything beyond these three top-level fields.
    expect(Object.keys(payload).sort()).toEqual(["model", "questions", "state"]);
    expect(payload.questions).toBeDefined();
  });

  it("never smuggles generation parameters into a question", () => {
    const serialised = JSON.stringify(gateQuestion());

    for (const forbidden of ["temperature", "max_tokens", "stream", "metadata"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("catches a malformed question set before it costs a round trip", () => {
    expect(() =>
      assertQuestionSet({ bad: { type: "choice", instructions: "one option?", criteria: { only: null } } }),
    ).toThrow(/at least two options/);

    expect(() => assertQuestionSet({ bad: { type: "score", instructions: "one level?", criteria: ["only"] } })).toThrow(
      /at least two levels/,
    );
  });
});
describe("FakeDecider", () => {
  it("answers what the script provides and complains about the rest", async () => {
    const decider = FakeDecider.scripted({ [GATE_KEYS.destructive]: noulAnswer(0.5) });
    const single = { [GATE_KEYS.destructive]: { type: "noul" as const, instructions: "?" } };

    await expect(decider.decide({ state: "x", questions: single })).resolves.toMatchObject({
      answers: { [GATE_KEYS.destructive]: { type: "noul", noul: 0.5 } },
    });

    await expect(decider.decide({ state: "x", questions: judgeQuestion() })).rejects.toThrow(/did not answer/);
  });

  it("refuses to answer a noul question with a choice answer", async () => {
    const decider = FakeDecider.scripted({ q: choiceAnswer("yes", 0.9) });

    await expect(
      decider.decide({ state: "x", questions: { q: { type: "noul", instructions: "?" } } }),
    ).rejects.toThrow(/has type "choice" but the question is "noul"/);
  });

  it("stops a test that runs past its script instead of looping forever", async () => {
    const decider = FakeDecider.sequence([{ q: noulAnswer(0.1) }]);
    const questions = { q: { type: "noul" as const, instructions: "?" } };

    await decider.decide({ state: "x", questions });
    await expect(decider.decide({ state: "x", questions })).rejects.toThrow(/script exhausted/);
  });

  it("records every request for assertions", async () => {
    const decider = FakeDecider.scripted({ q: noulAnswer(0.1) });
    const questions = { q: { type: "noul" as const, instructions: "?" } };

    await decider.decide({ state: "first", questions });
    await decider.decide({ state: "second", questions });

    expect(decider.calls.map((call) => call.state)).toEqual(["first", "second"]);
  });

  it("builds a probability distribution that sums to one", () => {
    const choice = choiceAnswer("billing", 0.8, { bug: 1, account: 1 });
    if (choice.type !== "choice") throw new Error("unreachable");

    expect(Object.values(choice.probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    expect(choice.probabilities["billing"]).toBeCloseTo(0.8, 10);
  });

  it("builds a score distribution that sums to one", () => {
    const answer = scoreAnswer(1.4, 0.7);
    if (answer.type !== "score") throw new Error("unreachable");

    expect(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  });
});

describe("answer narrowing", () => {
  const answers = {
    a: noulAnswer(0.7),
    b: choiceAnswer("billing", 0.8),
    c: scoreAnswer(1.2),
  };

  it("reads each primitive as its own type", () => {
    expect(expectNoul(answers, "a").noul).toBe(0.7);
    expect(expectChoice(answers, "b").choice).toBe("billing");
    expect(expectScore(answers, "c").score).toBeCloseTo(1.2, 10);
  });

  it("throws when the answer is missing entirely", () => {
    expect(() => expectNoul(answers, "nope")).toThrow(/missing/);
  });

  it("throws when the answer is the wrong primitive", () => {
    expect(() => expectChoice(answers, "a")).toThrow(AnswerShapeError);
    expect(() => expectScore(answers, "a")).toThrow(/expected to be a score/);
  });
});