import browser from 'webextension-polyfill'
import { t, ensureI18n } from './i18n.js'
import { getSettings, hasHostPermission } from './settings.js'
import { setBadgeUnpaired, restoreBadge } from './badge.js'

export class ApiError extends Error {
  constructor(kind, message, status = 0) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

// Worth retrying later: the server or the link is down, or the user has to fix
// the pairing/permission first. Anything else is a rejection of the request.
export function isTransient(e) {
  return e instanceof ApiError && (
    e.kind === 'network' || e.kind === 'no-host-permission' || e.kind === 'not-paired'
    || e.status === 429 || e.status >= 500
  )
}

async function getAuth() {
  const { auth } = await browser.storage.local.get('auth')
  return auth || {}
}

async function setAuth(patch) {
  const cur = await getAuth()
  await browser.storage.local.set({ auth: { ...cur, ...patch } })
}

// null = the device token itself was rejected (pairing revoked). Network
// errors, 429 and 5xx throw: they say nothing about the pairing.
async function reissueJWT(baseUrl, auth) {
  let resp
  try {
    resp = await fetch(`${baseUrl}/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_token: auth.deviceToken }),
    })
  } catch (e) {
    throw new ApiError('network', t('errNetwork', e.message))
  }
  if (resp.status === 401) return null
  if (!resp.ok) throw new ApiError('http', `token exchange: ${resp.status}`, resp.status)
  const { token } = await resp.json()
  await setAuth({ jwt: token, paired: true })
  if (auth.paired === false) await restoreBadge()
  return token
}

// Authorized request. A 401 triggers one JWT reissue from the device token;
// a second 401 means the pairing was revoked (badge + typed error).
export async function request(path, opts = {}) {
  await ensureI18n()
  const { baseUrl } = await getSettings()
  if (!baseUrl) {
    throw new ApiError('no-host-permission', t('errGrantFirst'))
  }
  if (!(await hasHostPermission(baseUrl))) {
    throw new ApiError('no-host-permission', t('errNoHostPerm'))
  }
  const auth = await getAuth()
  if (!auth.deviceToken) {
    throw new ApiError('not-paired', t('errNotPaired'))
  }
  // Credentials belong to the server that issued them and never go elsewhere.
  // Pairings made before the binding existed adopt the current server.
  if (!auth.baseUrl) {
    await setAuth({ baseUrl })
  } else if (auth.baseUrl !== baseUrl) {
    throw new ApiError('not-paired', t('errNotPaired'))
  }

  const doFetch = async (jwt) => {
    let resp
    try {
      resp = await fetch(baseUrl + path, {
        method: opts.method || 'GET',
        headers: {
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
    } catch (e) {
      throw new ApiError('network', t('errNetwork', e.message))
    }
    return resp
  }

  let resp = await doFetch(auth.jwt)
  if (resp.status === 401) {
    const fresh = await reissueJWT(baseUrl, auth)
    if (fresh) resp = await doFetch(fresh)
    if (!fresh || resp.status === 401) {
      await setAuth({ paired: false })
      await setBadgeUnpaired()
      throw new ApiError('not-paired', t('errRevoked'), 401)
    }
  }
  if (opts.raw) return resp
  if (resp.status === 204) return null
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw new ApiError('http', data.error || `HTTP ${resp.status}`, resp.status)
  }
  return data
}
