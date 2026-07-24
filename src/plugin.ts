// opencode-litellm-pricing
//
// An opencode plugin that discovers models from a LiteLLM proxy at startup
// and injects them into the provider's `models` map — each carrying a real
// per-model `cost` block, so opencode's cost display matches what LiteLLM
// bills.
//
// Cost is sourced with a dual path, auto-detecting the key:
//   • admin/master key → LiteLLM's own /v1/model/info (bill-exact)
//   • developer key (that endpoint is admin-gated) → opencode's models.dev
//     catalog, matched to the model by name (public list prices)
//
// Configure in opencode.json:
//
//   {
//     "plugin": ["opencode-litellm-pricing@latest"],
//     "provider": {
//       "opencode-litellm-pricing": {
//         "npm": "@ai-sdk/openai-compatible",
//         "name": "LiteLLM (proxy)",
//         "options": {
//           "baseURL": "http://localhost:4000/v1",
//           "apiKey": "{env:LITELLM_API_KEY}"
//         }
//       }
//     }
//   }

import type { Config, Plugin, PluginInput } from '@opencode-ai/plugin'
import type { LiteLLMModelInfo } from './types.ts'
import type { CatalogFields } from './catalog.ts'
import {
  autoDetectLiteLLM,
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  normalizeBaseURL,
  resolveApiKey,
} from './litellm-api.ts'
import { applyCatalogFields, configModelFromCatalog, toConfigModel } from './build-config-model.ts'
import { getCatalog } from './catalog.ts'

// Default provider id — kept identical to the npm package name so the
// `plugin` and `provider` keys in opencode.json read the same.
const PROVIDER_ID = 'opencode-litellm-pricing'
// Covers the parallel 15s models/model-info fetch, with headroom.
const DISCOVERY_TIMEOUT_MS = 20000

// Minimal mutable view of the parts of opencode's config we touch. Typing
// the hook parameter as opencode's `Config` (below) and narrowing to this
// gives real type-checking on the config shape — a `config.providers` typo
// no longer compiles — while still allowing loose model-entry objects.
interface MutableProvider {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, Record<string, unknown>>
}
interface MutableConfig {
  provider?: Record<string, MutableProvider>
}

/**
 * opencode invokes the `config` hook several times per run with a
 * cumulative config object. Track which model ids we already injected per
 * baseURL so repeat invocations return early instead of re-querying.
 */
const injectedModelIds = new Map<string, Set<string>>()

/** Does a provider id / options block designate a LiteLLM-backed provider? */
function isLiteLLMProvider(providerId: string, options: Record<string, unknown>): boolean {
  if (providerId === PROVIDER_ID) return true
  if (providerId === 'litellm') return true
  if (providerId.startsWith('litellm-') || providerId.startsWith('litellm_')) return true
  return (
    options.litellm === true ||
    options.litellmCompatible === true ||
    options['litellm-compatible'] === true ||
    options.litellm_compatible === true
  )
}

/** Read a `customHeaders` map off a provider options block. */
function readCustomHeaders(options: Record<string, unknown>): Record<string, string> | undefined {
  const raw = options.customHeaders
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export const LiteLLMPricingPlugin: Plugin = async (input: PluginInput) => {
  return {
    config: async (rawConfig: Config) => {
      const config = rawConfig as unknown as MutableConfig
      if (!config.provider) config.provider = {}
      const providers = config.provider

      // models.dev catalog fields for a model name, loaded lazily & once.
      const resolveCatalog = async (name: string): Promise<CatalogFields | null> => {
        const catalog = await getCatalog(input.client)
        return catalog?.resolve(name) ?? null
      }

      // Collect matching providers; fall back to a default entry for
      // zero-config auto-detection.
      const matched: Array<{ id: string; provider: MutableProvider }> = []
      for (const id of Object.keys(providers)) {
        const provider = providers[id]
        if (provider && typeof provider === 'object') {
          const options = (provider.options ?? {}) as Record<string, unknown>
          if (isLiteLLMProvider(id, options)) matched.push({ id, provider })
        }
      }
      if (matched.length === 0) {
        matched.push({
          id: PROVIDER_ID,
          provider: providers[PROVIDER_ID] ?? {
            npm: '@ai-sdk/openai-compatible',
            name: 'LiteLLM (proxy)',
            options: {},
            models: {},
          },
        })
      }

      for (const { id: providerId, provider } of matched) {
        const options = (provider.options ?? {}) as Record<string, unknown>
        const configuredBase = typeof options.baseURL === 'string' ? options.baseURL : undefined
        const configuredKey =
          typeof options.apiKey === 'string' && options.apiKey ? options.apiKey : undefined
        const apiKey = resolveApiKey(configuredKey)
        const customHeaders = readCustomHeaders(options)

        const baseURL = configuredBase
          ? normalizeBaseURL(configuredBase)
          : await autoDetectLiteLLM(apiKey, customHeaders)

        if (!baseURL) {
          console.warn(
            `[litellm-pricing] No LiteLLM proxy found for provider "${providerId}". Set options.baseURL or start LiteLLM on port 4000/8000/8080.`,
          )
          continue
        }

        // Ensure the provider entry exists and is minimally wired.
        if (!providers[providerId]) providers[providerId] = provider
        const actual = providers[providerId]!
        if (!actual.npm) actual.npm = '@ai-sdk/openai-compatible'
        if (!actual.options) actual.options = { baseURL: `${baseURL}/v1` }
        else if (!(actual.options as Record<string, unknown>).baseURL) {
          ;(actual.options as Record<string, unknown>).baseURL = `${baseURL}/v1`
        }
        if (!actual.models) actual.models = {}
        const models = actual.models

        const work = async () => {
          const already = injectedModelIds.get(baseURL)
          if (already && [...already].every((id) => models[id])) return

          // No standalone health probe: /v1/models below is the same request
          // a probe would make, and its failure already means "offline".
          const [modelsResult, infoResult] = await Promise.allSettled([
            discoverLiteLLMModels(baseURL, apiKey, customHeaders),
            discoverLiteLLMModelInfo(baseURL, apiKey, customHeaders),
          ])

          if (modelsResult.status === 'rejected') {
            const err = modelsResult.reason
            console.warn(
              `[litellm-pricing] Model discovery failed for provider "${providerId}" at ${baseURL}:`,
              err instanceof Error ? err.message : String(err),
            )
            return
          }

          const discovered = modelsResult.value
          // /v1/model/info is admin-gated; a developer key gets null here and
          // the models.dev catalog supplies cost/limits instead.
          const infoByName: Map<string, LiteLLMModelInfo> | null =
            infoResult.status === 'fulfilled' ? infoResult.value : null

          if (discovered.length === 0) {
            console.warn(
              `[litellm-pricing] LiteLLM responded for provider "${providerId}" but exposed zero models.`,
            )
            return
          }

          let added = 0
          let priced = 0
          let viaCatalog = 0
          let skipped = 0
          let wildcards = 0
          for (const model of discovered) {
            // Skip malformed entries rather than throwing out of the hook.
            if (!model || typeof model.id !== 'string') continue
            // Wildcard entries (`deepseek/*`) are access rules, not callable
            // models — invoking one sends a literal `*` upstream.
            if (model.id.includes('*')) {
              wildcards++
              continue
            }
            // Never overwrite user-curated entries.
            if (models[model.id]) continue

            const info = infoByName?.get(model.id)
            let entry: Record<string, unknown> | null
            let filledFromCatalog = false

            if (info) {
              // Admin path: LiteLLM's own resolved data.
              entry = toConfigModel(model, info)
              // Top up anything LiteLLM didn't price/size from the catalog.
              if (entry && (!entry.cost || !entry.limit)) {
                const fields = await resolveCatalog(model.id)
                if (fields) {
                  const hadCost = entry.cost != null
                  applyCatalogFields(entry, fields)
                  if (!hadCost && entry.cost) filledFromCatalog = true
                }
              }
            } else {
              // Developer-key path: name-match against the models.dev catalog.
              const fields = await resolveCatalog(model.id)
              entry = configModelFromCatalog(model, fields)
              if (entry?.cost) filledFromCatalog = true
            }

            if (!entry) {
              skipped++
              continue
            }
            models[model.id] = entry
            added++
            if (entry.cost) priced++
            if (filledFromCatalog) viaCatalog++
          }

          injectedModelIds.set(baseURL, new Set(Object.keys(models)))

          console.log(
            `[litellm-pricing] provider "${providerId}": ${added} model(s) added` +
              ` (${priced} with pricing` +
              (viaCatalog > 0 ? `, ${viaCatalog} via models.dev fallback` : '') +
              (skipped > 0 ? `, ${skipped} non-chat hidden` : '') +
              (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
              `) from ${baseURL}`,
          )
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          work(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, DISCOVERY_TIMEOUT_MS)
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })
      }
    },
  }
}
