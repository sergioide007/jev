/**
 * Runnable demo.
 *
 *   npm run demo              offline, deterministic double
 *   npm run demo -- --live    the real API (needs TYPESAFE_API_KEY)
 *
 * The offline path is the default on purpose: the control layer should be
 * demonstrable in CI without credentials or a network bill.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAgent } from "./agent.js";
import { FakeDecider } from "./decider/fake.js";
import { JevDecider } from "./decider/jev.js";
import { createSandbox } from "./sandbox.js";
import { ToolRegistry } from "./tools/registry.js";
import { createBuiltinRegistry } from "./tools/builtin.js";
import { Tracer } from "./trace.js";
import type { Decider } from "./decider/types.js";

const live = process.argv.includes("--live");

/** Build a throwaway workspace with enough text to make the tools meaningful. */
async function makeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "jev-demo-"));

  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "auth.ts"),
    "export function login(user: string) {\n  return sessionFor(user);\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "billing.ts"),
    "export function charge(amount: number) {\n  return ledger.write(amount);\n}\n",
    "utf8",
  );
  await writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");

  return root;
}

async function main(): Promise<void> {
  const root = await makeFixture();

  try {
    const sandbox = await createSandbox(root);
    // `allowDelete` puts a genuinely dangerous tool in the catalogue so the gate
    // has something real to refuse.
    const registry = new ToolRegistry(createBuiltinRegistry(sandbox, { allowDelete: true }));

    const goal = "Search the workspace files for the term ledger and report how often it occurs.";

    const tracer = new Tracer({
      sink: (line) => {
        // One readable line per decision instead of raw JSON.
        const entry = JSON.parse(line) as {
          step: number;
          phase: string;
          verdict: string;
          reasons: string[];
          costUsd: number;
          model: string;
        };
        const reason = entry.reasons.length > 0 ? ` — ${entry.reasons[0]}` : "";
        console.log(`  [step ${entry.step}] ${entry.phase.padEnd(6)} → ${entry.verdict}${reason}`);
      },
    });

    const decider: Decider = live
      ? JevDecider.fromEnv()
      : FakeDecider.heuristic(registry.specs());

    if (live) {
      console.log("\nLIVE: using the real API. Watch the model id in each decision.\n");
    } else {
      console.log("\nOFFLINE: using the deterministic double. No network, no cost.\n");
    }

    console.log(`goal: ${goal}\n`);

    const run = await runAgent(goal, {
      decider,
      registry,
      tracer,
      // No escalation handler: any `ask_user` fails closed.
      ...(live ? {} : { model: "jev-1.13.0" }),
    });

    console.log(`\ntranscript:`);
    for (const line of run.transcript) console.log(`  · ${line}`);

    const summary = tracer.summary();
    console.log(`\nstop reason: ${run.stopReason}`);
    console.log(`summary:      ${run.summary}`);
    console.log(
      `decisions:    ${summary.decisions} (${summary.inputTokens} input tokens, $${summary.costUsd.toFixed(8)})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();