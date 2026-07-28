// Display-name formatting and coarse model classification.

import type { LiteLLMModel, ModelType } from './types.ts'
import { LITELLM_CHAT_MODES } from './types.ts'

/**
 * Classify a model so non-chat models (embedding, image, audio, rerank,
 * moderation, search) can be filtered out of the picker. Prefers LiteLLM's
 * `mode` (authoritative), falling back to conservative id heuristics only
 * when `mode` is absent or null.
 *
 * The mode branch is an ALLOW-list, not a deny-list: any non-empty mode that
 * isn't a chat mode is non-chat, including values this file has never heard
 * of. A deny-list silently let new modes (`search`, `image_edit`, …) through
 * as chat models.
 *
 * The id heuristics are deliberately narrow: a false positive HIDES a
 * usable chat model, which is worse than showing a stray non-chat one. So
 * we match only strong, boundary-anchored signals — e.g. `whisper`/`tts`,
 * not a bare `audio` substring (which would wrongly hide a chat model like
 * `gpt-4o-audio-preview`). Deliberately NOT matched for the same reason:
 * bare `nova` (`amazon.nova-pro-v1` is a chat model), `e5`, `gte`.
 */
export function categorizeModel(model: LiteLLMModel): ModelType {
  const mode = model.mode?.toLowerCase()
  // `mode` is absent on /v1/models and null for models LiteLLM has no
  // price-map entry for; both mean "no signal", not "not a chat model".
  if (mode) {
    if (LITELLM_CHAT_MODES.has(mode)) return 'chat'
    if (mode === 'embedding') return 'embedding'
    if (mode === 'image_generation') return 'image'
    if (mode === 'audio_transcription' || mode === 'audio_speech') return 'audio'
    // rerank / moderation / search / anything unrecognised → not chat
    return 'unknown'
  }

  const id = model.id.toLowerCase()
  if (/rerank/.test(id)) return 'unknown'
  if (/moderat/.test(id)) return 'unknown'
  if (
    /embedding|(?:^|[-_/])embed(?:$|[-_/])|(?:^|[-_/])voyage-|(?:^|[-_/])bge-|jina-embed|jina-clip/.test(
      id,
    )
  ) {
    return 'embedding'
  }
  if (
    /whisper|transcrib|(?:^|[-_/])tts(?:$|[-_/])|elevenlabs|cartesia|deepgram/.test(id)
  ) {
    return 'audio'
  }
  if (
    // `-image` must end the id or be followed by a version-ish token
    // (`grok-2-image-1212`), never by a word — `…-image-understanding` is a
    // chat model, and a bare `image` substring is far too broad.
    /dall-?e|stable-diffusion|midjourney|(?:^|[-_/])flux(?:$|[-_/])|imagen|gpt-image|-image(?:$|[-_/]\d)|(?:^|[-_/])sd3(?:$|[-_/])|seedream/.test(
      id,
    )
  ) {
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
