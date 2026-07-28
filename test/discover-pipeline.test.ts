import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverLiteLLMModelGroups, discoverLiteLLMModelInfo } from '../src/litellm-api.ts'
import {
  configModelFromCatalog,
  enrichModel,
  groupInfoToModelInfo,
  toConfigModel,
} from '../src/build-config-model.ts'
import type { LiteLLMModel, LiteLLMModelGroupInfo } from '../src/types.ts'

// A trimmed but faithful slice of a real /v1/model/info response, exercising
// the plumbing the unit tests skip: alias-keying, litellm_params fallback,
// cost passthrough, and embedding filtering.
const MODEL_INFO_FIXTURE = {
  data: [
    {
      model_name: 'ai-gateway-gpt-5.4',
      litellm_params: { custom_llm_provider: 'azure', model: 'azure/ai-gateway-gpt-5.4' },
      model_info: {
        key: 'azure/gpt-5.4',
        base_model: 'azure/gpt-5.4',
        mode: 'chat',
        max_input_tokens: 1050000,
        max_output_tokens: 128000,
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 1.5e-5,
        cache_read_input_token_cost: 2.5e-7,
        // 272k tier present in real data — must NOT map into context_over_200k
        input_cost_per_token_above_272k_tokens: 5e-6,
        output_cost_per_token_above_272k_tokens: 2.25e-5,
        input_cost_per_token_above_200k_tokens: null,
        supports_function_calling: true,
        supports_reasoning: true,
        supports_vision: true,
      },
    },
    {
      model_name: 'ai-gateway-text-embedding-3-small',
      litellm_params: { custom_llm_provider: 'azure', model: 'azure/ai-gateway-text-embedding-3-small' },
      model_info: { mode: 'embedding', input_cost_per_token: 2e-8, output_cost_per_token: 0 },
    },
    {
      // cost declared on litellm_params, not model_info — exercises the fallback
      model_name: 'param-priced-model',
      litellm_params: {
        custom_llm_provider: 'openai',
        model: 'gpt-x',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
      model_info: { mode: 'chat' },
    },
  ],
}

// Shaped after LiteLLM's documented /v1/model_group/info response: keyed by
// model_group (the same string /v1/models reports as an id), carrying `mode`
// and the capability flags, and no cost fields.
const MODEL_GROUP_FIXTURE = {
  data: [
    {
      model_group: 'ai-gateway-gpt-5.4',
      providers: ['azure'],
      max_input_tokens: 1050000,
      max_output_tokens: 128000,
      mode: 'chat',
      supports_function_calling: true,
      supports_reasoning: true,
      supports_vision: true,
    },
    { model_group: 'text-embedding-3-large', providers: ['openai'], mode: 'embedding' },
    { model_group: 'acme-ranker', providers: ['cohere'], mode: 'rerank' },
    { model_group: 'acme-painter', providers: ['openai'], mode: 'image_generation' },
    // LiteLLM emits mode: null for models with no price-map entry.
    { model_group: 'llava-hf', providers: ['openai'], mode: null },
  ],
}

function mockFetchOnce(payload: unknown) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, statusText: 'OK', json: async () => payload })) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function mockFetchStatus(status: number, statusText: string) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    ({ ok: false, status, statusText, json: async () => ({}) })) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

/** The live path: enrich with group info where present, then build the entry. */
function inject(
  model: LiteLLMModel,
  groups: Map<string, LiteLLMModelGroupInfo> | null,
): Record<string, unknown> | null {
  const group = groups?.get(model.id)
  const enriched = group ? enrichModel(model, groupInfoToModelInfo(group)) : model
  return configModelFromCatalog(enriched, null)
}

test('model groups key by model_group — the same id /v1/models reports', async () => {
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    assert.equal(groups.size, 5)
    assert.equal(groups.get('ai-gateway-gpt-5.4')?.mode, 'chat')
    assert.equal(groups.get('acme-ranker')?.mode, 'rerank')
  } finally {
    restore()
  }
})

test('group mode filters non-chat models that no name heuristic would catch', async () => {
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    // None of these ids look non-chat; only LiteLLM's own `mode` reveals them.
    for (const id of ['acme-ranker', 'acme-painter', 'text-embedding-3-large']) {
      assert.equal(inject({ id, object: 'model' }, groups), null, id)
    }
  } finally {
    restore()
  }
})

test('group info supplies limits and capabilities to the injected entry', async () => {
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    const entry = inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, groups)!
    assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
    assert.equal(entry.tool_call, true)
    assert.equal(entry.reasoning, true)
    assert.equal(entry.attachment, true)
    // Cost never comes from the proxy — the group endpoint carries none.
    assert.equal(entry.cost, undefined)
  } finally {
    restore()
  }
})

test('mode null falls back to the name heuristic rather than hiding the model', async () => {
  const restore = mockFetchOnce(MODEL_GROUP_FIXTURE)
  try {
    const groups = await discoverLiteLLMModelGroups('http://proxy')
    // Present in the map, but with mode: null — that means "no signal", not
    // "not a chat model". A deny-list would have dropped it.
    const entry = inject({ id: 'llava-hf', object: 'model' }, groups)
    assert.notEqual(entry, null)
    assert.equal(entry!.name, 'Llava HF')
  } finally {
    restore()
  }
})

test('a refused /v1/model_group/info falls open — models still inject, by name', async () => {
  const restore = mockFetchStatus(403, 'Forbidden')
  try {
    await assert.rejects(discoverLiteLLMModelGroups('http://proxy'), /403/)
  } finally {
    restore()
  }
  // With groups = null the pipeline classifies by id: chat stays, embedding goes.
  assert.notEqual(inject({ id: 'ai-gateway-gpt-5.4', object: 'model' }, null), null)
  assert.equal(inject({ id: 'text-embedding-3-large', object: 'model' }, null), null)
  // ...and the reranker no name heuristic would catch is the cost of falling open.
  assert.notEqual(inject({ id: 'acme-ranker', object: 'model' }, null), null)
})

test('discoverLiteLLMModelInfo keys by every alias', async () => {
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE)
  try {
    const map = await discoverLiteLLMModelInfo('http://proxy')
    // model_name, model_info.key, and litellm_params.model all resolve
    assert.ok(map.get('ai-gateway-gpt-5.4'))
    assert.ok(map.get('azure/gpt-5.4'))
    assert.ok(map.get('azure/ai-gateway-gpt-5.4'))
  } finally {
    restore()
  }
})

test('pipeline: chat model injected with real cost, no 200k tier', async () => {
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE)
  try {
    const map = await discoverLiteLLMModelInfo('http://proxy')
    const info = map.get('ai-gateway-gpt-5.4')
    // toConfigModel merges info onto the bare /v1/models entry itself
    // (single code path — the real one exercised in production).
    const model: LiteLLMModel = { id: 'ai-gateway-gpt-5.4', object: 'model' }
    const entry = toConfigModel(model, info)!
    assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
    assert.equal((entry.cost as Record<string, unknown>).context_over_200k, undefined)
    assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  } finally {
    restore()
  }
})

test('pipeline: embedding model is filtered out', async () => {
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE)
  try {
    const map = await discoverLiteLLMModelInfo('http://proxy')
    const info = map.get('ai-gateway-text-embedding-3-small')
    const model = { id: 'ai-gateway-text-embedding-3-small', object: 'model', mode: 'embedding' } as LiteLLMModel
    assert.equal(toConfigModel(model, info), null)
  } finally {
    restore()
  }
})

test('pipeline: cost on litellm_params is picked up via fallback', async () => {
  const restore = mockFetchOnce(MODEL_INFO_FIXTURE)
  try {
    const map = await discoverLiteLLMModelInfo('http://proxy')
    const info = map.get('param-priced-model')
    assert.equal(info?.input_cost_per_token, 1e-6)
    const model = { id: 'param-priced-model', object: 'model', mode: 'chat' } as LiteLLMModel
    const entry = toConfigModel(model, info)!
    assert.deepEqual(entry.cost, { input: 1, output: 2 })
  } finally {
    restore()
  }
})
