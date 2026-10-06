/**
 * Zod schemas for every model-facing action.
 *
 * Every model turn must validate against exactly one of these. Invalid output
 * is rejected and reported back as a protocol error — it is never silently
 * reinterpreted (implementation.md §28).
 */

import { z } from "zod"

export const pushSchema = z.object({
  why: z.string().min(1).describe("Why this frame exists and must be handled now."),
  scope: z
    .string()
    .min(1)
    .describe("Exactly what this frame is responsible for, and what is out of scope."),
  knownContext: z
    .string()
    .default("")
    .describe("Assumptions, facts, constraints, files, symptoms or observations motivating the frame."),
  definitionOfDone: z
    .string()
    .min(1)
    .describe(
      "The condition under which this frame can be closed. This does not require the initial hypothesis to be correct.",
    ),
})

export const popSchema = z.object({
  outcome: z
    .enum([
      "completed",
      "disproven",
      "unnecessary",
      "abandoned",
      "superseded",
      "blocked",
      "failed",
      "partial",
    ])
    .describe("The disposition of the frame being closed."),
  whatWasDone: z.string().min(1).describe("What was actually investigated, changed or tested. Say so if nothing changed."),
  whyClosed: z.string().min(1).describe("Why it is now correct to remove this frame from the stack."),
  evidence: z.string().default("").describe("Commands, tests, files, measurements or discoveries justifying the disposition."),
  effectsOnParent: z
    .string()
    .default("")
    .describe("What the parent frame should now know: changes, new facts, risks or recommended next direction."),
})

export const userChoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
})

export const userRequestSchema = z.object({
  message: z.string().min(1).describe("The message to show the human. This is the ONLY user-visible output channel."),
  response: z
    .enum(["required", "optional", "none"])
    .describe("required = suspend until the human replies; none = report and yield."),
  choices: z.array(userChoiceSchema).optional().describe("Optional structured choices for the human."),
  preferredChoice: z
    .object({ id: z.string().min(1), reason: z.string().min(1) })
    .optional()
    .describe("Optional recommended choice with an explicit justification."),
})

export const bashSchema = z.object({
  command: z.string().min(1).describe("Shell command to run in the workspace."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Optional timeout in milliseconds (default 120000)."),
})

export const readSchema = z.object({
  path: z.string().min(1).describe("File path relative to the workspace root (or absolute)."),
})

export const editPatchSchema = z.object({
  path: z.string().min(1).describe("File path relative to the workspace root (or absolute)."),
  edits: z
    .array(
      z.object({
        oldText: z
          .string()
          .describe("Exact text to replace. Must match uniquely unless replaceAll is true. Empty string creates a new file."),
        newText: z.string().describe("Replacement text."),
        replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
      }),
    )
    .min(1),
})

export const ACTION_SCHEMAS = {
  bash: bashSchema,
  read: readSchema,
  edit: editPatchSchema,
  push: pushSchema,
  pop: popSchema,
  spawn: pushSchema,
  user: userRequestSchema,
} as const

export type ToolName = keyof typeof ACTION_SCHEMAS

export type PushAction = z.infer<typeof pushSchema>
export type PopAction = z.infer<typeof popSchema>
export type UserRequestAction = z.infer<typeof userRequestSchema>
export type BashAction = z.infer<typeof bashSchema>
export type ReadAction = z.infer<typeof readSchema>
export type EditAction = z.infer<typeof editPatchSchema>

export type ModelAction = {
  [K in ToolName]: { tool: K; input: z.infer<(typeof ACTION_SCHEMAS)[K]> }
}[ToolName]

export const ALL_TOOL_NAMES = Object.keys(ACTION_SCHEMAS) as ToolName[]
