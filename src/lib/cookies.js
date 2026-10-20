import browser from 'webextension-polyfill'

const MAX_COOKIE_BYTES = 16 << 10

// Firefox with First-Party Isolation keeps cookies in separate jars and returns
// nothing without firstPartyDomain; Chromium rejects the field, hence the
// fallback. Partitioned (third-party) jars are left out on purpose: a top-level
// download of the file would not send them either.
async function getAllCookies(url) {
  try {
    return await browser.cookies.getAll({ url, firstPartyDomain: null })
  } catch {
    try {
      return await browser.cookies.getAll({ url })
    } catch {
      return []
    }
  }
}

function hostPattern(url) {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return `${u.protocol}//${u.hostname}/*`
}

// Must be called synchronously inside the click handler: Firefox accepts
// permissions.request() only while the user action is still on the stack, and
// any await before it loses it. Firefox also asks for consent to send
// authentication data (the optional data_collection permission).
export function requestCookieAccess(url) {
  let pattern
  try {
    pattern = hostPattern(url)
  } catch {
    return Promise.resolve(false)
  }
  if (!pattern) return Promise.resolve(false)
  const origins = { origins: [pattern] }
  let pending
  if (typeof browser.runtime.getBrowserInfo === 'function') {
    // A Firefox without data_collection support fails schema validation
    // synchronously, so the fallback still runs inside the user action.
    try {
      pending = browser.permissions.request({ ...origins, data_collection: ['authenticationInfo'] })
    } catch { /* fall through */ }
  }
  pending ??= browser.permissions.request(origins)
  return pending.catch(() => false)
}

// access: the promise from requestCookieAccess, or undefined outside a user
// action — then only an already granted permission counts.
export async function collectCookieHeader(url, access) {
  try {
    const pattern = hostPattern(url)
    if (!pattern) return ''
    const has = access ? await access : await browser.permissions.contains({ origins: [pattern] })
    if (!has) return ''
    const cookies = await getAllCookies(url)
    const seen = new Map()
    for (const c of cookies) {
      if (!seen.has(c.name)) seen.set(c.name, c.value)
    }
    if (!seen.size) return ''
    const header = [...seen].map(([name, value]) => `${name}=${value}`).join('; ')
    if (new TextEncoder().encode(header).length > MAX_COOKIE_BYTES) return ''
    return header
  } catch {
    return ''
  }
}
