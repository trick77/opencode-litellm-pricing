// LiteLLM proxy HTTP client: health check, model discovery, and per-model
// metadata (including cost) from /v1/model/info. The model-info reader
// carries cost fields through and falls back to litellm_params for
// cost/capability keys set there.

import type {
  LiteLLMModel,
  LiteLLMModelInfo,
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

function buildHeaders(
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = apiKey ?? process.env.LITELLM_API_KEY ?? process.env.LITELLM_MASTER_KEY
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

  for (const entry of data.data ?? []) {
    if (!entry.model_info) continue
    // Spread preserves cost fields verbatim. Some deployments set cost and
    // capability flags on litellm_params rather than inside model_info, so
    // fill any gaps from there.
    const info: LiteLLMModelInfo = { ...entry.model_info }
    const params = entry.litellm_params ?? {}

    for (const flag of CAPABILITY_FLAGS) {
      const v = params[flag]
      if (info[flag] == null && typeof v === 'boolean') info[flag] = v
    }
    for (const numKey of NUMERIC_INFO_KEYS) {
      const v = params[numKey]
      if (info[numKey] == null && typeof v === 'number') info[numKey] = v
    }

    const keys = [
      entry.model_name,
      entry.model_info.key,
      typeof entry.litellm_params?.model === 'string' ? entry.litellm_params.model : undefined,
    ]
    for (const key of keys) {
      if (key && !infoByName.has(key)) infoByName.set(key, info)
    }
  }
  return infoByName
}

/**
 * Try the common ports a LiteLLM proxy is started on. Default is 4000;
 * 8000 and 8080 are also widely used.
 */
export async function autoDetectLiteLLM(
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<string | null> {
  for (const port of [4000, 8000, 8080]) {
    const baseURL = `http://localhost:${port}`
    if (await checkLiteLLMHealth(baseURL, apiKey, customHeaders)) return baseURL
  }
  return null
}
