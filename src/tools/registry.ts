/**
 * Tool registry.
 *
 * A tool's `description` is not documentation: it is the text a Choice
 * question is built from, so it has to be discriminative enough for the model
 * to pick correctly. Vague descriptions produce vague selections.
 */

import type { ToolCall, ToolResult, ToolSpec } from "../types.js";

export interface Tool extends ToolSpec {
  /** Arguments arrive as strings straight from the model; validate here. */
  execute(args: Readonly<Record<string, string>>): Promise<ToolResult>;
}

export class UnknownToolError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(`unknown tool "${name}"; available tools: ${known.join(", ")}`);
    this.name = "UnknownToolError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new UnknownToolError(name, [...this.tools.keys()]);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Specs in a stable order so the Choice question is reproducible. */
  specs(): ToolSpec[] {
    return [...this.tools.values()]
      .map(({ name, description, effect, mutating, params }) => ({ name, description, effect, mutating, params }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve a proposed call to a concrete tool, then hand off to it.
   *
   * Note the ordering: an unknown tool is a hard failure that never reaches a
   * tool body, and argument validation happens inside the tool, behind the
   * sandbox.
   */
  async invoke(call: ToolCall): Promise<ToolResult> {
    const tool = this.get(call.tool);

    try {
      return await tool.execute(call.args);
    } catch (error) {
      // A tool that throws must not take the agent down. Turn it into a failed
      // result so the loop can observe it and try something else.
      return {
        ok: false,
        summary: `${call.tool} failed`,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}