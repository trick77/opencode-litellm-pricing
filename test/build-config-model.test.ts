import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCost, toConfigModel } from '../src/build-config-model.ts'
import type { LiteLLMModel, LiteLLMModelInfo } from '../src/types.ts'

// Values below are taken verbatim from a real LiteLLM /v1/model/info
// response (USD per token) to lock the per-token -> per-1M conversion.

test('gpt-5.4: base cost converts to per-1M, no 200k tier (it tiers at 272k)', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 2.5e-7,
    cache_creation_input_token_cost: null,
    // present in the real payload, but at the 272k boundary — must be ignored
    input_cost_per_token_above_272k_tokens: 5e-6,
    output_cost_per_token_above_272k_tokens: 2.25e-5,
    input_cost_per_token_above_200k_tokens: null,
    output_cost_per_token_above_200k_tokens: null,
  } as LiteLLMModelInfo
  assert.deepEqual(buildCost(info), { input: 2.5, output: 15, cache_read: 0.25 })
})

test('gpt-5.4-mini: sub-dollar rates convert exactly', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 7.5e-8,
  }
  assert.deepEqual(buildCost(info), { input: 0.75, output: 4.5, cache_read: 0.075 })
})

test('gpt-5-nano: tiny rates convert without float noise beyond expectation', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 5e-8,
    output_cost_per_token: 4e-7,
    cache_read_input_token_cost: 5e-9,
  }
  const cost = buildCost(info)!
  assert.equal(cost.input, 0.05)
  assert.equal(cost.output, 0.4)
  assert.equal(cost.cache_read, 0.005)
})

test('genuine 200k-boundary model emits context_over_200k', () => {
  const info: LiteLLMModelInfo = {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    input_cost_per_token_above_200k_tokens: 6e-6,
    output_cost_per_token_above_200k_tokens: 2.25e-5,
  }
  assert.deepEqual(buildCost(info), {
    input: 3,
    output: 15,
    context_over_200k: { input: 6, output: 22.5 },
  })
})

test('cost omitted when output is 0 (e.g. embeddings) or missing', () => {
  assert.equal(buildCost({ input_cost_per_token: 2e-8, output_cost_per_token: 0 }), undefined)
  assert.equal(buildCost({ input_cost_per_token: 2e-8 }), undefined)
  assert.equal(buildCost(undefined), undefined)
})

test('embedding-mode models are filtered out of the picker', () => {
  const model = { id: 'ai-gateway-text-embedding-3-small', object: 'model', mode: 'embedding' } as LiteLLMModel
  assert.equal(toConfigModel(model, { input_cost_per_token: 2e-8, output_cost_per_token: 0 }), null)
})

test('chat model carries name, limit, cost, and capability flags', () => {
  const model: LiteLLMModel = {
    id: 'ai-gateway-gpt-5.4',
    object: 'model',
    mode: 'chat',
    max_input_tokens: 1050000,
    max_output_tokens: 128000,
    supports_function_calling: true,
    supports_reasoning: true,
    supports_vision: true,
  }
  const entry = toConfigModel(model, {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 2.5e-7,
  })!
  assert.equal(entry.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
  assert.equal(entry.tool_call, true)
  assert.equal(entry.reasoning, true)
  assert.equal(entry.attachment, true)
})
