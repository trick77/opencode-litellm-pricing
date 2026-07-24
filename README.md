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

At startup the plugin lists the proxy's models (`/v1/models`) and injects each
chat-capable one into the picker with a config entry like:

```json
{
  "name": "AI Gateway GPT 5.4",
  "limit": { "context": 1050000, "output": 128000 },
  "cost":  { "input": 2.5, "output": 15, "cache_read": 0.25 }
}
```

Cost is sourced with a **dual path**, auto-detected from the key opencode uses:

**1. Admin / master key → LiteLLM's own numbers (bill-exact).** The plugin reads
`/v1/model/info` and uses LiteLLM's resolved per-token fields
(`input_cost_per_token`, …), scaled to opencode's per-1M convention
(`× 1_000_000`, rounded). This matches your LiteLLM spend dashboard exactly. For
Azure / custom deployments it requires `model_info.base_model` set on the model
(so LiteLLM can resolve the price map — otherwise LiteLLM itself bills `$0`).

**2. Developer key → models.dev fallback (public list prices).** `/v1/model/info`
is **admin-gated in LiteLLM**, so a normal developer key can't read cost, limits,
or capabilities from the proxy. In that case the plugin sources them from
opencode's own **models.dev catalog** (via the plugin client — no external
fetch), matching each LiteLLM model to a catalog entry by name: e.g.
`ai-gateway-gpt-5.4` → `gpt-5.4` (longest-match, so `…-mini` beats the base,
`azure` preferred over `openai`). These are public list prices, not your
negotiated rates.

So an admin gets exact numbers; developers get correct public pricing with no
admin key on their machines.

**Tiered pricing:** opencode models a single `context_over_200k` tier. The
LiteLLM path maps `*_above_200k_tokens` into it (LiteLLM's `*_above_272k_tokens`
tier is **not** mapped — forcing 272k into a 200k bucket would overcharge the
200k–272k band); the models.dev path maps `experimentalOver200K`.

If neither path yields a cost, the `cost` block is **omitted** rather than shown
wrong. Existing entries you've hand-curated under `provider.*.models` are never
overwritten. Embedding / image / audio / rerank / moderation models and wildcard
(`*`) entries are skipped.

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
