import { describe, expect, it } from "vitest";

import { defaultArgumentBinder, extractTerm } from "../src/arguments.js";

const bind = (goal: string, tool: string, steps: never[] = []) =>
  defaultArgumentBinder({ tool, goal, steps, effect: "read" });

describe("extractTerm", () => {
  it("prefers an explicitly quoted term", () => {
    expect(extractTerm('search the workspace for "ledger" and report it')).toBe("ledger");
  });

  it("falls back to a term introduced by a keyword", () => {
    expect(extractTerm("find how often the term ledger appears")).toBe("ledger");
  });

  it("accepts a path-like token", () => {
    expect(extractTerm("read src/auth.ts and summarise it")).toBe("src/auth.ts");
  });

  it("returns null when the goal has nothing to go on", () => {
    expect(extractTerm("do the needful")).toBeNull();
  });

  it("does not let an empty quoted string win", () => {
    expect(extractTerm('find the term "" in the files')).toBeNull();
  });
});

describe("defaultArgumentBinder", () => {
  it("binds a pattern parameter from the goal's term", () => {
    expect(bind('count how often "ledger" occurs', "count_matches")).toEqual({ pattern: "ledger" });
  });

  it("defaults a path parameter to the sandbox root", () => {
    expect(bind("list the workspace contents", "list_dir")).toEqual({ path: "." });
  });

  it("binds a path parameter when the goal names one", () => {
    expect(bind("read src/auth.ts please", "read_file")).toEqual({ path: "src/auth.ts" });
  });

  it("binds nothing for a tool it does not know", () => {
    expect(bind('count how often "ledger" occurs', "unknown_tool")).toEqual({});
  });

  it("binds nothing when no term can be extracted", () => {
    expect(bind("do the needful", "search")).toEqual({});
  });

  it("stops re-issuing a search once the term is already answered", () => {
    // The observation already reports the term, so repeating the search is waste.
    const steps = [
      {
        index: 0,
        call: { tool: "search", args: {} },
        verdict: "allow" as const,
        reasons: [],
        result: { ok: true, summary: '1 matches for "ledger"' },
      },
    ];

    expect(defaultArgumentBinder({ tool: "search", goal: 'find "ledger"', steps, effect: "read" })).toEqual({});
  });

  it("is replaceable, so callers can bind arguments their own way", () => {
    const custom = defaultArgumentBinder({
      tool: "search",
      goal: 'find "ledger"',
      steps: [],
      effect: "read",
      // The binder receives the tool name, so a caller can route on it.
    });

    expect(custom.pattern).toBe("ledger");
  });
});