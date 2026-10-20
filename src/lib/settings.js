import browser from 'webextension-polyfill'

const DEFAULTS = { baseUrl: '', syncEnabled: false, lang: 'auto' }

export async function getSettings() {
  const { settings } = await browser.storage.local.get('settings')
  return { ...DEFAULTS, ...(settings || {}) }
}

export async function setSettings(patch) {
  const cur = await getSettings()
  const next = { ...cur, ...patch }
  await browser.storage.local.set({ settings: next })
  return next
}

// Match patterns carry no port: Firefox grants a permission that then matches
// nothing, Chromium ignores the port. Portless pattern covers every port.
export function originPattern(baseUrl) {
  const u = new URL(baseUrl)
  return `${u.protocol}//${u.hostname}/*`
}

export async function hasHostPermission(baseUrl) {
  try {
    return await browser.permissions.contains({ origins: [originPattern(baseUrl)] })
  } catch {
    return false
  }
}

export async function requestHostPermission(baseUrl) {
  return browser.permissions.request({ origins: [originPattern(baseUrl)] })
}
