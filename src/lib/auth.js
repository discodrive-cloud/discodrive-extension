import browser from 'webextension-polyfill'
import { t, ensureI18n } from './i18n.js'
import { getSettings, setSettings, hasHostPermission } from './settings.js'
import { ApiError } from './api.js'
import { clearBadge } from './badge.js'

async function post(baseUrl, path, body) {
  await ensureI18n()
  let resp
  try {
    resp = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new ApiError('network', t('errNetwork', e.message))
  }
  const data = await resp.json().catch(() => ({}))
  return { status: resp.status, data }
}

function browserName() {
  const ua = navigator.userAgent
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Chrome')) return 'Chromium'
  return 'Browser'
}

export async function pairInit() {
  await ensureI18n()
  const { baseUrl } = await getSettings()
  if (!(await hasHostPermission(baseUrl))) {
    throw new ApiError('no-host-permission', t('errGrantFirst'))
  }
  const { status, data } = await post(baseUrl, '/pair/init', {
    name: t('pairName', browserName()),
    kind: 'extension',
  })
  if (status !== 201) throw new ApiError('http', data.error || `HTTP ${status}`, status)
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verifyUrl: `${baseUrl}/app/pair?code=${encodeURIComponent(data.user_code)}`,
    interval: data.interval || 2,
    expiresIn: data.expires_in || 600,
  }
}

export async function pairPoll(deviceCode) {
  const { baseUrl } = await getSettings()
  const { status, data } = await post(baseUrl, '/pair/token', { device_code: deviceCode })
  if (status === 410) return { state: 'expired' }
  if (status !== 200) throw new ApiError('http', data.error || `HTTP ${status}`, status)
  if (data.status === 'pending') return { state: 'pending' }
  return { state: 'approved', deviceToken: data.device_token }
}

// Waits for a running sync cycle, which would otherwise write its state back.
function resetLocalState() {
  return navigator.locks.request('dd-sync', async () => {
    await browser.storage.local.remove(['sync.meta', 'sync.map', 'sync.queue', 'sync.orphans', 'tasks'])
    await browser.storage.session.clear().catch(() => {})
    await browser.alarms.clearAll()
    await setSettings({ syncEnabled: false })
  })
}

export async function completePairing(deviceToken) {
  const { baseUrl } = await getSettings()
  const { status, data } = await post(baseUrl, '/auth/device/token', { device_token: deviceToken })
  if (status !== 200) throw new ApiError('http', data.error || `HTTP ${status}`, status)
  await browser.storage.local.set({
    auth: { deviceToken, jwt: data.token, deviceName: t('pairName', browserName()), paired: true, baseUrl },
  })
  await clearBadge()
  // The pairing is already stored. If the account cannot be checked, the old
  // sync state may belong to another account and is dropped; userId is then
  // fetched again when sync is turned on.
  let me
  try {
    const meResp = await fetch(baseUrl + '/me', { headers: { Authorization: `Bearer ${data.token}` } })
    if (meResp.ok) me = await meResp.json()
  } catch { /* offline right after approval */ }
  if (!me?.id) {
    await resetLocalState()
    return
  }
  const { 'sync.meta': meta } = await browser.storage.local.get('sync.meta')
  if (meta?.userId && meta.userId !== me.id) {
    await resetLocalState()
    await browser.storage.local.set({ 'sync.meta': { userId: me.id } })
  } else {
    await browser.storage.local.set({ 'sync.meta': { ...(meta || {}), userId: me.id } })
  }
}

export async function unpair() {
  await browser.storage.local.remove('auth')
  await resetLocalState()
  await clearBadge()
}

export async function getAuthState() {
  const { auth } = await browser.storage.local.get('auth')
  return auth || { paired: false }
}
