/**
 * Filesystem sandbox.
 *
 * The gate advises; this enforces. Whatever the model decides, a path that
 * resolves outside the allowed root is refused here. That separation is the
 * whole point of the design: the model is never the authority on permissions.
 */

import { realpath } from "node:fs/promises";
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

export async function createSandbox(root: string): Promise<Sandbox> {
  const absoluteRoot = await realpath(path.resolve(root));

  const contains = (resolved: string): boolean =>
    resolved === absoluteRoot || resolved.startsWith(absoluteRoot + path.sep);

  return {
    root: absoluteRoot,

    contains,

    async resolve(candidate: string): Promise<string> {
      assertPlausible(candidate);

      const joined = path.resolve(absoluteRoot, candidate);
      if (!contains(joined)) {
        throw new SandboxViolation(`path escapes the sandbox root: ${candidate}`);
      }

      // Resolve symlinks when the target exists, so a link pointing outside the
      // root cannot be used as a tunnel. A missing target is fine: callers that
      // create paths need the lexical check above to still hold.
      let resolved = joined;
      try {
        resolved = await realpath(joined);
      } catch {
        // Target does not exist yet; the lexical containment check stands.
      }

      if (!contains(resolved)) {
        throw new SandboxViolation(`path resolves outside the sandbox root via a link: ${candidate}`);
      }

      return resolved;
    },
  };
}