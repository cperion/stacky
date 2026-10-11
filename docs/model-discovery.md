# Provider model discovery

The model picker uses provider responses, **never a compiled model catalog**.
Startup defaults and legacy config hints in `src/llm/catalog.ts` are not a discovery source.

## Requests

| Provider | Request | Authentication / protocol |
| --- | --- | --- |
| OpenAI | `GET https://api.openai.com/v1/models` | API-key bearer; `data[].id` |
| DeepSeek | `GET https://api.deepseek.com/models` | API-key bearer; `data[].id` |
| Anthropic | `GET https://api.anthropic.com/v1/models?limit=100` | `x-api-key`, `anthropic-version: 2023-06-01`; `data[].id` |
| ChatGPT subscription | `GET https://chatgpt.com/backend-api/codex/models?client_version=0.162.1` | OAuth bearer, `chatgpt-account-id`, `originator: stacky`; `models[].slug` |

Anthropic discovery follows `has_more` / `last_id`, passing `after_id` on subsequent
requests. A failed later page is a failed discovery, not a successful partial list.
OpenAI and DeepSeek's model-list endpoints are not paginated.

ChatGPT uses the **Codex catalog**, not OpenAI's API-key catalog or the consumer
ChatGPT web-app model selector. The `client_version` parameter negotiates Codex
catalog compatibility. Its default tracks the reviewed Codex 0.162.1 contract;
`STACKY_CODEX_CLIENT_VERSION` overrides it when updating that integration. It is
not a hardcoded list of model names. Picker entries respect server `visibility`
and `priority`. `supported_in_api: false` does not exclude subscription models.

Provider order is retained for the API-key lists; old compiled model names are
not inserted or ranked above newer API results. OpenAI's endpoint also lists
non-chat models; listing an ID does not certify tool-calling compatibility.

### Contract references

- [OpenAI models resource](https://github.com/openai/openai-node/blob/master/src/resources/models.ts)
- [DeepSeek models API](https://api-docs.deepseek.com/api/list-models)
- [Anthropic models resource](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts)
- [Anthropic pagination](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/core/pagination.ts)
- [Codex models endpoint](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs)
- [Codex model metadata](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)

## UI and diagnostics

- `/model` fetches every provider now. Results appear independently as requests finish.
- `/model chatgpt` fetches just ChatGPT's subscription list.
- `/model refresh [provider]` explicitly retries discovery.
- Typing `/model ` fetches in the background. Tab completion uses only received API
  IDs or a clearly labelled saved API response. Failures appear in the popup.
- The panes Model menu fetches the selected provider and displays failures instead
  of substituting invented choices.
- `/login chatgpt` fetches the account's model list after sign-in.

For a reproducible diagnostic without starting a UI or agent:

```bash
npx --no-install stacky --list-models
npx --no-install stacky --list-models --provider chatgpt
```

Output is JSON with the provider, endpoint, source, IDs, last successful fetch time,
and any error. Exit status is **0 only when every requested provider returned a
fresh API response**; missing credentials, redirects, timeouts and stale fallback
return 1. A provider can legitimately return an empty list with status 0.

## Failures and caching

Discovery has a total 12-second deadline and does not follow HTTP redirects. This
prevents credentials from being sent to redirect targets and makes a corporate
network/consent page distinguishable from an API response. HTTP status codes,
redirect hostnames, HTML responses and malformed JSON are surfaced; response
bodies and redirect query tokens are not printed.

For example, `HTTP 307: api.openai.com redirected to gateway.zscloud.net` means no
model JSON was received. The remedy is approved API access through that network's
gateway, not a different model ID or another static catalog. After network access
is authorized, retry `/model refresh`. Do not disable TLS verification.

Only complete, successful API responses enter `~/.config/stacky/models.json`
(`STACKY_MODELS` overrides the location). Entries are scoped to provider credentials
or ChatGPT account plus endpoint/client-version; stored scopes are hashes, not
credentials. Old unscoped caches are ignored. Generic cache reads have a 10-minute
TTL; opening a UI model list or running the CLI diagnostic forces a request.

If refresh fails, a previously received list for the same identity may be shown
as **saved API response — refresh FAILED**, with its timestamp and the actual
failure. With no verified cache, the result is **unavailable**, with **no model
choices**. Empty API responses remain empty. Changing accounts or removing
credentials does not expose another account's cached list.

Tests exercise endpoint URLs, headers, Codex metadata, Anthropic pagination,
redirect/HTML failures, cache identity, completion feedback and CLI errors. Live
provider access is a separate integration check; passing fixture tests does not
mean a network gateway has granted access.
