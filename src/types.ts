/**
 * Domain types for the agent control layer.
 *
 * The split is deliberate: the runtime owns effects, Jev owns bounded semantic
 * judgments, and the policy layer owns the thresholds that connect them.
 */

/** What a tool does to the world. Drives the fake decider and the risk rubric. */
export type ToolEffect = "read" | "write" | "delete" | "network";

/** How wide the effect of a tool call can reach. */
export type BlastRadius = "single_record" | "project" | "system" | "external";

/** The three ways the gate can rule on a proposed call. */
export type Verdict =
  /** Safe to execute. */
  | "allow"
  /** Needs a human decision before executing. */
  | "ask_user"
  /** Refused outright. Never executed, never escalated. */
  | "deny";

/** The three ways the loop supervisor can rule on agent progress. */
export type LoopAction = "continue" | "finish" | "break";

/** Why the agent stopped. Recorded so callers can distinguish outcomes. */
export type StopReason = "complete" | "loop_detected" | "step_limit" | "escalated" | "denied";

/** The outcome of a single tool execution. */
export interface ToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly detail?: string;
}

/** A proposed call: tool name plus already-validated arguments. */
export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
}

/** A tool as advertised to the selection Choice question. */
export interface ToolSpec {
  readonly name: string;
  /** Sentence shown to the model as the option description. Keep discriminative. */
  readonly description: string;
  readonly effect: ToolEffect;
  readonly mutating: boolean;
  readonly params: readonly string[];
}

/** One completed iteration of the agent loop. */
export interface Step {
  readonly index: number;
  readonly call: ToolCall;
  readonly verdict: Verdict;
  /** Signals the gate produced, kept for explainability and tests. */
  readonly reasons: readonly string[];
  readonly result?: ToolResult;
}

/** Everything the loop carries between iterations. Serialised into `state`. */
export interface AgentState {
  readonly goal: string;
  readonly steps: readonly Step[];
  readonly notes: readonly string[];
}