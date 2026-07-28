import { test } from 'node:test'
import assert from 'node:assert/strict'
import { categorizeModel, formatModelName } from '../src/format-model-name.ts'
import type { LiteLLMModel, ModelType } from '../src/types.ts'

/** Build a bare /v1/models-shaped entry (no `mode`, as the real endpoint sends). */
function m(id: string, mode?: string | null): LiteLLMModel {
  return { id, object: 'model', ...(mode === undefined ? {} : { mode: mode ?? undefined }) }
}

// --- mode: the authoritative signal -----------------------------------------

test('chat modes are the allow-list', () => {
  for (const mode of ['chat', 'completion', 'responses', 'CHAT']) {
    assert.equal(categorizeModel(m('anything', mode)), 'chat', mode)
  }
})

test('known non-chat modes classify by kind', () => {
  const cases: Array<[string, ModelType]> = [
    ['embedding', 'embedding'],
    ['image_generation', 'image'],
    ['audio_transcription', 'audio'],
    ['audio_speech', 'audio'],
  ]
  for (const [mode, expected] of cases) {
    assert.equal(categorizeModel(m('anything', mode)), expected, mode)
  }
})

test('rerank, moderation and search are non-chat', () => {
  for (const mode of ['rerank', 'moderation', 'search']) {
    assert.equal(categorizeModel(m('anything', mode)), 'unknown', mode)
  }
})

test('an unrecognised mode is non-chat, not silently passed to the heuristics', () => {
  // The old deny-list fell through here, so `image_edit` on a plainly-named
  // model was injected as chat.
  assert.equal(categorizeModel(m('acme-renderer', 'image_edit')), 'unknown')
  assert.equal(categorizeModel(m('acme-thing', 'embed')), 'unknown')
})

test('mode null or absent falls through to the id heuristics', () => {
  // LiteLLM emits mode: null for models it has no price-map entry for; that
  // means "no signal", NOT "not a chat model".
  assert.equal(categorizeModel(m('my-local-llama', null)), 'chat')
  assert.equal(categorizeModel(m('my-local-llama')), 'chat')
  // ...and the heuristics still apply to a null-mode non-chat model.
  assert.equal(categorizeModel(m('bge-reranker-v2-m3', null)), 'unknown')
})

// --- id heuristics: the fallback --------------------------------------------

test('rerank and moderation models are caught by id', () => {
  for (const id of ['rerank-v3.5', 'cohere/rerank-multilingual-v3.0', 'bge-reranker-v2-m3']) {
    assert.equal(categorizeModel(m(id)), 'unknown', id)
  }
  for (const id of ['text-moderation-latest', 'omni-moderation-latest']) {
    assert.equal(categorizeModel(m(id)), 'unknown', id)
  }
})

test('embedding models are caught by id, including vendor-named ones', () => {
  for (const id of [
    'text-embedding-3-small',
    'azure/embed-english-v3',
    'voyage-3',
    'voyage-code-3',
    'bge-m3',
    'jina-embeddings-v3',
    'jina-clip-v2',
  ]) {
    assert.equal(categorizeModel(m(id)), 'embedding', id)
  }
})

test('audio models are caught by id, including speech vendors', () => {
  for (const id of [
    'whisper-1',
    'azure/tts-hd',
    'elevenlabs/eleven-v3',
    'cartesia/sonic-2',
    'deepgram/nova-3',
  ]) {
    assert.equal(categorizeModel(m(id)), 'audio', id)
  }
})

test('image models are caught by id, including modern names', () => {
  for (const id of [
    'dall-e-3',
    'stable-diffusion-xl',
    'gpt-image-1',
    'imagen-3.0-generate-002',
    'xai/grok-2-image-1212',
    'seedream-4',
    'sd3',
  ]) {
    assert.equal(categorizeModel(m(id)), 'image', id)
  }
})

// --- the asymmetry: never hide a usable chat model ---------------------------

test('chat models that merely look non-chat are NOT hidden', () => {
  // Each of these has burned someone on a broader pattern:
  // `nova` (deepgram/nova-3 is speech, this one is not), a bare `audio`
  // substring, `gte`/`e5` as embedding families, `search` as a mode.
  for (const id of [
    'amazon.nova-pro-v1:0',
    'amazon.nova-lite-v1:0',
    'gpt-4o-audio-preview',
    'gpt-4o-search-preview',
    'gpt-5.4',
    'ai-gateway-gpt-5.4-mini',
    // `-image` followed by a word, not a version — reading images is a chat
    // capability; generating them is not.
    'acme-vision-image-understanding',
  ]) {
    assert.equal(categorizeModel(m(id)), 'chat', id)
  }
})

test('an explicit chat mode overrides a non-chat-looking id', () => {
  // If LiteLLM says it is a chat model, believe it over the name.
  assert.equal(categorizeModel(m('acme-embed-chat', 'chat')), 'chat')
})

// --- display names -----------------------------------------------------------

test('formatModelName strips the provider prefix and title-cases', () => {
  assert.equal(formatModelName(m('azure/ai-gateway-gpt-5.4')), 'AI Gateway GPT 5.4')
  assert.equal(formatModelName(m('claude-opus-5')), 'Claude Opus 5')
})
