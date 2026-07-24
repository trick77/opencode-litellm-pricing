// Build an opencode config-level model entry (the shape used in
// provider.*.models.* in opencode.json) from a discovered LiteLLM model,
// including the per-model `cost` block — the reason this plugin exists.

import type { CostBlock, CostTier, LiteLLMModel, LiteLLMModelInfo } from './types.ts'
import { categorizeModel, formatModelName } from './format-model-name.ts'

// LiteLLM reports cost as USD per token; opencode expects USD per 1,000,000
// tokens.
const TOKENS_PER_MILLION = 1_000_000

function perMillion(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  // Round to 6 decimals to strip floating-point noise from the ×1e6 scale
  // (e.g. 5e-8 * 1e6 = 0.05000000000000001 -> 0.05) so clean numbers land
  // in the injected config. 6 decimals = sub-cent-per-million precision.
  return Math.round(value * TOKENS_PER_MILLION * 1e6) / 1e6
}

/**
 * Build opencode's `cost` block from LiteLLM's resolved per-token costs.
 *
 * opencode's schema REQUIRES both `input` and `output`. If the proxy did
 * not surface both, we return `undefined` and omit `cost` entirely — a
 * blank price is preferable to a partial or misleading one.
 *
 * Tiered pricing is emitted only for LiteLLM's *_above_200k_tokens keys,
 * which match opencode's fixed `context_over_200k` bucket. LiteLLM's
 * *_above_272k_tokens tier (some Azure/OpenAI models) is deliberately NOT
 * mapped: forcing a 272k tier into a 200k bucket would overcharge the
 * 200k–272k band. Those models stay exact up to 272k on base rates.
 */
export function buildCost(info: LiteLLMModelInfo | undefined): CostBlock | undefined {
  if (!info) return undefined
  const tier = buildTier(
    info.input_cost_per_token,
    info.output_cost_per_token,
    info.cache_read_input_token_cost,
    info.cache_creation_input_token_cost,
  )
  if (!tier) return undefined

  const cost: CostBlock = tier
  const over200k = buildTier(
    info.input_cost_per_token_above_200k_tokens,
    info.output_cost_per_token_above_200k_tokens,
    info.cache_read_input_token_cost_above_200k_tokens,
    info.cache_creation_input_token_cost_above_200k_tokens,
  )
  if (over200k) cost.context_over_200k = over200k
  return cost
}

/** Build a single cost tier, or `undefined` if input/output aren't both set. */
function buildTier(
  inputPerToken: number | null | undefined,
  outputPerToken: number | null | undefined,
  cacheReadPerToken: number | null | undefined,
  cacheWritePerToken: number | null | undefined,
): CostTier | undefined {
  const input = perMillion(inputPerToken)
  const output = perMillion(outputPerToken)
  if (input == null || output == null) return undefined

  const tier: CostTier = { input, output }
  const cacheRead = perMillion(cacheReadPerToken)
  const cacheWrite = perMillion(cacheWritePerToken)
  if (cacheRead != null) tier.cache_read = cacheRead
  if (cacheWrite != null) tier.cache_write = cacheWrite
  return tier
}

/**
 * Convert a discovered LiteLLM model into an opencode config model entry.
 * Returns `null` for non-chat models (embedding, image, audio) so they
 * don't clutter the picker.
 *
 * `info` supplies the cost block; capability/limit fields are read off
 * `model` (the caller merges `info` into `model` before calling this).
 */
export function toConfigModel(
  model: LiteLLMModel,
  info: LiteLLMModelInfo | undefined,
): Record<string, unknown> | null {
  const type = categorizeModel(model)
  if (type === 'embedding' || type === 'image' || type === 'audio') return null

  const entry: Record<string, unknown> = { name: formatModelName(model) }

  if (model.max_input_tokens || model.max_output_tokens) {
    entry.limit = {
      context: model.max_input_tokens ?? 0,
      output: model.max_output_tokens ?? 0,
    }
  }

  const cost = buildCost(info)
  if (cost) entry.cost = cost

  if (model.supports_function_calling) entry.tool_call = true
  if (model.supports_reasoning) entry.reasoning = true
  if (model.supports_vision) entry.attachment = true

  const input: Array<'text' | 'image' | 'pdf' | 'audio'> = ['text']
  if (model.supports_vision) input.push('image')
  if (model.supports_pdf_input) input.push('pdf')
  if (model.supports_audio_input) input.push('audio')
  if (input.length > 1) entry.modalities = { input, output: ['text'] }

  return entry
}
