<h1>opencode-litellm-pricing</h1>

An [OpenCode](https://opencode.ai) plugin that discovers the models exposed
by a [LiteLLM](https://litellm.ai) proxy at startup and injects them into the
model picker — each with a **real per-model `cost` block** sourced from the
proxy's `/v1/model/info`, so OpenCode's on-screen cost matches what LiteLLM
actually bills.

Most LiteLLM discovery plugins register model names but leave `cost` blank
(OpenCode then shows `$0`). This one fills it in.

## Install

Add the plugin and a LiteLLM provider to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-litellm-pricing@latest"],
  "provider": {
    "opencode-litellm-pricing": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM (proxy)",
      "options": {
        "baseURL": "http://localhost:4000/v1",
        "apiKey": "{env:LITELLM_API_KEY}"
      }
    }
  }
}
```

The proxy key is read from `options.apiKey`, else `$LITELLM_API_KEY` /
`$LITELLM_MASTER_KEY`. With no `baseURL`, the plugin auto-detects a local
proxy on ports 4000 / 8000 / 8080.

## How pricing works

At startup the plugin fetches `/v1/models` and `/v1/model/info`, then for each
chat-capable model injects a config entry including:

```json
{
  "name": "AI Gateway GPT 5.4",
  "limit": { "context": 1050000, "output": 128000 },
  "cost":  { "input": 2.5, "output": 15, "cache_read": 0.25 }
}
```

Cost is read from LiteLLM's resolved per-token fields (`input_cost_per_token`,
`output_cost_per_token`, `cache_read_input_token_cost`) and scaled to
OpenCode's per-1M-token convention (`× 1_000_000`, rounded to 6 decimals). If
the proxy doesn't surface a resolved cost for a model, the `cost` block is
**omitted** rather than shown as a wrong number.

**Tiered pricing:** OpenCode models a single `context_over_200k` tier, so the
plugin maps LiteLLM's `*_above_200k_tokens` fields into it. LiteLLM's
`*_above_272k_tokens` tier (used by some Azure/OpenAI models, e.g. GPT-5.x) is
**not** mapped — forcing a 272k boundary into a 200k bucket would overcharge
the 200k–272k band. Those models stay exact up to 272k on their base rate and
only slightly under-count beyond it.

> For Azure / custom deployments this requires `model_info.base_model` to be
> set on the model in LiteLLM (so the proxy can resolve the price map). Without
> it, LiteLLM itself bills `$0` and there is no cost to surface.

Existing entries you've hand-curated under `provider.*.models` are never
overwritten. Embedding / image / audio models and wildcard (`*`) entries are
skipped.

## Provider matching

The plugin enriches any provider whose id is `opencode-litellm-pricing` (the
default, matching the package name) or `litellm`, starts with `litellm-` /
`litellm_`, or whose `options` sets `litellm: true` (or `litellmCompatible` /
`litellm-compatible`). Extra auth headers (e.g. Cloudflare Access) can be
passed via `options.customHeaders`. With no matching provider at all, it
creates `opencode-litellm-pricing` and auto-detects a local proxy.

## Requirements

- OpenCode with plugin support
- Node 22+
- A reachable LiteLLM proxy

## Releasing

Tag-driven. Bump `version` in `package.json`, then push a matching tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The `release` workflow verifies the tag matches `package.json`, then publishes
to npm via OIDC trusted publishing and cuts a GitHub Release. (Configure the
npm package's trusted publisher and a `npm-publish` GitHub environment first.)

## License

MIT
