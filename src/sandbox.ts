/**
 * Filesystem sandbox.
 *
 * The gate advises; this enforces. Whatever the model decides, a path that
 * resolves outside the allowed root is refused here. That separation is the
 * whole point of the design: the model is never the authority on permissions.
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

export interface Sandbox {
  /** Absolute, symlink-resolved root. */
  readonly root: string;
  /** Resolve a caller-supplied path, or throw if it escapes the root. */
  resolve(candidate: string): Promise<string>;
  /** True when the resolved path is inside the root. */
  contains(resolved: string): boolean;
}

/** Reject anything that is not a plain relative path before touching the disk. */
function assertPlausible(candidate: string): void {
  if (candidate.includes("\0")) {
    throw new SandboxViolation("path contains a null byte");
  }
  if (path.isAbsolute(candidate)) {
    throw new SandboxViolation(`absolute paths are not allowed: ${candidate}`);
  }
}

/**
 * Resolve symlinks for the longest prefix of `target` that exists, then re-attach
 * the part that does not.
 *
 * Checking only paths that exist is not enough: `link/new.txt`, where `link` is a
 * symlink to somewhere outside the root and `new.txt` does not exist yet, passes
 * a purely lexical check and would be created outside the sandbox by any tool
 * that writes. A dangling symlink is refused outright for the same reason.
 */
async function resolveThroughExistingAncestor(target: string, original: string): Promise<string> {
  let current = target;
  const missing: string[] = [];

  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // ELOOP, EACCES, ...: cannot prove containment, so fail closed.
        throw new SandboxViolation(`cannot resolve path safely (${code ?? "unknown error"}): ${original}`);
      }

      const info = await lstat(current).catch(() => null);
      if (info?.isSymbolicLink()) {
        throw new SandboxViolation(`path traverses a dangling symlink: ${original}`);
      }

      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function createSandbox(root: string): Promise<Sandbox> {
  const absoluteRoot = await realpath(path.resolve(root));

  // `path.relative` instead of `startsWith(root + sep)`: the latter breaks when the
  // root is a filesystem root ("/" + "/" is "//"), and the former needs no special case.
  const contains = (resolved: string): boolean => {
    const rel = path.relative(absoluteRoot, resolved);
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
  };

  return {
    root: absoluteRoot,

    contains,

    async resolve(candidate: string): Promise<string> {
      assertPlausible(candidate);

      const joined = path.resolve(absoluteRoot, candidate);
      if (!contains(joined)) {
        throw new SandboxViolation(`path escapes the sandbox root: ${candidate}`);
      }

      const resolved = await resolveThroughExistingAncestor(joined, candidate);
      if (!contains(resolved)) {
        throw new SandboxViolation(`path resolves outside the sandbox root via a link: ${candidate}`);
      }

      return resolved;
    },
  };
}
