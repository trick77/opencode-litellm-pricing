// opencode-litellm-pricing
//
// An opencode plugin that discovers models from a LiteLLM proxy at startup
// and injects them into the provider's `models` map — each carrying a real
// per-model `cost` block sourced from the proxy's /v1/model/info, so
// opencode's cost display matches what LiteLLM actually bills.
//
// Configure in opencode.json:
//
//   {
//     "plugin": ["opencode-litellm-pricing@latest"],
//     "provider": {
//       "litellm": {
//         "npm": "@ai-sdk/openai-compatible",
//         "name": "LiteLLM (proxy)",
//         "options": {
//           "baseURL": "http://localhost:4000/v1",
//           "apiKey": "{env:LITELLM_API_KEY}"
//         }
//       }
//     }
//   }

import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { LiteLLMModel, LiteLLMModelInfo } from './types.ts'
import {
  autoDetectLiteLLM,
  checkLiteLLMHealth,
  discoverLiteLLMModelInfo,
  discoverLiteLLMModels,
  normalizeBaseURL,
} from './litellm-api.ts'
import { toConfigModel } from './build-config-model.ts'

// Default provider id — kept identical to the npm package name so the
// `plugin` and `provider` keys in opencode.json read the same.
const PROVIDER_ID = 'opencode-litellm-pricing'
// Covers the 3s health check plus the parallel 15s models/model-info fetch.
const DISCOVERY_TIMEOUT_MS = 20000

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

/**
 * Overlay /v1/model/info metadata onto a /v1/models entry. Fields already
 * present on the lean entry win; the info block fills gaps — notably `mode`
 * and token limits, which /v1/models omits for database-defined models.
 */
function enrichModel(model: LiteLLMModel, info: LiteLLMModelInfo): LiteLLMModel {
  return {
    ...model,
    mode: model.mode ?? info.mode,
    max_tokens: model.max_tokens ?? info.max_tokens,
    max_input_tokens: model.max_input_tokens ?? info.max_input_tokens,
    max_output_tokens: model.max_output_tokens ?? info.max_output_tokens,
    supports_function_calling: model.supports_function_calling ?? info.supports_function_calling,
    supports_vision: model.supports_vision ?? info.supports_vision,
    supports_reasoning: model.supports_reasoning ?? info.supports_reasoning,
    supports_pdf_input: model.supports_pdf_input ?? info.supports_pdf_input,
    supports_audio_input: model.supports_audio_input ?? info.supports_audio_input,
  }
}

export const LiteLLMPricingPlugin: Plugin = async (_input: PluginInput) => {
  return {
    config: async (config: any) => {
      if (!config.provider) config.provider = {}

      // Collect matching providers; fall back to a default `litellm` entry
      // for zero-config auto-detection.
      const matched: Array<{ id: string; provider: Record<string, unknown> }> = []
      for (const id of Object.keys(config.provider)) {
        const provider = config.provider[id]
        if (provider && typeof provider === 'object') {
          const options = (provider.options ?? {}) as Record<string, unknown>
          if (isLiteLLMProvider(id, options)) matched.push({ id, provider })
        }
      }
      if (matched.length === 0) {
        matched.push({
          id: PROVIDER_ID,
          provider: config.provider[PROVIDER_ID] ?? {
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
        const apiKey = configuredKey ?? process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
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
        if (!config.provider[providerId]) config.provider[providerId] = provider
        const actual = config.provider[providerId] as Record<string, unknown>
        if (!actual.npm) actual.npm = '@ai-sdk/openai-compatible'
        if (!actual.options) actual.options = { baseURL: `${baseURL}/v1` }
        else {
          const opts = actual.options as Record<string, unknown>
          if (!opts.baseURL) opts.baseURL = `${baseURL}/v1`
        }
        if (!actual.models) actual.models = {}
        const models = actual.models as Record<string, unknown>

        const work = async () => {
          const already = injectedModelIds.get(baseURL)
          if (already && [...already].every((id) => models[id])) return

          if (!(await checkLiteLLMHealth(baseURL, apiKey, customHeaders))) {
            console.warn(
              `[litellm-pricing] LiteLLM offline or unauthorized for provider "${providerId}" at ${baseURL}`,
            )
            return
          }

          const [modelsResult, infoResult] = await Promise.allSettled([
            discoverLiteLLMModels(baseURL, apiKey, customHeaders),
            discoverLiteLLMModelInfo(baseURL, apiKey, customHeaders),
          ])

          if (modelsResult.status === 'rejected') {
            const err = modelsResult.reason
            console.warn(
              `[litellm-pricing] Model discovery failed for provider "${providerId}":`,
              err instanceof Error ? err.message : String(err),
            )
            return
          }

          const discovered = modelsResult.value
          const infoByName: Map<string, LiteLLMModelInfo> | null =
            infoResult.status === 'fulfilled' ? infoResult.value : null
          if (infoResult.status === 'rejected') {
            const err = infoResult.reason
            console.warn(
              `[litellm-pricing] /v1/model/info unavailable for provider "${providerId}"; no cost/limits will be attached:`,
              err instanceof Error ? err.message : String(err),
            )
          }

          if (discovered.length === 0) {
            console.warn(
              `[litellm-pricing] LiteLLM responded for provider "${providerId}" but exposed zero models.`,
            )
            return
          }

          let added = 0
          let priced = 0
          let skipped = 0
          let wildcards = 0
          for (const model of discovered) {
            // Wildcard entries (`deepseek/*`) are access rules, not callable
            // models — invoking one sends a literal `*` upstream.
            if (model.id.includes('*')) {
              wildcards++
              continue
            }
            // Never overwrite user-curated entries.
            if (models[model.id]) continue

            const info = infoByName?.get(model.id)
            const entry = toConfigModel(info ? enrichModel(model, info) : model, info)
            if (!entry) {
              skipped++
              continue
            }
            models[model.id] = entry
            added++
            if (entry.cost) priced++
          }

          injectedModelIds.set(baseURL, new Set(Object.keys(models)))

          console.log(
            `[litellm-pricing] provider "${providerId}": ${added} model(s) added` +
              ` (${priced} with pricing` +
              (skipped > 0 ? `, ${skipped} non-chat hidden` : '') +
              (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
              `) from ${baseURL}`,
          )
        }

        await Promise.race([
          work(),
          new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_TIMEOUT_MS)),
        ])
      }
    },
  }
}
