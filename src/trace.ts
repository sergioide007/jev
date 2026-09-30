/**
 * Structured tracing.
 *
 * Every gate decision logs its full probability distribution, not just the
 * verdict. When something gets through that should not have, the distribution
 * is the only forensic trail available — the verdict alone cannot tell you
 * whether the model was wrong or the threshold was wrong.
 */

import { estimateCostUsd } from "./policy.js";
import type { Answer } from "./decider/types.js";
import type { Verdict } from "./types.js";

export type Phase = "select" | "gate" | "judge";

export interface DecisionTrace {
  readonly at: string;
  readonly step: number;
  readonly phase: Phase;
  readonly source: string;
  /** Versioned model id that actually answered. Log it from day one. */
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly verdict: Verdict | "continue" | "finish" | "break";
  readonly reasons: readonly string[];
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly costUsd: number;
}

export interface TracerOptions {
  /** Defaults to stdout as JSON Lines. */
  sink?: (line: string) => void;
  /** Keeps every trace in memory. Useful in tests and in a UI. */
  retain?: boolean;
}

export class Tracer {
  private readonly sink: (line: string) => void;
  private readonly retain: boolean;
  readonly entries: DecisionTrace[] = [];

  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;

  constructor(options: TracerOptions = {}) {
    this.sink = options.sink ?? ((line) => console.log(line));
    this.retain = options.retain ?? false;
  }

  record(entry: Omit<DecisionTrace, "at" | "costUsd">): DecisionTrace {
    const costUsd = estimateCostUsd(entry.usage);

    const trace: DecisionTrace = {
      ...entry,
      at: new Date().toISOString(),
      costUsd,
    };

    this.calls += 1;
    this.inputTokens += entry.usage.input_tokens;
    this.outputTokens += entry.usage.output_tokens;
    this.costUsd += costUsd;

    if (this.retain) this.entries.push(trace);
    this.sink(JSON.stringify(trace));

    return trace;
  }

  summary() {
    return {
      decisions: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
    };
  }
}

/** A tracer that swallows output, for tests and for the silent default. */
export function silentTracer(): Tracer {
  return new Tracer({ sink: () => {}, retain: true });
}