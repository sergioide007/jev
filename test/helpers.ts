/** Shared fixtures for the agent tests. */

import { FakeDecider, choiceAnswer, noulAnswer, scoreAnswer } from "../src/decider/fake.js";
import { GATE_KEYS, JUDGE_KEYS, SELECT_KEY } from "../src/decider/questionsets.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { silentTracer, Tracer } from "../src/trace.js";
import type { Script } from "../src/decider/fake.js";
import type { Tool } from "../src/tools/registry.js";

export function readTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "read_file",
    description: "Read one file",
    effect: "read",
    mutating: false,
    params: ["path"],
    execute: async () => ({ ok: true, summary: "read the file" }),
    ...overrides,
  };
}

export function searchToolStub(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "search",
    description: "Search the workspace",
    effect: "read",
    mutating: false,
    params: ["pattern"],
    execute: async () => ({ ok: true, summary: "2 matches" }),
    ...overrides,
  };
}

export function deleteToolStub(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "delete",
    description: "Delete a path permanently",
    effect: "delete",
    mutating: true,
    params: ["path"],
    execute: async () => ({ ok: true, summary: "deleted" }),
    ...overrides,
  };
}

/** Gate signals for a plainly safe read-only action. */
export const SAFE_GATE: Script = {
  [GATE_KEYS.destructive]: noulAnswer(0.02),
  [GATE_KEYS.outsideScope]: noulAnswer(0.04),
  [GATE_KEYS.reversibility]: scoreAnswer(0),
  [GATE_KEYS.blastRadius]: choiceAnswer("single_record", 0.9),
};

/** Gate signals for a permanent, system-wide delete. */
export const FATAL_GATE: Script = {
  [GATE_KEYS.destructive]: noulAnswer(0.97),
  [GATE_KEYS.outsideScope]: noulAnswer(0.9),
  [GATE_KEYS.reversibility]: scoreAnswer(2),
  [GATE_KEYS.blastRadius]: choiceAnswer("system", 0.95),
};

/** Gate signals for something irreversible but narrowly scoped. */
export const IRREVERSIBLE_GATE: Script = {
  [GATE_KEYS.destructive]: noulAnswer(0.7),
  [GATE_KEYS.outsideScope]: noulAnswer(0.8),
  [GATE_KEYS.reversibility]: scoreAnswer(2),
  [GATE_KEYS.blastRadius]: choiceAnswer("single_record", 0.8),
};

/** Judge signals: nothing done, nothing repeating. */
export const KEEP_GOING: Script = {
  [JUDGE_KEYS.complete]: noulAnswer(0.1),
  [JUDGE_KEYS.looping]: noulAnswer(0.1),
  [JUDGE_KEYS.progress]: scoreAnswer(2),
};

/** Judge signals: the goal is satisfied. */
export const DONE: Script = {
  [JUDGE_KEYS.complete]: noulAnswer(0.95),
  [JUDGE_KEYS.looping]: noulAnswer(0.05),
  [JUDGE_KEYS.progress]: scoreAnswer(2),
};

/** Judge signals: repeating with no progress. */
export const LOOPING: Script = {
  [JUDGE_KEYS.complete]: noulAnswer(0.05),
  [JUDGE_KEYS.looping]: noulAnswer(0.95),
  [JUDGE_KEYS.progress]: scoreAnswer(0),
};

export function pickTool(name: string, confidence = 0.9): Script {
  return { [SELECT_KEY]: choiceAnswer(name, confidence, { search: 1, read_file: 1, delete: 1 }) };
}

/** A decider that answers by phase, so a test only scripts what it cares about. */
export function phaseDecider(scripts: Partial<Record<"select" | "gate" | "judge", Script>>, source = "fake:phases") {
  return new FakeDecider((request) => {
    if (JUDGE_KEYS.complete in request.questions) return scripts.judge ?? KEEP_GOING;
    if (GATE_KEYS.destructive in request.questions) return scripts.gate ?? SAFE_GATE;
    return scripts.select ?? pickTool("read_file");
  }, source);
}

export function harness(tools: Tool[]) {
  const registry = new ToolRegistry(tools);
  const tracer = silentTracer();
  return { registry, tracer };
}

export function tracer(): Tracer {
  return silentTracer();
}