import browser from 'webextension-polyfill'
import { t, localizePage, reloadI18n, SUPPORTED } from '../lib/i18n.js'
import { getSettings, setSettings, hasHostPermission, requestHostPermission } from '../lib/settings.js'
import { pairInit, pairPoll, completePairing, unpair, getAuthState } from '../lib/auth.js'

// Sync work runs in the background context; this page only asks for it.
function syncAction(type) {
  return browser.runtime.sendMessage({ type })
}

const $ = (id) => document.getElementById(id)

function setText(id, text, cls = 'muted') {
  const el = $(id)
  el.textContent = text
  el.className = cls
}

async function refreshServerStatus() {
  const { baseUrl } = await getSettings()
  $('base-url').value = baseUrl
  $('open-server').hidden = true
  if (!baseUrl) {
    setText('server-status', t('optServerUnset'))
    return
  }
  if (!(await hasHostPermission(baseUrl))) {
    setText('server-status', t('optServerNoAccess'), 'muted error')
    return
  }
  try {
    const resp = await fetch(`${baseUrl}/health`)
    setText('server-status', resp.ok ? t('optServerOk') : t('optServerStatus', String(resp.status)), resp.ok ? 'muted ok' : 'muted error')
  } catch {
    if (baseUrl.startsWith('https://')) {
      setText('server-status', t('optCertHint'), 'muted error')
      $('open-server').hidden = false
    } else {
      setText('server-status', t('optServerDown'), 'muted error')
    }
  }
}

$('open-server').addEventListener('click', async () => {
  const { baseUrl } = await getSettings()
  if (baseUrl) await browser.tabs.create({ url: baseUrl })
})

$('open-help').addEventListener('click', (e) => {
  e.preventDefault()
  browser.tabs.create({ url: browser.runtime.getURL('help/help.html') })
})

async function refreshPairStatus() {
  const auth = await getAuthState()
  $('base-url').disabled = Boolean(auth.paired)
  $('save-url').disabled = Boolean(auth.paired)
  if (auth.paired) {
    setText('pair-status', t('optPairedAs', auth.deviceName || ''), 'muted ok')
    $('pair').hidden = true
    $('unpair').hidden = false
  } else if (auth.deviceToken) {
    setText('pair-status', t('optPairRevoked'), 'muted error')
    $('pair').hidden = false
    $('unpair').hidden = false
  } else {
    setText('pair-status', t('optNotPaired'))
    $('pair').hidden = false
    $('unpair').hidden = true
  }
}

async function refreshSyncStatus() {
  const { syncEnabled } = await getSettings()
  $('sync-enabled').checked = syncEnabled
  $('sync-now').disabled = !syncEnabled
  $('full-resync').disabled = !syncEnabled
  const { 'sync.meta': meta } = await browser.storage.local.get('sync.meta')
  if (meta?.lastError) {
    setText('sync-status', t('optSyncError', meta.lastError), 'muted error')
  } else if (meta?.lastSyncAt) {
    setText('sync-status', t('optLastSync', new Date(meta.lastSyncAt).toLocaleString()))
  } else {
    setText('sync-status', '')
  }
}

$('save-url').addEventListener('click', async () => {
  let url = $('base-url').value.trim().replace(/\/+$/, '')
  if (!url) return
  if (!/^https?:\/\//.test(url)) url = 'https://' + url
  try {
    const granted = await requestHostPermission(url)
    if (!granted) {
      setText('server-status', t('optGrantDenied'), 'muted error')
      return
    }
  } catch (e) {
    setText('server-status', t('optGrantFailed', e.message), 'muted error')
    return
  }
  // A pairing belongs to its server: its tokens must not reach a new one.
  const { baseUrl: prev } = await getSettings()
  const auth = await getAuthState()
  if (prev && prev !== url && auth.deviceToken) {
    stopPairing()
    await unpair()
    $('pair-flow').hidden = true
  }
  await setSettings({ baseUrl: url })
  await refreshServerStatus()
  await refreshPairStatus()
  await refreshSyncStatus()
})

// Each click on "Pair" starts a new flow; a poll still running for an older
// flow sees the changed id and stops. Polls never overlap: the next one is
// scheduled only after the previous answer.
let pairFlowId = 0
let pollTimer = null

function stopPairing() {
  pairFlowId++
  clearTimeout(pollTimer)
}

$('pair').addEventListener('click', async () => {
  stopPairing()
  const myFlow = pairFlowId
  try {
    const flow = await pairInit()
    if (myFlow !== pairFlowId) return
    $('pair-flow').hidden = false
    $('pair-code').textContent = flow.userCode
    setText('pair-progress', t('optWaiting'))
    $('open-verify').onclick = () => browser.tabs.create({ url: flow.verifyUrl })
    const tick = async () => {
      if (myFlow !== pairFlowId) return
      try {
        const res = await pairPoll(flow.deviceCode)
        if (myFlow !== pairFlowId) return
        if (res.state === 'approved') {
          stopPairing()
          await completePairing(res.deviceToken)
          $('pair-flow').hidden = true
          await refreshPairStatus()
          await refreshSyncStatus()
        } else if (res.state === 'expired') {
          setText('pair-progress', t('optCodeExpired'), 'muted error')
        } else {
          pollTimer = setTimeout(tick, flow.interval * 1000)
        }
      } catch (e) {
        setText('pair-progress', e.message, 'muted error')
      }
    }
    pollTimer = setTimeout(tick, flow.interval * 1000)
  } catch (e) {
    setText('pair-status', e.message, 'muted error')
  }
})

$('unpair').addEventListener('click', async () => {
  stopPairing()
  await unpair()
  $('pair-flow').hidden = true
  await refreshPairStatus()
  await refreshSyncStatus()
})

$('sync-enabled').addEventListener('change', async (e) => {
  const on = e.target.checked
  e.target.disabled = true
  try {
    if (on) {
      setText('sync-status', t('optInitialSync'))
      await syncAction('sync-enable')
    } else {
      await syncAction('sync-disable')
    }
  } catch (err) {
    // The checkbox shows what the background actually ended up with.
    e.target.disabled = false
    await refreshSyncStatus()
    setText('sync-status', t('optSyncFailed', err.message), 'muted error')
    return
  }
  e.target.disabled = false
  await refreshSyncStatus()
})

$('sync-now').addEventListener('click', async () => {
  setText('sync-status', t('optSyncing'))
  try {
    await syncAction('sync-now')
  } catch (e) {
    setText('sync-status', t('optSyncError', e.message), 'muted error')
    return
  }
  await refreshSyncStatus()
})

$('full-resync').addEventListener('click', async () => {
  setText('sync-status', t('optResyncing'))
  try {
    await syncAction('sync-full')
  } catch (e) {
    setText('sync-status', t('optResyncFailed', e.message), 'muted error')
    return
  }
  await refreshSyncStatus()
})

const LANG_NAMES = {
  en: 'English', ru: 'Русский', de: 'Deutsch', es: 'Español',
  fr: 'Français', sr: 'Српски', uk: 'Українська',
}

async function renderLangSelect() {
  const { lang } = await getSettings()
  const sel = $('lang')
  sel.textContent = ''
  const auto = document.createElement('option')
  auto.value = 'auto'
  auto.textContent = t('langAuto')
  sel.append(auto)
  for (const code of SUPPORTED) {
    const opt = document.createElement('option')
    opt.value = code
    opt.textContent = LANG_NAMES[code]
    sel.append(opt)
  }
  sel.value = lang || 'auto'
}

$('lang').addEventListener('change', async (e) => {
  await setSettings({ lang: e.target.value })
  await reloadI18n()
  await localizePage()
  await renderLangSelect()
  await refreshServerStatus()
  await refreshPairStatus()
  await refreshSyncStatus()
  browser.runtime.sendMessage({ type: 'i18n-changed' }).catch(() => {})
})

async function init() {
  // Firefox for Android: no bookmarks API, nothing to sync.
  $('bookmarks-section').hidden = !browser.bookmarks
  await localizePage()
  await renderLangSelect()
  await refreshServerStatus()
  await refreshPairStatus()
  await refreshSyncStatus()
}
init()
