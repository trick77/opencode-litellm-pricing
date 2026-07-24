// Core types for the opencode-litellm-pricing plugin.
//
// Models the subset of LiteLLM's OpenAI-compatible /v1/models and
// /v1/model/info payloads the plugin needs, including the cost fields used
// to populate opencode's per-model `cost` block.

/**
 * A single model entry returned by LiteLLM's `/v1/models` endpoint.
 * LiteLLM follows the OpenAI-compatible schema; capability/limit fields
 * are LiteLLM-specific extensions that are only reliably present via
 * `/v1/model/info`.
 */
export interface LiteLLMModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  /** LiteLLM-specific: underlying provider (e.g. "openai", "azure"). */
  litellm_provider?: string
  /**
   * LiteLLM `mode` (chat, embedding, image_generation, audio_transcription,
   * audio_speech, rerank, moderation, responses, ...). Omitted by
   * `/v1/models` for database-defined models; present via `/v1/model/info`.
   */
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
}

export interface LiteLLMModelsResponse {
  object: string
  data: LiteLLMModel[]
}

/**
 * The `model_info` block of a `/v1/model/info` entry. Carries `mode`,
 * token limits, capability flags, and — the reason this plugin exists —
 * the resolved per-token cost fields.
 *
 * Cost field names follow LiteLLM's price map
 * (`model_prices_and_context_window.json`). Values are USD **per token**;
 * opencode expects USD **per 1,000,000 tokens**, so the cost mapper scales
 * them by 1e6.
 *
 * NOTE: the exact set of cost keys the proxy surfaces (and whether tiered
 * `*_above_200k_tokens` keys appear) is confirmed against a live
 * `/v1/model/info` response before the cost mapper relies on them.
 */
export interface LiteLLMModelInfo {
  id?: string
  db_model?: boolean
  /** Alias LiteLLM assigns to the model; mirrors the `/v1/models` id. */
  key?: string
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
  /** The real price-map key for Azure/custom deployments (e.g. "azure/gpt-5.4"). */
  base_model?: string
  // --- cost (USD per token) ---
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
  // Tiered pricing above a 200k-token context. LiteLLM also exposes
  // *_above_272k_tokens for some Azure/OpenAI models, but opencode only
  // models a fixed 200k boundary, so we map only the matching 200k tier.
  input_cost_per_token_above_200k_tokens?: number | null
  output_cost_per_token_above_200k_tokens?: number | null
  cache_read_input_token_cost_above_200k_tokens?: number | null
  cache_creation_input_token_cost_above_200k_tokens?: number | null
}

/** A single entry returned by LiteLLM's `/v1/model/info` endpoint. */
export interface LiteLLMModelInfoEntry {
  model_name: string
  litellm_params?: Record<string, unknown>
  model_info?: LiteLLMModelInfo
}

export interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfoEntry[]
}

export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'unknown'

/**
 * A single opencode cost tier. Values are USD per 1M tokens. `input` and
 * `output` are required by opencode's schema; cache fields are optional.
 */
export interface CostTier {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

/**
 * opencode config-level `cost` block (as it appears in
 * `provider.*.models.*.cost` in opencode.json), with optional tiered
 * pricing for contexts over 200k tokens.
 */
export interface CostBlock extends CostTier {
  context_over_200k?: CostTier
}

/** Options accepted on a matched LiteLLM provider's `options` block. */
export interface LiteLLMOptions {
  baseURL?: string
  apiKey?: string
  customHeaders?: Record<string, string>
}
