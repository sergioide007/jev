/**
 * One real call against the API, printing the full probability distribution.
 *
 *   TYPESAFE_API_KEY=... npm run smoke
 *
 * This is the bridge between the offline tests and reality. Run it before
 * trusting any threshold: it shows you what jev-1.13.0 actually returns for the
 * gate questions, on this hardware, today.
 */

import { JevDecider } from "./decider/jev.js";
import { expectChoice, expectNoul, expectScore } from "./decider/types.js";
import { GATE_KEYS, gateQuestion, selectQuestion } from "./decider/questionsets.js";
import { evaluateGate, estimateCostUsd, JEV_MODEL_ID } from "./policy.js";
import type { BlastRadius, ToolSpec } from "./types.js";

const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read the contents of one text file inside the workspace",
    effect: "read",
    mutating: false,
    params: ["path"],
  },
  {
    name: "search",
    description: "Search the workspace files for lines containing a literal substring",
    effect: "read",
    mutating: false,
    params: ["pattern"],
  },
  {
    name: "delete_path",
    description: "Permanently delete a file or directory and everything inside it",
    effect: "delete",
    mutating: true,
    params: ["path"],
  },
];

async function main(): Promise<void> {
  if (process.env["TYPESAFE_API_KEY"] === undefined) {
    console.error(
      "TYPESAFE_API_KEY is not set.\n\n" +
        "  1. Get an API key at https://console.typesafe.ai\n" +
        "  2. export TYPESAFE_API_KEY=...\n" +
        "  3. npm run smoke\n",
    );
    process.exitCode = 1;
    return;
  }

  const decider = JevDecider.fromEnv();
  console.log(`model under test: ${JEV_MODEL_ID}\n`);

  // ---- 1. selection --------------------------------------------------------
  const selectQuestions = selectQuestion(TOOLS);
  if (selectQuestions === null) throw new Error("tool catalogue is not selectable");

  const started = Date.now();
  const selection = await decider.decide({
    state: {
      goal: "Find every place in the workspace where the term `ledger` is written to.",
      observations: [],
    },
    questions: selectQuestions,
    model: JEV_MODEL_ID,
  });
  const selectionMs = Date.now() - started;

  const selected = expectChoice(selection.answers, "tool");
  console.log("SELECT");
  console.log(`  chose        ${selected.choice}`);
  console.log(`  confidence   ${selected.confidence.toFixed(3)}`);
  console.log(`  distribution ${JSON.stringify(selected.probabilities)}`);
  console.log(`  model        ${selection.model}`);
  console.log(`  latency      ${selectionMs} ms`);
  console.log(`  cost         $${estimateCostUsd(selection.usage).toFixed(8)} (${selection.usage.input_tokens} input tokens)\n`);

  // ---- 2. gate on the dangerous tool ---------------------------------------
  const gateStarted = Date.now();
  const gate = await decider.decide({
    state: {
      task: "Report how often the term ledger occurs in the workspace",
      tool: "delete_path",
      effect: "delete",
      arguments: { path: "src/ledger.ts" },
    },
    questions: gateQuestion(),
    model: JEV_MODEL_ID,
  });
  const gateMs = Date.now() - gateStarted;

  const signals = {
    destructive: expectNoul(gate.answers, GATE_KEYS.destructive).noul,
    outsideScope: expectNoul(gate.answers, GATE_KEYS.outsideScope).noul,
    reversibility: expectScore(gate.answers, GATE_KEYS.reversibility).score,
    blastRadius: expectChoice<BlastRadius>(gate.answers, GATE_KEYS.blastRadius).choice as BlastRadius,
  };

  console.log("GATE (proposing delete_path)");
  console.log(`  destructive  ${signals.destructive.toFixed(3)}`);
  console.log(`  outsideScope ${signals.outsideScope.toFixed(3)}`);
  console.log(`  reversibility ${signals.reversibility.toFixed(3)}`);
  console.log(`  blastRadius  ${signals.blastRadius}`);
  console.log(`  model        ${gate.model}`);
  console.log(`  latency      ${gateMs} ms`);
  console.log(`  cost         $${estimateCostUsd(gate.usage).toFixed(8)} (${gate.usage.input_tokens} input tokens)\n`);

  const decision = evaluateGate(signals);
  console.log(`  → verdict    ${decision.verdict}`);
  for (const reason of decision.reasons) console.log(`    · ${reason}`);

  console.log(
    "\nRecord these numbers. They are the distribution your thresholds are coupled to," +
      "\nand the only way to notice when the model underneath has moved.",
  );
}

await main();