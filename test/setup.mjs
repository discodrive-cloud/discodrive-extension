// Loaded with --import: points the extension's 'webextension-polyfill' import
// at the in-memory fake.
import { registerHooks } from 'node:module'

const fake = new URL('./fake-browser.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'webextension-polyfill') return { url: fake, shortCircuit: true }
    return next(specifier, context)
  },
})
