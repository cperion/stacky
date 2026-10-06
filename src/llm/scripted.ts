import type { ModelAction } from "../stack/schemas.ts"
import { ProtocolError, type LLMClient, type ModelInput } from "./client.ts"

export type ScriptStep = ModelAction | ((input: ModelInput) => ModelAction | Promise<ModelAction>)

/** Deterministic LLM used for tests and the offline `--mock` demo. */
export class ScriptedLLM implements LLMClient {
  private index = 0

  constructor(
    private steps: ScriptStep[],
    private onExhausted: () => ModelAction = () => {
      throw new ProtocolError("Scripted LLM ran out of steps.")
    },
  ) {}

  get remaining(): number {
    return this.steps.length - this.index
  }

  async step(input: ModelInput): Promise<ModelAction> {
    const step = this.steps[this.index]
    this.index += 1
    if (!step) return this.onExhausted()
    return typeof step === "function" ? step(input) : step
  }
}

/**
 * A small scripted demo that exercises the whole machine offline:
 * push -> bash -> read -> user(required with choices) -> bash -> pop -> user(none).
 */
export class DemoLLM implements LLMClient {
  private cursor = 0

  async step(_input: ModelInput): Promise<ModelAction> {
    this.cursor += 1
    switch (this.cursor) {
      case 1:
        return {
          tool: "push",
          input: {
            why: "The user asked the agent to inspect this repository and report its structure.",
            scope:
              "Survey the repository at the workspace root: top-level files, package manifest, and source layout. " +
              "Do not modify any file.",
            knownContext: "The workspace is a fresh Bun + TypeScript project called stacky.",
            definitionOfDone:
              "A concise, evidence-backed summary of the repository structure has been produced and the user has been asked whether to continue.",
          },
        }
      case 2:
        return { tool: "bash", input: { command: "ls -la && echo '---' && find src -type f | sort" } }
      case 3:
        return { tool: "read", input: { path: "package.json" } }
      case 4:
        return {
          tool: "user",
          input: {
            message: "I've surveyed the repository. What would you like me to do next?",
            response: "required",
            choices: [
              { id: "typecheck", label: "Run the typechecker", description: "Verify the project compiles cleanly." },
              { id: "tests", label: "Run the test suite", description: "Execute bun test." },
              { id: "stop", label: "Stop here", description: "End the session with the survey report." },
            ],
            preferredChoice: { id: "typecheck", reason: "It is the fastest signal that the scaffold is sound." },
          },
        }
      case 5:
        return { tool: "bash", input: { command: "echo 'acknowledged'; date -u +%Y-%m-%dT%H:%M:%SZ" } }
      case 6:
        return {
          tool: "pop",
          input: {
            outcome: "completed",
            whatWasDone: "Listed the repository, inspected package.json, and asked the user for direction.",
            whyClosed: "The repository survey is complete and the user has been given the result.",
            evidence: "ls output and package.json contents were observed.",
            effectsOnParent: "None — this was the root frame.",
          },
        }
      case 7:
        return {
          tool: "user",
          input: {
            message:
              "Survey complete. This is a Bun + TypeScript project with an agent runtime, a task stack, a file LRU, and a three-pane TUI.\n\n" +
              "(This is the offline demo model. Run without --mock and with a provider API key to use a real model.)",
            response: "none",
          },
        }
      default:
        throw new ProtocolError("Demo script complete.")
    }
  }
}
