// End-to-end scenarios: the plugin loaded the way opencode loads it, driven
// against a fake LiteLLM proxy. See test/helpers/fake-opencode-host.ts for
// what is faked and what that costs.
//
// Every scenario uses its OWN baseURL. `injectedModelIds` in src/plugin.ts is
// module-level state keyed by baseURL with no reset, so two scenarios sharing
// a URL would send the second one down the early-return path — passing
// without having injected anything.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Config } from '@opencode-ai/plugin'
import { resetCatalogCache } from '../src/catalog.ts'
import {
  CATALOG_PROVIDERS,
  captureConsole,
  fakePluginInput,
  json,
  loadPlugins,
  withFakeProxy,
  type Routes,
} from './helpers/fake-opencode-host.ts'

/** Load the entry module exactly as opencode would, and return the one plugin. */
async function loadTheOnePlugin() {
  const mod = await import('../src/index.ts')
  const plugins = loadPlugins(mod)
  assert.equal(plugins.length, 1, 'entry module should expose exactly one plugin')
  return plugins[0]!
}

/** Load, instantiate and run the `config` hook over `config`, capturing output. */
async function runConfigHook(config: Record<string, unknown>, routes: Routes) {
  resetCatalogCache()
  const plugin = await loadTheOnePlugin()
  return captureConsole(() =>
    withFakeProxy(routes, async () => {
      const hooks = await plugin(fakePluginInput(CATALOG_PROVIDERS))
      await hooks.config?.(config as unknown as Config)
      return config
    }),
  )
}

/** A provider block shaped like the one the README tells users to write. */
function providerConfig(baseURL: string, extra: Record<string, unknown> = {}) {
  return {
    provider: {
      'opencode-litellm-pricing': {
        // `npm` deliberately omitted — the plugin should default it.
        options: { baseURL, apiKey: 'sk-test' },
        ...extra,
      } as Record<string, unknown>,
    },
  }
}

const CHAT_MODEL = { id: 'ai-gateway-gpt-5.4', object: 'model' }

function modelsResponse(...ids: Array<{ id: string; object: string }>) {
  return json({ object: 'list', data: ids })
}

// 1 — the loader contract. This is the regression test: 0.2.0 re-exported a
// Set from types.ts through src/index.ts, and opencode refused to load it.
test('the entry module satisfies opencode\'s plugin loader', async () => {
  const mod = await import('../src/index.ts')
  const nonFunctions = Object.entries(mod)
    .filter(([, v]) => typeof v !== 'function')
    .map(([k, v]) => `${k} (${typeof v})`)

  // Reported before the throw, because "Plugin export is not a function"
  // alone does not say WHICH export — the whole difficulty of the original bug.
  assert.deepEqual(
    nonFunctions,
    [],
    `non-function exports leak into the entry module: ${nonFunctions.join(', ')}`,
  )

  const plugins = loadPlugins(mod)
  assert.equal(plugins.length, 1)
  assert.equal(typeof plugins[0], 'function')
})

// 2 — the happy path, all the way through.
test('injects discovered models with catalog pricing into the config', async () => {
  const config = providerConfig('https://proxy-inject.test/v1')
  const { logs } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL),
    '/model_group/info': () =>
      json({
        data: [
          {
            model_group: 'ai-gateway-gpt-5.4',
            mode: 'chat',
            max_input_tokens: 1050000,
            max_output_tokens: 128000,
            supports_function_calling: true,
          },
        ],
      }),
  })

  const provider = config.provider['opencode-litellm-pricing']!
  assert.equal(provider.npm, '@ai-sdk/openai-compatible', 'npm should be defaulted')

  const models = provider.models as Record<string, Record<string, unknown>>
  const entry = models['ai-gateway-gpt-5.4']
  assert.ok(entry, 'the chat model should be injected')
  assert.equal(entry.name, 'AI Gateway GPT 5.4')
  assert.deepEqual(entry.limit, { context: 1050000, output: 128000 })
  // Priced from the models.dev catalog by name-match, never from the proxy.
  // No cache_write: a zero cache tier is dropped rather than reported as free.
  assert.deepEqual(entry.cost, { input: 2.5, output: 15, cache_read: 0.25 })
  assert.equal(entry.tool_call, true)

  assert.ok(
    logs.some((l) => l.includes('1 model(s) added') && l.includes('1 with pricing')),
    `expected a summary line, got: ${logs.join(' | ')}`,
  )
})

// 3 — LiteLLM's own `mode` filters non-chat models. The id here is
// deliberately neutral: a name like `…-text-embedding-3-small` would be
// filtered by the id heuristics too, which would not prove the mode path ran.
test('non-chat models are filtered out by /model_group/info mode', async () => {
  const config = providerConfig('https://proxy-mode.test/v1')
  const { logs } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL, { id: 'house-vectorizer', object: 'model' }),
    '/model_group/info': () =>
      json({
        data: [
          { model_group: 'ai-gateway-gpt-5.4', mode: 'chat' },
          { model_group: 'house-vectorizer', mode: 'embedding' },
        ],
      }),
  })

  const models = config.provider['opencode-litellm-pricing']!.models as Record<string, unknown>
  assert.ok(models['ai-gateway-gpt-5.4'], 'the chat model should survive')
  assert.equal(models['house-vectorizer'], undefined, 'the embedding model should be hidden')
  assert.ok(logs.some((l) => l.includes('1 non-chat hidden')))
})

// 4 — a matched provider with nothing to talk to.
test('a provider without options.baseURL warns and injects nothing', async () => {
  const config = { provider: { litellm: { options: {} } as Record<string, unknown> } }
  const { warns } = await runConfigHook(config, {})

  assert.equal(config.provider.litellm.models, undefined, 'nothing should be injected')
  assert.ok(
    warns.some((w) => w.includes('no options.baseURL')),
    `expected a baseURL warning, got: ${warns.join(' | ')}`,
  )
})

// 5 — an unreachable proxy must never break opencode's startup.
test('a proxy that cannot be reached is survivable', async () => {
  const config = providerConfig('https://proxy-down.test/v1')
  const { warns } = await runConfigHook(config, {
    '/v1/models': () => {
      throw new Error('ECONNREFUSED')
    },
  })

  const models = config.provider['opencode-litellm-pricing']!.models as Record<string, unknown>
  assert.deepEqual(models, {}, 'no models should be injected')
  assert.ok(
    warns.some((w) => w.includes('Model discovery failed')),
    `expected a discovery warning, got: ${warns.join(' | ')}`,
  )
})

// 6 — /model_group/info is best-effort: some keys are not allowed to call it.
test('discovery still works when /model_group/info is refused', async () => {
  const config = providerConfig('https://proxy-nogroups.test/v1')
  const { logs } = await runConfigHook(config, {
    '/v1/models': () =>
      modelsResponse(CHAT_MODEL, { id: 'ai-gateway-text-embedding-3-small', object: 'model' }),
    '/model_group/info': () => json({ error: 'forbidden' }, 403),
  })

  const models = config.provider['opencode-litellm-pricing']!.models as Record<string, unknown>
  assert.ok(models['ai-gateway-gpt-5.4'], 'the chat model should still be injected')
  // No `mode` available, so this one is caught by the id heuristics instead.
  assert.equal(models['ai-gateway-text-embedding-3-small'], undefined)
  assert.ok(
    logs.some((l) => l.includes('[no /model_group/info')),
    `expected the degraded-path marker, got: ${logs.join(' | ')}`,
  )
})

// 7 — the guarantee the README makes about hand-curated entries.
test('existing hand-curated model entries are never overwritten', async () => {
  const curated = { name: 'Hand Curated', cost: { input: 999, output: 999 } }
  const config = providerConfig('https://proxy-curated.test/v1', {
    models: { 'ai-gateway-gpt-5.4': curated },
  })
  const { logs } = await runConfigHook(config, {
    '/v1/models': () => modelsResponse(CHAT_MODEL),
    '/model_group/info': () => json({ data: [{ model_group: 'ai-gateway-gpt-5.4', mode: 'chat' }] }),
  })

  const models = config.provider['opencode-litellm-pricing']!.models as Record<string, unknown>
  assert.deepEqual(models['ai-gateway-gpt-5.4'], curated)
  // The entry surviving is not enough on its own — it would also survive if
  // discovery never ran. The summary line proves the model WAS discovered and
  // then deliberately skipped.
  assert.ok(
    logs.some((l) => l.includes('0 model(s) added')),
    `expected discovery to have run and added nothing, got: ${logs.join(' | ')}`,
  )
})
