/**
 * Built-in tools.
 *
 * These operate only inside a `Sandbox`. `delete_path` is included on purpose:
 * having a genuinely dangerous tool in the catalogue is what makes the gate
 * worth testing, and a demo where everything is safe proves nothing.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { Tool } from "./registry.js";
import type { Sandbox } from "../sandbox.js";

const MAX_BYTES = 64_000;
/** Bound the crawl: an unbounded search inside an agent loop never converges. */
const MAX_DEPTH = 6;
const MAX_HITS = 50;

function requireString(args: Readonly<Record<string, string>>, key: string): string {
  const value = args[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required argument "${key}"`);
  }
  return value;
}

function relative(sandbox: Sandbox, target: string): string {
  return path.relative(sandbox.root, target) || ".";
}

export function readFileTool(sandbox: Sandbox): Tool {
  return {
    name: "read_file",
    description: "Read the contents of one text file inside the workspace",
    effect: "read",
    mutating: false,
    params: ["path"],
    async execute(args) {
      const target = await sandbox.resolve(requireString(args, "path"));
      const info = await stat(target);
      if (!info.isFile()) throw new Error("not a regular file");

      const contents = await readFile(target, "utf8");
      return {
        ok: true,
        summary: `read ${info.size} bytes from ${relative(sandbox, target)}`,
        detail: contents.slice(0, MAX_BYTES),
      };
    },
  };
}

export function listDirTool(sandbox: Sandbox): Tool {
  return {
    name: "list_dir",
    description: "List the files and subdirectories contained in one directory",
    effect: "read",
    mutating: false,
    params: ["path"],
    async execute(args) {
      const target = await sandbox.resolve(requireString(args, "path"));
      const entries = await readdir(target, { withFileTypes: true });

      const listing = entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort()
        .join("\n");

      return {
        ok: true,
        summary: `${entries.length} entries in ${relative(sandbox, target)}`,
        detail: listing,
      };
    },
  };
}

/** Shared read-only walker over the sandbox tree. */
async function walkFiles(sandbox: Sandbox, onFile: (path: string, contents: string) => void): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile()) onFile(child, await readFile(child, "utf8").catch(() => ""));
    }
  };
  await walk(sandbox.root, 0);
}

export function searchTool(sandbox: Sandbox): Tool {
  return {
    name: "search",
    description: "Search the workspace files for lines containing a literal substring",
    effect: "read",
    mutating: false,
    params: ["pattern"],
    async execute(args) {
      const needle = requireString(args, "pattern").toLowerCase();
      const hits: string[] = [];

      await walkFiles(sandbox, (file, contents) => {
        if (hits.length >= MAX_HITS) return;
        contents.split("\n").forEach((line, index) => {
          if (hits.length < MAX_HITS && line.toLowerCase().includes(needle)) {
            hits.push(`${relative(sandbox, file)}:${index + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      });

      return { ok: true, summary: `${hits.length} matches for "${needle}"`, detail: hits.join("\n") };
    },
  };
}

export function countMatchesTool(sandbox: Sandbox): Tool {
  return {
    name: "count_matches",
    description: "Count how many times a literal substring occurs across all workspace files",
    effect: "read",
    mutating: false,
    params: ["pattern"],
    async execute(args) {
      const needle = requireString(args, "pattern").toLowerCase();
      let total = 0;

      await walkFiles(sandbox, (_file, contents) => {
        const haystack = contents.toLowerCase();
        let index = haystack.indexOf(needle);
        while (index !== -1) {
          total += 1;
          index = haystack.indexOf(needle, index + needle.length);
        }
      });

      return { ok: true, summary: `"${needle}" occurs ${total} time(s)` };
    },
  };
}
/**
 * Destructive on purpose. Registered only when the caller opts in, and even then
 * the gate is expected to stop it: system-wide blast radius combined with a
 * high destructive probability is an unconditional `deny`.
 */
export function deletePathTool(sandbox: Sandbox): Tool {
  return {
    name: "delete_path",
    description: "Permanently delete a file or directory and everything inside it",
    effect: "delete",
    mutating: true,
    params: ["path"],
    async execute(args) {
      const target = await sandbox.resolve(requireString(args, "path"));
      if (target === sandbox.root) throw new Error("refusing to delete the sandbox root");

      const info = await stat(target);
      await rm(target, { recursive: true, force: true });

      return {
        ok: true,
        summary: `deleted ${info.isDirectory() ? "directory" : "file"} ${relative(sandbox, target)}`,
      };
    },
  };
}

export function createBuiltinRegistry(sandbox: Sandbox, options: { allowDelete?: boolean } = {}): Tool[] {
  const tools: Tool[] = [readFileTool(sandbox), listDirTool(sandbox), searchTool(sandbox), countMatchesTool(sandbox)];
  if (options.allowDelete === true) tools.push(deletePathTool(sandbox));
  return tools;
}