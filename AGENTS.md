# AGENTS.md

OpenCode plugin that injects per-model **cost** for LiteLLM proxy models.

## Build / test

- `npm run build` → `tsc --noEmit` (typecheck only; no `dist`).
- `npm test` → typecheck + `node --test test/*.test.ts`. Node 22+.
- Ships raw TS: `main` is `src/index.ts` (OpenCode/bun runs it). Every relative
  import MUST carry a `.ts` extension (`./types.ts`) — enabled by
  `allowImportingTsExtensions`. Extensionless imports break the node test runner.

## Cost mapping — load-bearing rules

- OpenCode config `cost` is FLAT and closed:
  `{ input, output, cache_read, cache_write, context_over_200k }`,
  `additionalProperties:false`. NEVER emit a nested `cache` object — the schema
  rejects it and the whole `cost` is dropped. Values are USD per 1M tokens.
- Two sources, by key:
  - **Admin/master key** → LiteLLM `/v1/model/info`. Cost is per-TOKEN → ×1e6
    (`perMillion`), round 6dp.
  - **Dev key** (`/v1/model/info` is admin-gated → 403) → models.dev catalog via
    `input.client.config.providers()`. Those costs are ALREADY per-1M — copy
    straight through, do NOT ×1e6.
- Emit `cost` only when both `input` and `output` are known. Keep a real `0`
  (free tier); drop only absent values.
- Tiering: map LiteLLM `*_above_200k_tokens` → `context_over_200k`. Do NOT map
  `*_above_272k_tokens` (would overcharge the 200k–272k band). models.dev path
  maps `experimentalOver200K`.

## LiteLLM field semantics

- `max_input_tokens` = context window. `max_tokens` = legacy alias of max
  OUTPUT, not context. Never use `max_tokens` for `limit.context`.
- Azure / custom deployments need `model_info.base_model` set, else LiteLLM
  bills $0 and there is no cost to surface.

## Discovery rules

- Never overwrite a user-curated `provider.*.models` entry.
- Fail soft: warn and continue; never throw out of the `config` hook. Skip
  malformed entries and wildcard (`*`) ids.
- models.dev name match: longest-match, boundary-anchored, providers `azure`
  then `openai` only.

## Release

- Tag-driven. Bump `version` in `package.json`, push `vX.Y.Z` (must match). CI
  publishes to npm via OIDC trusted publishing. Do not `npm publish` by hand.
