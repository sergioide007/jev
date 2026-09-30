/**
 * Argument binding.
 *
 * This module exists because of a hard limitation of the model class: a Choice
 * answer is a *label*, not a call. Jev can tell you which tool fits, but it
 * cannot produce the arguments for it, and it cannot generate text.
 *
 * So arguments are derived deterministically, in code. That is not a workaround
 * — it is the deal. Everything a frontier LLM would have done implicitly between
 * "the user wants the ledger count" and `count_matches({pattern: "ledger"})`
 * has to be rebuilt here, explicitly. The alternative is a planner LLM upstream,
 * which is a different architecture (and re-introduces the parsing this project
 * exists to avoid).
 *
 * Swap this for your own logic when the built-in extraction is too naive.
 */

import type { Step } from "./types.js";

export type ArgumentBinder = (request: {
  readonly tool: string;
  readonly goal: string;
  readonly steps: readonly Step[];
  readonly effect: string;
}) => Record<string, string>;

/** A term the user put in quotes: the most reliable signal available. */
const QUOTED = /["'`]([^"'`\n]{1,120})["'`]/;

/** ...or one introduced by a keyword: "the term ledger", "the word ledger". */
const INTRODUCED = /\b(?:term|word|string|phrase|token|pattern)\s+([\w./-]{2,60})\b/i;

/** A path-like token, for tools that take a `path`. */
const PATH_LIKE = /(?:^|\s)((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8})(?=\s|$)/;

/**
 * Pull the salient term out of a goal: quoted first, then introduced, then a
 * bare path. Returns null when nothing matches.
 */
export function extractTerm(goal: string): string | null {
  const quoted = QUOTED.exec(goal);
  if (quoted?.[1] !== undefined) return quoted[1].trim();

  const introduced = INTRODUCED.exec(goal);
  if (introduced?.[1] !== undefined) return introduced[1].trim();

  const path = PATH_LIKE.exec(goal);
  if (path?.[1] !== undefined) return path[1].trim();

  return null;
}

/**
 * The default binder.
 *
 * Maps the tool's declared parameter names onto whatever could be extracted from
 * the goal: `pattern`-ish parameters get the term, `path`-ish parameters get a
 * path (defaulting to the sandbox root), and anything else is left empty for the
 * tool to validate.
 */
export const defaultArgumentBinder: ArgumentBinder = ({ tool, goal, steps }) => {
  const args: Record<string, string> = {};

  // If a previous observation already reports the term, re-running the search is
  // pointless; only rebind parameters we can still satisfy.
  const term = extractTerm(goal);
  const lastObservation = steps.at(-1)?.result?.summary ?? "";

  const satisfied = term !== null && term !== "" && lastObservation.toLowerCase().includes(term.toLowerCase());

  const spec = TOOL_PARAMS[tool];
  if (spec === undefined) return args;

  for (const param of spec) {
    if (isPathParam(param)) args[param] = term !== null && PATH_LIKE.test(` ${term}`) ? term : ".";
    else if (!satisfied && term !== null) args[param] = term;
  }

  return args;
};

/** Parameters we know how to satisfy, keyed by tool name. */
const TOOL_PARAMS: Record<string, readonly string[]> = {
  read_file: ["path"],
  list_dir: ["path"],
  search: ["pattern"],
  count_matches: ["pattern"],
  delete_path: ["path"],
};

function isPathParam(param: string): boolean {
  return param === "path" || param.endsWith("_path") || param === "dir" || param === "directory";
}