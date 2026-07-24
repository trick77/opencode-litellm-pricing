// Display-name formatting and coarse model classification.

import type { LiteLLMModel, ModelType } from './types.ts'

/**
 * Classify a model so non-chat models (embedding, image, audio, rerank,
 * moderation) can be filtered out of the picker. Prefers LiteLLM's `mode`
 * (authoritative), falling back to conservative id heuristics only when
 * `mode` is absent.
 *
 * The id heuristics are deliberately narrow: a false positive HIDES a
 * usable chat model, which is worse than showing a stray non-chat one. So
 * we match only strong, boundary-anchored signals — e.g. `whisper`/`tts`,
 * not a bare `audio` substring (which would wrongly hide a chat model like
 * `gpt-4o-audio-preview`).
 */
export function categorizeModel(model: LiteLLMModel): ModelType {
  const mode = model.mode?.toLowerCase()
  if (mode) {
    if (mode === 'embedding') return 'embedding'
    if (mode === 'image_generation') return 'image'
    if (mode === 'audio_transcription' || mode === 'audio_speech') return 'audio'
    if (mode === 'chat' || mode === 'completion' || mode === 'responses') return 'chat'
    // rerank / moderation → not a chat model
    if (mode === 'rerank' || mode === 'moderation') return 'unknown'
  }

  const id = model.id.toLowerCase()
  if (/embedding|(?:^|[-_/])embed(?:$|[-_/])/.test(id)) return 'embedding'
  if (/whisper|transcrib|(?:^|[-_/])tts(?:$|[-_/])/.test(id)) return 'audio'
  if (/dall-?e|stable-diffusion|midjourney|(?:^|[-_/])flux(?:$|[-_/])/.test(id)) return 'image'
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
