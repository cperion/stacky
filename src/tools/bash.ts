import type { ToolResult } from "../agent/types.ts"

export type BashValue = {
  command: string
  output: string
  exitCode: number
  /** Capture quota, NOT display pagination. Omitted bytes cannot be recovered. */
  truncated: boolean
  omittedBytes?: number
}

export type BashOptions = {
  cwd: string
  timeoutMs?: number
  onOutput?: (chunk: string) => void
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/** Execute once; capture before paging. Keep stdout/stderr distinct while decoding. */
export async function runBash(command: string, opts: BashOptions): Promise<ToolResult<BashValue>> {
  if (opts.signal?.aborted) return { ok: false, error: "Command interrupted before execution" }
  let timer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let proc: ReturnType<typeof Bun.spawn> | undefined
  let aborted = false
  let timedOut = false
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    if (!proc) return
    try { process.kill(-proc.pid, signal) } catch { try { proc.kill(signal) } catch {} }
  }
  const terminate = () => {
    kill("SIGTERM")
    if (!killTimer) killTimer = setTimeout(() => {
      kill("SIGKILL")
      for (const reader of readers) void reader.cancel().catch(() => {})
    }, 250)
  }
  const abort = () => { aborted = true; terminate() }
  try {
    proc = Bun.spawn(["bash", "-lc", command], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env }, detached: true })
    opts.signal?.addEventListener("abort", abort, { once: true })
    if (opts.signal?.aborted) abort()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    timer = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
    let remaining = MAX_CAPTURE_BYTES
    let omittedBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const pump = async (stream: ReadableStream<Uint8Array>, target: Buffer[]): Promise<void> => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      readers.add(reader)
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const kept = Math.min(remaining, value.byteLength)
          if (kept) target.push(Buffer.from(value.subarray(0, kept)))
          remaining -= kept
          omittedBytes += value.byteLength - kept
          opts.onOutput?.(decoder.decode(value, { stream: true }))
        }
        const tail = decoder.decode()
        if (tail) opts.onOutput?.(tail)
      } catch (error) {
        if (!aborted && !timedOut) throw error
      } finally {
        readers.delete(reader)
        reader.releaseLock()
      }
    }
    await Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>, stdout),
      pump(proc.stderr as ReadableStream<Uint8Array>, stderr),
    ])
    const exitCode = await proc.exited
    const out = Buffer.concat(stdout).toString("utf8")
    const err = Buffer.concat(stderr).toString("utf8")
    const output = out + (err ? `${out && !out.endsWith("\n") ? "\n" : ""}[stderr]\n${err}` : "")
    const value: BashValue = { command, output, exitCode, truncated: omittedBytes > 0, omittedBytes }
    return aborted ? { ok: false, error: "Command interrupted", value }
      : timedOut ? { ok: false, error: `Command timed out after ${timeoutMs}ms`, value }
      : { ok: exitCode === 0, value }
  } catch (error) {
    kill("SIGKILL")
    for (const reader of readers) void reader.cancel().catch(() => {})
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer) clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    opts.signal?.removeEventListener("abort", abort)
  }
}
