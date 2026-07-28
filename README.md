<h1>opencode-litellm-pricing</h1>

An [OpenCode](https://opencode.ai) plugin that discovers the models exposed
by a [LiteLLM](https://litellm.ai) proxy at startup and injects them into the
model picker — each with a **real per-model `cost` block**, so OpenCode shows
real pricing instead of `$0`.

The proxy is asked only for its **model list**. Pricing is never requested from
it: each model is matched by **name** against OpenCode's own models.dev catalog,
so `ai-gateway-gpt-5.4` is priced as `gpt-5.4`. Same answer for every key, one
code path. See [How pricing works](#how-pricing-works).

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
        "baseURL": "https://litellm.example.com/v1",
        "apiKey": "{env:LITELLM_API_KEY}"
      }
    }
  }
}
```

`options.baseURL` is **required** — the plugin talks to that URL and nothing
else. A provider without one is skipped with a warning. The proxy key is read
from `options.apiKey`, else `$LITELLM_API_KEY` / `$LITELLM_MASTER_KEY`.

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

Cost, limits and capabilities come from **OpenCode's own models.dev catalog**
(via the plugin client — no external fetch), matched to each LiteLLM model by
name: `ai-gateway-gpt-5.4` → `gpt-5.4`, longest-match so `…-mini` beats the
base, `azure` preferred over `openai`. These are public list prices, not your
negotiated rates.

**Why not read LiteLLM's own numbers?** `/v1/model/info` carries them, but its
figures are only correct when the deployment has `model_info.base_model` set
properly. Get that wrong and LiteLLM itself bills `$0`, which the plugin would
faithfully pass on. Name-matching is the same answer for every key, and it can't
silently report zero.

**Tiered pricing:** opencode models a single `context_over_200k` tier, mapped
from the catalog's `experimentalOver200K`.

If no catalog match is found, the `cost` block is **omitted** rather than shown
wrong. Existing entries you've hand-curated under `provider.*.models` are never
overwritten. Wildcard (`*`) entries are skipped — they are access rules, not
callable models.

## Non-chat models

Embedding, image, audio, rerank and moderation models are filtered out of the
picker.

`/v1/models` says which models your key can see, but not what kind each one is
— its response is just `{id, object, created, owned_by}`. LiteLLM keeps that in
a `mode` field, so the plugin also reads `/model_group/info`, which returns
`mode` plus the capability flags keyed by the same id. Anything whose mode
isn't `chat` / `completion` / `responses` is left out, and the limits and
capability flags it reports fill in what models.dev doesn't cover.

That call is best-effort, with a 3-second budget. If your proxy doesn't allow
it, discovery carries on and models are classified by **name** instead —
`*-embedding-*`, `*rerank*`, `dall-e-*` and so on. The startup log tells you
which path ran. The name patterns are deliberately narrow, because a false
positive hides a model you can actually use: `amazon.nova-pro-v1` and
`gpt-4o-audio-preview` stay in the picker. The cost of that caution is that an
oddly-named non-chat model can slip through when the name is all we have.

## Provider matching

The plugin enriches any provider whose id is `opencode-litellm-pricing` (the
default, matching the package name) or `litellm`, starts with `litellm-` /
`litellm_`, or whose `options` sets `litellm: true` (or `litellmCompatible` /
`litellm-compatible`). Extra auth headers (e.g. Cloudflare Access) can be
passed via `options.customHeaders`. With no matching provider in your config,
the plugin does nothing.

## Requirements

- OpenCode with plugin support
- Node 22+
- A reachable LiteLLM proxy

## Releasing

Tag-driven. Bump `version` in `package.json`, then push a matching tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The `release` workflow verifies the tag matches `package.json`, then publishes
to npm via OIDC trusted publishing and cuts a GitHub Release.

Prerequisites, one-time: an `npm-publish` GitHub environment, and a trusted
publisher on the npm package pointing at owner `trick77`, repo
`opencode-litellm-pricing`, workflow `release.yaml`, environment
`npm-publish`. All four must match exactly or the publish fails with a
misleading 404.

No npm token is involved — authentication is OIDC, which is also what
`--provenance` signs with. Note that trusted publishing cannot create a package
that does not exist yet, which is why 0.1.0 was published by hand and carries no
provenance attestation; every tagged release from 0.1.1 on does.

## License

MIT
