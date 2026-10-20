// Locale dictionaries loaded by hand from _locales: browser.i18n is locked to
// the browser UI language, while the language here is user-selectable.
import browser from 'webextension-polyfill'
import { getSettings } from './settings.js'

export const SUPPORTED = ['en', 'de', 'uk', 'fr', 'es', 'ru', 'sr']

let dict = null
let fallbackDict = null
let loadPromise = null

async function loadLocale(lang) {
  const resp = await fetch(browser.runtime.getURL(`_locales/${lang}/messages.json`))
  return resp.json()
}

async function load() {
  const { lang } = await getSettings()
  let resolved = lang && lang !== 'auto'
    ? lang
    : (browser.i18n.getUILanguage() || 'en').split('-')[0].toLowerCase()
  if (!SUPPORTED.includes(resolved)) resolved = 'en'
  fallbackDict = await loadLocale('en')
  dict = resolved === 'en' ? fallbackDict : await loadLocale(resolved)
}

// A failed load is not cached: the next caller retries.
export function ensureI18n() {
  loadPromise ??= load().catch((e) => {
    loadPromise = null
    throw e
  })
  return loadPromise
}

export async function reloadI18n() {
  loadPromise = null
  await ensureI18n()
}

export function t(key, ...subs) {
  const entry = dict?.[key] || fallbackDict?.[key]
  if (!entry) return key
  let msg = entry.message
  if (entry.placeholders) {
    for (const [name, ph] of Object.entries(entry.placeholders)) {
      const idx = parseInt(String(ph.content).slice(1), 10) - 1
      msg = msg.split(`$${name.toUpperCase()}$`).join(subs[idx] ?? '')
    }
  }
  return msg
}

export async function localizePage() {
  await ensureI18n()
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n)
  }
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh)
  }
}
