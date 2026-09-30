/**
 * Public API.
 *
 * The layering, from bottom to top:
 *
 *   decider/   how we ask Jev (real SDK, or a deterministic double)
 *   policy.ts  every threshold, as pure functions
 *   tools/     what can actually happen (behind a sandbox)
 *   agent.ts   the loop that wires the three together
 */

export { runAgent } from "./agent.js";
export type { AgentOptions, AgentRun, EscalationHandler } from "./agent.js";

export { JevDecider } from "./decider/jev.js";
export type { JevDeciderOptions } from "./decider/jev.js";

export { FakeDecider, choiceAnswer, scoreAnswer, noulAnswer } from "./decider/fake.js";
export type { Script } from "./decider/fake.js";

export { AnswerShapeError } from "./decider/types.js";
export type {
  Answer,
  ChoiceAnswer,
  DecideRequest,
  DecideResult,
  Decider,
  NoulAnswer,
  ScoreAnswer,
  State,
  Usage,
} from "./decider/types.js";

export {
  GATE_KEYS,
  JUDGE_KEYS,
  MAX_CHOICE_OPTIONS,
  SELECT_KEY,
  gateQuestion,
  judgeQuestion,
  selectQuestion,
} from "./decider/questionsets.js";

export {
  COST_PER_MTOK_USD,
  JEV_MODEL_ID,
  THRESHOLDS,
  estimateCostUsd,
  evaluateGate,
  evaluateLoop,
  evaluateSelection,
} from "./policy.js";
export type { GateDecision, GateSignals, LoopDecision, LoopSignals, Thresholds } from "./policy.js";

export { SandboxViolation, createSandbox } from "./sandbox.js";
export type { Sandbox } from "./sandbox.js";

export { ToolRegistry, UnknownToolError } from "./tools/registry.js";
export type { Tool } from "./tools/registry.js";
export {
  countMatchesTool,
  createBuiltinRegistry,
  deletePathTool,
  listDirTool,
  readFileTool,
  searchTool,
} from "./tools/builtin.js";

export { defaultArgumentBinder, extractTerm } from "./arguments.js";
export type { ArgumentBinder } from "./arguments.js";

export { Tracer, silentTracer } from "./trace.js";
export type { DecisionTrace, Phase } from "./trace.js";

export type {
  AgentState,
  BlastRadius,
  LoopAction,
  StopReason,
  Step,
  ToolCall,
  ToolEffect,
  ToolResult,
  ToolSpec,
  Verdict,
} from "./types.js";