// Display-name formatting and coarse model classification.

import type { LiteLLMModel, ModelType } from './types.ts'

/**
 * Classify a model so non-chat models (embeddings, image, audio) can be
 * filtered out of the picker. Prefers LiteLLM's `mode`, falling back to
 * id heuristics when `mode` is absent.
 */
export function categorizeModel(model: LiteLLMModel): ModelType {
  const mode = model.mode?.toLowerCase()
  if (mode) {
    if (mode === 'embedding') return 'embedding'
    if (mode === 'image_generation') return 'image'
    if (mode === 'audio_transcription' || mode === 'audio_speech') return 'audio'
    if (mode === 'chat' || mode === 'completion' || mode === 'responses') return 'chat'
    // rerank / moderation / anything else → not a chat model
    if (mode === 'rerank' || mode === 'moderation') return 'unknown'
  }

  const id = model.id.toLowerCase()
  if (id.includes('embedding') || id.includes('embed')) return 'embedding'
  if (id.includes('whisper') || id.includes('tts') || id.includes('transcribe') || id.includes('audio')) {
    return 'audio'
  }
  if (id.includes('dall-e') || id.includes('dalle') || id.includes('stable-diffusion') || id.includes('flux')) {
    return 'image'
  }
  return 'chat'
}

/**
 * Turn a raw model id into a readable display name. Strips a leading
 * provider prefix (`azure/`, `openai/`, …), splits on separators, and
 * title-cases words while preserving common all-caps / versioned tokens.
 */
export function formatModelName(model: LiteLLMModel): string {
  let id = model.id
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)

  const words = id.split(/[-_\s]+/).filter(Boolean)
  const formatted = words.map((word) => {
    // Keep tokens that already carry meaningful casing/digits as-is
    // (e.g. "gpt", "3.5", "v2", "o1"), only capitalising plain words.
    if (/\d/.test(word)) return word
    if (word.length <= 3) return word.toUpperCase()
    return word.charAt(0).toUpperCase() + word.slice(1)
  })
  return formatted.join(' ')
}
