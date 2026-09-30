/**
 * The gate, end to end through `runAgent`.
 *
 * Each case scripts the distribution a model would return and asserts on what
 * the runtime then does with it. What these prove is our branch logic and our
 * policy — not that Jev produces these numbers.
 */

import { describe, expect, it, vi } from "vitest";

import { runAgent } from "../src/agent.js";
import { FakeDecider } from "../src/decider/fake.js";
import {
  DONE,
  FATAL_GATE,
  IRREVERSIBLE_GATE,
  SAFE_GATE,
  deleteToolStub,
  harness,
  phaseDecider,
  pickTool,
  readTool,
  searchToolStub,
} from "./helpers.js";

describe("gate: denies what must never run unattended", () => {
  it("refuses a hard system-wide delete without executing it", async () => {
    const execute = vi.fn(async () => ({ ok: true, summary: "deleted" }));

    const decider = FakeDecider.sequence([pickTool("delete"), FATAL_GATE]);
    const { registry, tracer } = harness([
      deleteToolStub({ execute }),
      searchToolStub({ execute }),
    ]);

    const run = await runAgent("wipe the workspace", { decider, registry, tracer });

    expect(run.stopReason).toBe("denied");
    expect(execute).not.toHaveBeenCalled();
    expect(run.summary).toMatch(/not recoverable/);
  });

  it("records the denial reason on the step for the trace", async () => {
    const decider = FakeDecider.sequence([pickTool("delete"), FATAL_GATE]);
    const { registry, tracer } = harness([deleteToolStub(), searchToolStub()]);

    const run = await runAgent("wipe it", { decider, registry, tracer });

    expect(run.steps[0]?.verdict).toBe("deny");
    expect(run.steps[0]?.reasons.join(" ")).toMatch(/destructive/);
  });
});

describe("gate: holds what a human should see", () => {
  it("does not execute an irreversible action by default", async () => {
    const execute = vi.fn(async () => ({ ok: true, summary: "done" }));

    const decider = FakeDecider.sequence([pickTool("delete"), IRREVERSIBLE_GATE]);
    const { registry, tracer } = harness([deleteToolStub({ execute }), searchToolStub()]);

    // No escalation handler supplied: the default denies, i.e. fails closed.
    const run = await runAgent("remove a file", { decider, registry, tracer });

    expect(run.stopReason).toBe("escalated");
    expect(execute).not.toHaveBeenCalled();
    expect(run.steps[0]?.verdict).toBe("ask_user");
  });

  it("executes once a human approves", async () => {
    const execute = vi.fn(async () => ({ ok: true, summary: "deleted one file" }));

    const decider = FakeDecider.sequence([pickTool("delete"), IRREVERSIBLE_GATE, DONE]);
    const { registry, tracer } = harness([deleteToolStub({ execute }), searchToolStub()]);

    const run = await runAgent("remove a file", { decider, registry, tracer, escalation: async () => true });

    expect(run.stopReason).toBe("complete");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("treats an unanswered escalation as a refusal", async () => {
    const decider = FakeDecider.sequence([pickTool("delete"), IRREVERSIBLE_GATE]);
    const { registry, tracer } = harness([deleteToolStub(), searchToolStub()]);

    // An escalation handler that resolves false must not be read as approval.
    const run = await runAgent("remove a file", {
      decider,
      registry,
      tracer,
      escalation: async () => false,
    });

    expect(run.stopReason).toBe("escalated");
    expect(run.summary).toMatch(/denied/i);
  });
});

describe("gate: leaves safe work alone", () => {
  it("executes a safe read with no human involvement", async () => {
    const execute = vi.fn(async () => ({ ok: true, summary: "read it" }));

    const decider = FakeDecider.sequence([pickTool("read_file"), SAFE_GATE, DONE]);
    const { registry, tracer } = harness([readTool({ execute }), searchToolStub()]);
    const escalation = vi.fn(async () => true);

    const run = await runAgent("read the file", { decider, registry, tracer, escalation });

    expect(escalation).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(run.steps[0]?.verdict).toBe("allow");
    expect(run.stopReason).toBe("complete");
  });

  it("escalates instead of guessing when no tool stands out", async () => {
    const decider = FakeDecider.sequence([pickTool("read_file", 0.3)]);
    const { registry, tracer } = harness([readTool(), searchToolStub()]);

    const run = await runAgent("do the thing", { decider, registry, tracer });

    expect(run.stopReason).toBe("escalated");
    expect(run.summary).toMatch(/no clear winner/i);
  });
});

describe("runtime hardening", () => {
  it("turns a throwing tool into a failed result instead of crashing the agent", async () => {
    const decider = phaseDecider({ select: pickTool("read_file"), gate: SAFE_GATE, judge: DONE });
    const { registry, tracer } = harness([
      readTool({
        execute: async () => {
          throw new Error("disk on fire");
        },
      }),
      searchToolStub(),
    ]);

    const run = await runAgent("read it", { decider, registry, tracer });

    expect(run.steps[0]?.result?.ok).toBe(false);
    expect(run.steps[0]?.result?.detail).toMatch(/disk on fire/);
  });

  it("refuses an empty catalogue rather than spinning on nothing", async () => {
    const decider = FakeDecider.scripted({});
    const { registry, tracer } = harness([]);

    await expect(runAgent("anything", { decider, registry, tracer })).rejects.toThrow(/registry is empty/);
  });

  it("names the available tools when one is unknown", () => {
    const { registry } = harness([readTool(), searchToolStub()]);

    expect(() => registry.get("nope")).toThrow(/read_file/);
  });
});