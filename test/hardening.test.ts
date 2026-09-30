/**
 * Regression tests for defects found in review. Each one fails on the code as
 * originally delivered; the comment says what used to happen.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentError, runAgent } from "../src/agent.js";
import { extractTerm } from "../src/arguments.js";
import { FakeDecider, choiceAnswer } from "../src/decider/fake.js";
import { JevDecider } from "../src/decider/jev.js";
import { MAX_SCORE_LEVELS, assertQuestionSet } from "../src/decider/questionsets.js";
import { THRESHOLDS, assertValidThresholds, evaluateGate, evaluateLoop } from "../src/policy.js";
import { SandboxViolation, createSandbox } from "../src/sandbox.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createBuiltinRegistry } from "../src/tools/builtin.js";
import { silentTracer } from "../src/trace.js";
import {
  DONE,
  SAFE_GATE,
  deleteToolStub,
  harness,
  phaseDecider,
  pickTool,
  readTool,
  searchToolStub,
} from "./helpers.js";
import type { GateSignals } from "../src/policy.js";

const BENIGN: GateSignals = { destructive: 0.2, outsideScope: 0.1, reversibility: 0.3, blastRadius: "single_record" };

describe("gate: declared effect is a floor under the model's estimate", () => {
  // Before: a `delete` tool with a benign-looking model answer returned "allow" and ran.
  it("asks a human for a delete tool even when the model finds it harmless", () => {
    const decision = evaluateGate({ ...BENIGN, effect: "delete" });
    expect(decision.verdict).toBe("ask_user");
    expect(decision.reasons.join(" ")).toMatch(/always requires approval/);
  });

  it("does not execute a delete tool that the model waved through", async () => {
    let executed = 0;
    const decider = phaseDecider({ select: pickTool("delete"), gate: SAFE_GATE, judge: DONE });
    const { registry, tracer } = harness([
      deleteToolStub({ execute: async () => (executed++, { ok: true, summary: "deleted" }) }),
      searchToolStub(),
    ]);

    const run = await runAgent("tidy up", { decider, registry, tracer });

    expect(run.stopReason).toBe("escalated");
    expect(executed).toBe(0);
  });

  it("leaves read tools alone", () => {
    expect(evaluateGate({ ...BENIGN, effect: "read" }).verdict).toBe("allow");
  });

  it("lets a caller choose which effects always need approval", () => {
    const relaxed = { ...THRESHOLDS.gate, alwaysAskEffects: [] };
    expect(evaluateGate({ ...BENIGN, effect: "delete" }, relaxed).verdict).toBe("allow");
  });
});

describe("gate: the distribution matters, not only the argmax", () => {
  // Before: argmax single_record (0.45) hid 50% of the mass on system/external.
  const diffuse = { single_record: 0.45, project: 0.05, system: 0.3, external: 0.2 };

  it("escalates when enough mass sits on severe scopes", () => {
    const decision = evaluateGate({ ...BENIGN, blastRadiusProbabilities: diffuse });
    expect(decision.verdict).toBe("ask_user");
    expect(decision.reasons.join(" ")).toMatch(/probability sits on/);
  });

  it("allows a confidently narrow distribution", () => {
    const narrow = { single_record: 0.92, project: 0.06, system: 0.01, external: 0.01 };
    expect(evaluateGate({ ...BENIGN, blastRadiusProbabilities: narrow }).verdict).toBe("allow");
  });

  it("never denies on a diffuse distribution: deny stays keyed on the argmax", () => {
    const decision = evaluateGate({ ...BENIGN, destructive: 0.95, blastRadiusProbabilities: diffuse });
    expect(decision.verdict).toBe("ask_user");
  });
});

describe("the backstop cannot be configured away", () => {
  // Before: hardStepLimit NaN meant `stepCount >= NaN`, always false: the loop never stopped.
  it("breaks when the limit is NaN", () => {
    const action = evaluateLoop({ complete: 0, looping: 0, progress: 2 }, 50, { ...THRESHOLDS, hardStepLimit: Number.NaN });
    expect(action.action).toBe("break");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses to start with hardStepLimit %s", async (limit) => {
    const { registry, tracer } = harness([readTool(), searchToolStub()]);
    const decider = phaseDecider({});
    await expect(runAgent("x", { decider, registry, tracer, hardStepLimit: limit })).rejects.toThrow(RangeError);
  });

  it("rejects out-of-range probability thresholds", () => {
    expect(() => assertValidThresholds({ ...THRESHOLDS, select: { minConfidence: 60 } })).toThrow(/minConfidence/);
  });
});

describe("a crashing decider leaves a forensic trail", () => {
  // Before: the exception escaped runAgent and the steps taken so far were lost.
  it("wraps the failure in AgentError carrying steps and transcript", async () => {
    let calls = 0;
    const decider = new FakeDecider((request) => {
      calls += 1;
      if (calls === 4) throw new Error("503 from upstream");
      if ("complete" in request.questions) return { ...DONE, complete: { type: "noul", noul: 0.1 } } as never;
      if ("destructive" in request.questions) return SAFE_GATE;
      return pickTool("read_file");
    });
    const { registry, tracer } = harness([readTool(), searchToolStub()]);

    const failure = await runAgent("read it", { decider, registry, tracer, hardStepLimit: 5 }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgentError);
    const error = failure as AgentError;
    expect(error.steps).toHaveLength(1);
    expect(error.transcript.at(-1)).toMatch(/503 from upstream/);
    expect((error.cause as Error).message).toBe("503 from upstream");
  });
});

describe("argument binder: apostrophes are not quotes", () => {
  // Before: "Don't ... 'ledger'" bound "t stop until you search for".
  it.each([
    ["Don't stop until you search for 'ledger'", "ledger"],
    ["Find the user's ledger, it's in 'billing.ts' okay", "billing.ts"],
    ['count "ledger" (it\'s everywhere)', "ledger"],
    ["search for `ledger`", "ledger"],
  ])("%s", (goal, expected) => {
    expect(extractTerm(goal)).toBe(expected);
  });

  it("does not bind a term from a bare apostrophe", () => {
    expect(extractTerm("it's the user's file")).toBeNull();
  });
});

describe("sandbox: links cannot smuggle a not-yet-existing path outside", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "jev-hard-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // Before: realpath failed on the missing leaf, and the purely lexical check passed.
  it("refuses link/new-file when link points outside the root", async () => {
    await symlink(outside, path.join(root, "link"));
    const sandbox = await createSandbox(root);
    await expect(sandbox.resolve("link/new-file.txt")).rejects.toThrow(SandboxViolation);
    await expect(sandbox.resolve("link/deeper/still/new.txt")).rejects.toThrow(SandboxViolation);
  });

  it("refuses a dangling symlink whose target would be created outside", async () => {
    await symlink(path.join(outside, "will-exist-later"), path.join(root, "dangling"));
    const sandbox = await createSandbox(root);
    await expect(sandbox.resolve("dangling")).rejects.toThrow(/dangling/);
  });

  it("still allows a genuinely new path inside the root", async () => {
    await mkdir(path.join(root, "src"));
    const sandbox = await createSandbox(root);
    const resolved = await sandbox.resolve("src/brand-new/file.ts");
    expect(resolved).toBe(path.join(sandbox.root, "src", "brand-new", "file.ts"));
  });

  it("does not mistake a sibling directory sharing a prefix for the root", async () => {
    const sandbox = await createSandbox(root);
    expect(sandbox.contains(root + "-sibling")).toBe(false);
    expect(sandbox.contains(path.join(sandbox.root, "..foo"))).toBe(true);
  });

  it("bounds reads: a huge file is neither loaded whole nor silently ignored", async () => {
    await writeFile(path.join(root, "small.txt"), "ledger ledger\n");
    await writeFile(path.join(root, "huge.log"), "ledger ".repeat(300_000)); // ~2.1 MB
    const sandbox = await createSandbox(root);
    const registry = new ToolRegistry(createBuiltinRegistry(sandbox));

    const counted = await registry.invoke({ tool: "count_matches", args: { pattern: "ledger" } });
    expect(counted.summary).toMatch(/occurs 2 time\(s\)/);
    expect(counted.summary).toMatch(/1 file\(s\) over 1000000 bytes skipped/);

    const read = await registry.invoke({ tool: "read_file", args: { path: "huge.log" } });
    expect(read.detail?.length).toBeLessThanOrEqual(64_000);
    expect(read.summary).toMatch(/read 64000 of \d+ bytes/);
  });
});

describe("question sets are validated on the real path", () => {
  // Before: `assertQuestionSet` lived in the test double; JevDecider never called it.
  it("rejects a score scale beyond the documented ten levels", () => {
    const levels = Array.from({ length: MAX_SCORE_LEVELS + 1 }, (_, i) => `level ${i}`);
    expect(() => assertQuestionSet({ q: { type: "score", instructions: "?", criteria: levels } })).toThrow(/limit is 10/);
  });

  it("rejects an empty request", () => {
    expect(() => assertQuestionSet({})).toThrow(/at least one question/);
  });

  it("JevDecider refuses a malformed set before making any request", async () => {
    let requests = 0;
    const decider = new JevDecider({
      apiKey: "test-key",
      fetch: (async () => {
        requests += 1;
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
    });

    await expect(
      decider.decide({ state: "x", questions: { bad: { type: "choice", instructions: "?", criteria: { only: null } } } }),
    ).rejects.toThrow(/at least two options/);
    expect(requests).toBe(0);
  });

  it("FakeDecider enforces the same limits as the real path", async () => {
    const decider = FakeDecider.scripted({ bad: choiceAnswer("only", 1) });
    await expect(
      decider.decide({ state: "x", questions: { bad: { type: "choice", instructions: "?", criteria: { only: null } } } }),
    ).rejects.toThrow(/at least two options/);
  });
});

describe("silent tracer stays silent", () => {
  it("retains entries without printing", () => {
    expect(silentTracer().entries).toEqual([]);
  });
});
