import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxViolation, createSandbox } from "../src/sandbox.js";

describe("sandbox", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "jev-sandbox-"));
    outside = await mkdtemp(path.join(tmpdir(), "jev-outside-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.txt"), "hello", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "do not read me", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("resolves a path inside the root", async () => {
    const sandbox = await createSandbox(root);

    const resolved = await sandbox.resolve("src/a.txt");

    expect(resolved).toBe(path.join(await createSandbox(root).then((s) => s.root), "src", "a.txt"));
  });

  it("accepts the root itself", async () => {
    const sandbox = await createSandbox(root);

    await expect(sandbox.resolve(".")).resolves.toBe(sandbox.root);
  });

  it("rejects traversal out of the root", async () => {
    const sandbox = await createSandbox(root);

    await expect(sandbox.resolve("../escape.txt")).rejects.toBeInstanceOf(SandboxViolation);
  });

  it("rejects traversal that only escapes after normalisation", async () => {
    const sandbox = await createSandbox(root);

    // `src/../../etc` lexically starts inside the root but resolves outside it.
    await expect(sandbox.resolve("src/../../etc/passwd")).rejects.toBeInstanceOf(SandboxViolation);
  });

  it("rejects absolute paths outright", async () => {
    const sandbox = await createSandbox(root);

    await expect(sandbox.resolve("/etc/passwd")).rejects.toBeInstanceOf(SandboxViolation);
  });

  it("rejects null bytes", async () => {
    const sandbox = await createSandbox(root);

    await expect(sandbox.resolve("src/a.txt\u0000.png")).rejects.toBeInstanceOf(SandboxViolation);
  });

  it("refuses a symlink that tunnels out of the root", async () => {
    const sandbox = await createSandbox(root);
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape-link.txt"));

    // The lexical path is inside the root; only realpath catches this.
    await expect(sandbox.resolve("escape-link.txt")).rejects.toBeInstanceOf(SandboxViolation);
  });

  it("allows a path that does not exist yet, for tools that create files", async () => {
    const sandbox = await createSandbox(root);

    await expect(sandbox.resolve("src/new.txt")).resolves.toBe(path.join(sandbox.root, "src", "new.txt"));
  });

  it("reports containment", async () => {
    const sandbox = await createSandbox(root);

    expect(sandbox.contains(sandbox.root)).toBe(true);
    expect(sandbox.contains(path.join(sandbox.root, "a.txt"))).toBe(true);
    expect(sandbox.contains(outside)).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as contained", async () => {
    // `/tmp/root` must not contain `/tmp/root-sibling`: the classic prefix bug.
    const sandbox = await createSandbox(root);

    expect(sandbox.contains(`${sandbox.root}-sibling`)).toBe(false);
  });
});