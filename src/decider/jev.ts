/**
 * The real Decider: a thin pass-through to `@typesafe-ai/sdk`.
 *
 * It holds no policy. It converts our wire-format questions into SDK builders,
 * forwards the call, and normalises the result back to our `DecideResult`.
 */

import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import type { TypeSafeClientConfig } from "@typesafe-ai/sdk";

import { assertQuestionSet } from "./questionsets.js";
import type { Answer, DecideRequest, DecideResult, Decider, Question, Questions } from "./types.js";

function toSdkQuestion(question: Question) {
  switch (question.type) {
    case "choice":
      return choice(question.instructions, question.criteria as Record<string, string | null>);
    case "score":
      // `ScoreCriteria` is a variadic tuple ("at least two, from zero"); the
      // length check is `assertQuestionSet`, called at the top of `decide`.
      return score(question.instructions, question.criteria as [string, string, ...string[]]);
    case "noul":
      return noul(question.instructions, question.criteria ?? null);
  }
}

/**
 * Rebuild the question map with the SDK's builders so the type parameter
 * `Q` is inferred and the response types check out.
 */
function toSdkQuestions(questions: Questions) {
  return Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [key, toSdkQuestion(question)]),
  );
}

export interface JevDeciderOptions extends TypeSafeClientConfig {}

export class JevDecider implements Decider {
  readonly source = "jev";

  private readonly client: TypeSafeClient;

  constructor(options: JevDeciderOptions = {}) {
    // Constructing without a key throws before any request is attempted, which
    // is the behaviour we want at boot rather than mid-loop.
    this.client = new TypeSafeClient(options);
  }

  /**
   * Build from the environment. The SDK reads TYPESAFE_API_KEY itself and
   * throws if it is missing, so this doubles as the credential check.
   */
  static fromEnv(options: JevDeciderOptions = {}): JevDecider {
    return new JevDecider(options);
  }

  /** Models available to the account. Useful to confirm access at boot. */
  async listModels() {
    return this.client.models.list();
  }

  async decide(request: DecideRequest): Promise<DecideResult> {
    assertQuestionSet(request.questions);

    const { answers, model, usage } = await this.client.systemOne({
      state: request.state as string,
      questions: toSdkQuestions(request.questions) as never,
      ...(request.model === undefined ? {} : { model: request.model }),
    });

    return {
      answers: answers as Record<string, Answer>,
      model,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    };
  }
}