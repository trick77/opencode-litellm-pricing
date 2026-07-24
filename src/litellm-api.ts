// LiteLLM proxy HTTP client: health check, model discovery, and per-model
// metadata (including cost) from /v1/model/info. The model-info reader
// carries cost fields through and falls back to litellm_params for
// cost/capability keys set there.

import type {
  LiteLLMModel,
  LiteLLMModelInfo,
  LiteLLMModelInfoEntry,
  LiteLLMModelInfoResponse,
  LiteLLMModelsResponse,
} from './types.ts'

export const DEFAULT_LITELLM_URL = 'http://localhost:4000'
const MODELS_ENDPOINT = '/v1/models'
const MODEL_INFO_ENDPOINT = '/v1/model/info'
const HEALTH_TIMEOUT_MS = 3000
const FETCH_TIMEOUT_MS = 15000

/** Numeric keys we also accept off `litellm_params` when absent in model_info. */
const NUMERIC_INFO_KEYS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'input_cost_per_token_above_200k_tokens',
  'output_cost_per_token_above_200k_tokens',
  'cache_read_input_token_cost_above_200k_tokens',
  'cache_creation_input_token_cost_above_200k_tokens',
  'max_tokens',
  'max_input_tokens',
  'max_output_tokens',
] as const

/** Boolean capability keys that some deployments set on `litellm_params`. */
const CAPABILITY_FLAGS = [
  'supports_vision',
  'supports_function_calling',
  'supports_reasoning',
  'supports_pdf_input',
  'supports_audio_input',
] as const

/**
 * Normalise a base URL so the rest of the plugin can rely on a predictable
 * shape (no trailing slash, no `/v1` suffix).
 */
export function normalizeBaseURL(baseURL: string = DEFAULT_LITELLM_URL): string {
  let normalized = baseURL.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

/** Build a full URL for a given API endpoint. */
export function buildAPIURL(baseURL: string, endpoint: string = MODELS_ENDPOINT): string {
  return `${normalizeBaseURL(baseURL)}${endpoint}`
}

/**
 * Resolve the API key: an explicit value wins, else the LiteLLM env vars.
 * Single source of precedence, used by both the header builder and the
 * plugin's discovery call.
 */
export function resolveApiKey(explicit?: string): string | undefined {
  return explicit ?? process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
}

function buildHeaders(
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = resolveApiKey(apiKey)
  if (key) headers['Authorization'] = `Bearer ${key}`
  if (customHeaders) Object.assign(headers, customHeaders)
  return headers
}

/** Lightweight ping to see whether a LiteLLM server is reachable. */
export async function checkLiteLLMHealth(
  baseURL: string = DEFAULT_LITELLM_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<boolean> {
  try {
    const response = await fetch(buildAPIURL(baseURL), {
      method: 'GET',
      headers: buildHeaders(apiKey, customHeaders),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    // A 401 means the server is alive but our credentials are wrong — treat
    // that as unhealthy so the user is prompted to set LITELLM_API_KEY.
    return response.ok
  } catch {
    return false
  }
}

/** Discover all models exposed by a LiteLLM proxy via /v1/models. */
export async function discoverLiteLLMModels(
  baseURL: string = DEFAULT_LITELLM_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<LiteLLMModel[]> {
  const response = await fetch(buildAPIURL(baseURL), {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`LiteLLM responded with HTTP ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as LiteLLMModelsResponse
  return data.data ?? []
}

/**
 * Fetch per-model metadata (mode, token limits, capability flags, and cost)
 * from /v1/model/info, keyed by every alias LiteLLM may use for a model so
 * the `/v1/models` id reliably matches.
 */
export async function discoverLiteLLMModelInfo(
  baseURL: string = DEFAULT_LITELLM_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<Map<string, LiteLLMModelInfo>> {
  const response = await fetch(buildAPIURL(baseURL, MODEL_INFO_ENDPOINT), {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`LiteLLM responded with HTTP ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as LiteLLMModelInfoResponse
  const infoByName = new Map<string, LiteLLMModelInfo>()

  // Build each entry's info once, filling cost/capability gaps from
  // litellm_params (some deployments declare them there, not in model_info).
  const built: Array<{ entry: LiteLLMModelInfoEntry; info: LiteLLMModelInfo }> = []
  for (const entry of data.data ?? []) {
    if (!entry.model_info) continue
    const info: LiteLLMModelInfo = { ...entry.model_info } // spread preserves cost verbatim
    const params = entry.litellm_params ?? {}
    for (const flag of CAPABILITY_FLAGS) {
      const v = params[flag]
      if (info[flag] == null && typeof v === 'boolean') info[flag] = v
    }
    for (const numKey of NUMERIC_INFO_KEYS) {
      const v = params[numKey]
      if (info[numKey] == null && typeof v === 'number') info[numKey] = v
    }
    built.push({ entry, info })
  }

  // Pass 1: register the public model_name (what /v1/models reports) so a
  // public name always wins. Pass 2: register internal aliases
  // (model_info.key, litellm_params.model) only if unclaimed — an earlier
  // entry's alias must never shadow a later model's own public name.
  for (const { entry, info } of built) {
    if (entry.model_name && !infoByName.has(entry.model_name)) {
      infoByName.set(entry.model_name, info)
    }
  }
  for (const { entry, info } of built) {
    const aliases = [
      entry.model_info?.key,
      typeof entry.litellm_params?.model === 'string' ? entry.litellm_params.model : undefined,
    ]
    for (const alias of aliases) {
      if (alias && !infoByName.has(alias)) infoByName.set(alias, info)
    }
  }
  return infoByName
}

/**
 * Confirm a server is actually LiteLLM, not just any OpenAI-compatible
 * server (vLLM, LM Studio, …) that answers /v1/models. `/v1/model/info` is
 * LiteLLM-specific: a non-LiteLLM server 404s it, while LiteLLM returns 200
 * or an auth error (401/403) — anything other than 404 marks it as LiteLLM.
 */
async function looksLikeLiteLLM(
  baseURL: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<boolean> {
  try {
    const response = await fetch(buildAPIURL(baseURL, MODEL_INFO_ENDPOINT), {
      method: 'GET',
      headers: buildHeaders(apiKey, customHeaders),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    return response.status !== 404
  } catch {
    return false
  }
}

/**
 * Try the common ports a LiteLLM proxy is started on (4000 default; 8000 /
 * 8080 also common), concurrently, and return the first that is both
 * reachable and identifiably LiteLLM. Concurrency keeps a blackholed port
 * from serially stalling startup; the LiteLLM marker keeps a stray
 * OpenAI-compatible server from binding as a phantom provider.
 */
export async function autoDetectLiteLLM(
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<string | null> {
  const probes = [4000, 8000, 8080].map((port) => {
    const baseURL = `http://localhost:${port}`
    return (async () => {
      const healthy = await checkLiteLLMHealth(baseURL, apiKey, customHeaders)
      if (healthy && (await looksLikeLiteLLM(baseURL, apiKey, customHeaders))) return baseURL
      throw new Error(`not LiteLLM at ${baseURL}`)
    })()
  })
  try {
    return await Promise.any(probes)
  } catch {
    return null
  }
}
