import type { ToolResult } from "../agent/types.ts"

export type BashValue = {
  command: string
  output: string
  exitCode: number
  truncated: boolean
}

export type BashOptions = {
  cwd: string
  timeoutMs?: number
  /** Called as output arrives, so the UI can show a command while it runs. */
  onOutput?: (chunk: string) => void
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

/** General operating-system access. Output streams as it is produced. */
export async function runBash(command: string, opts: BashOptions): Promise<ToolResult<BashValue>> {
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

    let stdout = ""
    let stderr = ""
    const decoder = new TextDecoder()

    const pump = async (stream: ReadableStream<Uint8Array>, sink: "out" | "err"): Promise<void> => {
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        if (sink === "out") stdout += text
        else stderr += text
        opts.onOutput?.(text)
      }
    }

    await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, "out"), pump(proc.stderr as ReadableStream<Uint8Array>, "err")])
    const exitCode = await proc.exited
    clearTimeout(timer)

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
