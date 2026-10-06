import type { ToolResult } from "../agent/types.ts"

export type BashValue = {
  command: string
  output: string
  exitCode: number
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 24_000

function truncate(text: string, limit = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return {
    text: `${text.slice(0, head)}\n… [${text.length - limit} chars truncated] …\n${text.slice(-tail)}`,
    truncated: true,
  }
}

/** General operating-system access. Output is an observation, not persistent file context. */
export async function runBash(
  command: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<ToolResult<BashValue>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer))

    const combined = stderr.length > 0 ? `${stdout}${stdout && !stdout.endsWith("\n") ? "\n" : ""}[stderr]\n${stderr}` : stdout
    const { text, truncated } = truncate(combined)

    if (timedOut) {
      return { ok: false, error: `Command timed out after ${timeoutMs}ms`, value: { command, output: text, exitCode, truncated } }
    }
    return { ok: exitCode === 0, value: { command, output: text, exitCode, truncated } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
