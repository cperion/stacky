import type { ModelList } from "../llm/models.ts"
import type { ProviderName } from "../llm/providers.ts"

export function modelListSummary(list: ModelList): string {
  if (list.source === "unavailable") return "unavailable"
  const when = list.checkedAt !== undefined ? new Date(list.checkedAt).toISOString() : "unknown time"
  return list.source === "api"
    ? `API · ${list.ids.length} models · fetched ${when}`
    : `saved API response · ${when}${list.error ? " · refresh FAILED" : list.stale ? " · stale" : ""}`
}

export function formatModelList(provider: ProviderName, list: ModelList, current?: string): string {
  const lines = [`${provider} — ${modelListSummary(list)}`, `  GET ${list.endpoint}`]
  if (list.error) lines.push(`  ! ${list.error}`)
  if (list.source === "api" && list.ids.length === 0) lines.push("  The provider returned no listed models.")
  for (const id of list.ids) lines.push(`  ${current === `${provider}/${id}` ? "❯" : " "} ${provider}/${id}`)
  return lines.join("\n")
}
