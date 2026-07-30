export { LiteLLMPricingPlugin } from './plugin.ts'
// `export type *`, not `export *`: opencode's plugin loader requires every
// runtime export of this module to be a plugin function. types.ts exports a
// value (LITELLM_CHAT_MODES), and re-exporting it here broke 0.2.0 with
// "Plugin export is not a function". The type form is erased at compile time.
export type * from './types.ts'
