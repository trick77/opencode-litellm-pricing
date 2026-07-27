// Dev-key fallback source.
//
// LiteLLM's /v1/model/info (which carries cost/limits/capabilities) is
// admin-gated, so a normal developer key can't read it. When that's the
// case we source those fields from opencode's own models.dev-backed catalog
// instead — fetched via the plugin client (no external network, always the
// catalog version opencode itself runs) — matched to the LiteLLM model by
// name.

import type { PluginInput } from '@opencode-ai/plugin'
import type { CostBlock, CostTier } from './types.ts'

type Client = PluginInput['client']

// Providers we match against, in precedence order. These LiteLLM
// deployments are Azure/OpenAI; both carry the full model line in models.dev
// and price it identically, so Azure is preferred with OpenAI as an
// equivalent fallback. Restricting to these two avoids false matches against
// third-party aggregators that use slash-laden ids.
const PREFERRED_PROVIDERS = ['azure', 'openai']

/** The opencode-config fields we can source from a catalog model. */
export interface CatalogFields {
  cost?: CostBlock
  limit?: { context: number; output: number }
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  modalities?: { input: string[]; output: string[] }
}

export interface Catalog {
  /** Resolve a LiteLLM model name to catalog fields, or null if unmatched. */
  resolve(litellmModelName: string): CatalogFields | null
}

interface Candidate {
  id: string // lowercased models.dev id, e.g. "gpt-5.4-mini"
  fields: CatalogFields
}

const CATALOG_TIMEOUT_MS = 2000

let catalogPromise: Promise<Catalog | null> | undefined

/** Load opencode's model catalog once per process (memoized). */
export function getCatalog(client: Client): Promise<Catalog | null> {
  if (!catalogPromise) catalogPromise = load(client)
  return catalogPromise
}

/**
 * Reject after CATALOG_TIMEOUT_MS so a hung client call can't block startup.
 *
 * `client.config.providers()` is served by the same process that is building
 * the config, so calling it from inside the `config` hook is re-entrant: it
 * cannot answer until the hook waiting on it returns. `preloadCatalog` avoids
 * that by warming the cache before the hook runs; this bound means any future
 * re-entrancy costs a second and degrades to "no pricing" instead of stalling.
 */
function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('catalog load timed out')), CATALOG_TIMEOUT_MS)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/** Warm the catalog cache before the config hook runs. Never throws. */
export async function preloadCatalog(client: Client): Promise<void> {
  await getCatalog(client)
}

/** Clear the memoized catalog — used by tests. */
export function resetCatalogCache(): void {
  catalogPromise = undefined
}

async function load(client: Client): Promise<Catalog | null> {
  try {
    const result = (await withTimeout(client.config.providers({}))) as unknown as {
      data?: { providers?: unknown }
      providers?: unknown
    }
    const providers = result?.data?.providers ?? result?.providers
    if (!Array.isArray(providers)) return null
    return buildFromProviders(providers)
  } catch {
    return null
  }
}

/**
 * Build a name resolver from a list of opencode provider objects. Pure and
 * exported for testing.
 */
export function buildFromProviders(providers: unknown[]): Catalog {
  const byId = new Map<string, Record<string, unknown>>()
  for (const p of providers) {
    if (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
      byId.set((p as { id: string }).id, p as Record<string, unknown>)
    }
  }

  // Candidates in provider-precedence order, then sorted longest id first so
  // the first substring match is the most specific (…-mini beats base) and,
  // on a length tie, comes from the preferred provider (stable sort).
  const candidates: Candidate[] = []
  for (const provider of PREFERRED_PROVIDERS) {
    const models = byId.get(provider)?.models
    if (!models || typeof models !== 'object') continue
    for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
      const m = (raw ?? {}) as Record<string, unknown>
      const id = typeof m.id === 'string' ? m.id : key
      candidates.push({ id: id.toLowerCase(), fields: toCatalogFields(m) })
    }
  }
  candidates.sort((a, b) => b.id.length - a.id.length)

  return {
    resolve(litellmModelName: string): CatalogFields | null {
      const norm = litellmModelName.toLowerCase()
      for (const c of candidates) {
        if (isBoundedSubstring(norm, c.id)) return c.fields
      }
      return null
    },
  }
}

/**
 * True if `needle` occurs in `haystack` not flanked by an alphanumeric
 * char, so "gpt-5.4" matches "ai-gateway-gpt-5.4" and "…gpt-5.4-mini" but
 * NOT "…gpt-5.45".
 */
function isBoundedSubstring(haystack: string, needle: string): boolean {
  if (!needle) return false
  let from = 0
  for (;;) {
    const i = haystack.indexOf(needle, from)
    if (i === -1) return false
    const before = i === 0 ? '' : haystack[i - 1]!
    const after = haystack[i + needle.length] ?? ''
    if (!isAlnum(before) && !isAlnum(after)) return true
    from = i + 1
  }
}

function isAlnum(ch: string): boolean {
  return ch !== '' && /[a-z0-9]/.test(ch)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Map an opencode catalog model (models.dev V2 shape) to config fields. */
function toCatalogFields(m: Record<string, unknown>): CatalogFields {
  const fields: CatalogFields = {}

  const cost = toCost(m.cost)
  if (cost) fields.cost = cost

  const limit = m.limit as { context?: unknown; output?: unknown } | undefined
  const context = num(limit?.context)
  const output = num(limit?.output)
  if (context != null && output != null) fields.limit = { context, output }

  const caps = m.capabilities as Record<string, unknown> | undefined
  if (caps?.reasoning === true) fields.reasoning = true
  if (caps?.toolcall === true) fields.tool_call = true
  if (caps?.attachment === true) fields.attachment = true

  const modalities = toModalities(caps?.input as Record<string, unknown> | undefined)
  if (modalities) fields.modalities = modalities

  return fields
}

// models.dev costs (as opencode exposes them) are already USD per 1M tokens,
// so they map straight through — no ×1e6 scaling.
function toCost(raw: unknown): CostBlock | undefined {
  const cost = raw as
    | { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown }; experimentalOver200K?: unknown }
    | undefined
  const input = num(cost?.input)
  const output = num(cost?.output)
  if (input == null || output == null) return undefined

  const block: CostBlock = { input, output }
  const cacheRead = num(cost?.cache?.read)
  const cacheWrite = num(cost?.cache?.write)
  if (cacheRead) block.cache_read = cacheRead
  if (cacheWrite) block.cache_write = cacheWrite

  const over = cost?.experimentalOver200K as
    | { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } }
    | undefined
  const overIn = num(over?.input)
  const overOut = num(over?.output)
  if (overIn != null && overOut != null) {
    const tier: CostTier = { input: overIn, output: overOut }
    const tr = num(over?.cache?.read)
    const tw = num(over?.cache?.write)
    if (tr) tier.cache_read = tr
    if (tw) tier.cache_write = tw
    block.context_over_200k = tier
  }
  return block
}

function toModalities(
  input: Record<string, unknown> | undefined,
): { input: string[]; output: string[] } | undefined {
  if (!input) return undefined
  const mods: string[] = ['text']
  if (input.image === true) mods.push('image')
  if (input.audio === true) mods.push('audio')
  if (input.pdf === true) mods.push('pdf')
  if (input.video === true) mods.push('video')
  if (mods.length <= 1) return undefined
  return { input: mods, output: ['text'] }
}
