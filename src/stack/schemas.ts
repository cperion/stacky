/**
 * Zod schemas for every model-facing action.
 *
 * Every model turn must validate against exactly one of these. Invalid output
 * is rejected and reported back as a protocol error — it is never silently
 * reinterpreted (implementation.md §28).
 */

import { z } from "zod"

export const pushSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("A short imperative title for this frame (<= 6 words), used in the UI. e.g. \"Fix token expiry parsing\"."),
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
  todos: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Ordered, concrete steps this frame will perform. Each must later be marked done with todo({index, status:\"done\"}) or abandoned with todo({index, status:\"abandoned\", note}). pop() is refused while any step is still pending.",
    ),
})

export const todoSchema = z.object({
  index: z.number().int().min(1).describe("1-based index of the todo in the current frame."),
  status: z.enum(["done", "abandoned"]).describe("Mark this step done, or abandoned (needs a note)."),
  note: z.string().optional().describe("Why the step was abandoned or left undone."),
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
  path: z.string().min(1).optional().describe("Current file path. Supply exactly one of path or ref."),
  ref: z.string().min(1).optional().describe("Exact reference from context/history: file, view, page, line, artifact, frame or event. Never invent references."),
  find: z.string().min(1).max(2000).optional().describe("Literal text to locate in this resource. History search covers event descriptors; follow artifact refs to search their bodies."),
  budgetTokens: z.number().int().min(128).max(24000).optional().describe("Desired view budget in estimated tokens, capped by total working memory; default at most 4096."),
}).refine((input) => (input.path === undefined) !== (input.ref === undefined), "Supply exactly one of path or ref")

const textEditSchema = z.object({
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

const anchorEditSchema = z.object({
  from: z.string().min(1).optional(),
  through: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  text: z.string().describe("Replacement complete lines. Empty text deletes a range; before/after explicitly insert."),
}).strict().refine((edit) => {
  const range = edit.from !== undefined && edit.through !== undefined && edit.before === undefined && edit.after === undefined
  const insertion = edit.from === undefined && edit.through === undefined && ((edit.before === undefined) !== (edit.after === undefined))
  return range || insertion
}, "Use from+through (inclusive), or before, or after")

// Keep the tool schema an object at its root (required by provider function APIs).
export const editPatchSchema = z.object({
  path: textEditSchema.shape.path.optional().describe("Only for compatibility text replacement or creating a missing file; omit for anchor edits."),
  edits: z.array(z.union([anchorEditSchema, textEditSchema.shape.edits.element])).min(1).max(100),
}).strict().refine((input) => input.path === undefined
  ? input.edits.every((edit) => "text" in edit)
  : input.edits.every((edit) => "oldText" in edit), "Anchor edits omit path; text replacements require path. Never mix formats.")

export const ACTION_SCHEMAS = {
  bash: bashSchema,
  read: readSchema,
  edit: editPatchSchema,
  push: pushSchema,
  pop: popSchema,
  todo: todoSchema,
  spawn: pushSchema,
  user: userRequestSchema,
} as const

export type ToolName = keyof typeof ACTION_SCHEMAS

export type PushAction = z.infer<typeof pushSchema>
export type PopAction = z.infer<typeof popSchema>
export type TodoAction = z.infer<typeof todoSchema>
export type UserRequestAction = z.infer<typeof userRequestSchema>
export type BashAction = z.infer<typeof bashSchema>
export type ReadAction = z.infer<typeof readSchema>
export type EditAction = z.infer<typeof editPatchSchema>

export type ModelAction = {
  [K in ToolName]: { tool: K; input: z.infer<(typeof ACTION_SCHEMAS)[K]> }
}[ToolName]

export const ALL_TOOL_NAMES = Object.keys(ACTION_SCHEMAS) as ToolName[]
