import browser from 'webextension-polyfill'
import { t, ensureI18n, reloadI18n } from './lib/i18n.js'
import * as saved from './lib/saved.js'
import { collectCookieHeader, requestCookieAccess } from './lib/cookies.js'
import { pickDownloadUrl } from './lib/menu.js'
import { extractFromTab } from './lib/extract.js'
import { setBadgeUnpaired, setBadgeTasks } from './lib/badge.js'
import { registerListeners, PUSH_ALARM } from './sync/local-events.js'
import { runSync, enableSync, disableSync, fullResync, PULL_ALARM } from './sync/engine.js'

// Firefox for Android has neither bookmarks nor context menus: the popup and
// the pocket keep working, the rest is switched off.
const hasMenus = Boolean(browser.contextMenus)
const hasBookmarks = Boolean(browser.bookmarks)

async function submitPocket(url, title, tabId) {
  const article = tabId != null ? await extractFromTab(tabId) : null
  return saved.submit('article', url, article?.title || title || '', article?.content || '')
}

async function submitDownload(url, cookieAccess) {
  const cookie = await collectCookieHeader(url, cookieAccess)
  return saved.submit('download', url, '', '', cookie)
}

async function setupMenus() {
  if (!hasMenus) return
  await ensureI18n()
  await browser.contextMenus.removeAll()
  browser.contextMenus.create({
    id: 'dd-download',
    title: t('menuDownload'),
    contexts: ['link', 'image', 'video', 'audio'],
  })
  browser.contextMenus.create({
    id: 'dd-pocket',
    title: t('menuPocket'),
    contexts: ['page', 'selection', 'image', 'video', 'audio', 'frame'],
  })
}
// Listeners stay at the top level: the browser revives a dead service worker by
// the event, and a listener registered later would never fire.
browser.runtime.onInstalled.addListener(setupMenus)
browser.runtime.onStartup.addListener(setupMenus)

if (hasMenus) {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'dd-download') {
      const url = pickDownloadUrl(info)
      // The permission prompt goes first, while the click is still the
      // current user action (see requestCookieAccess).
      if (url) submitDownload(url, requestCookieAccess(url)).catch(() => {})
    } else if (info.menuItemId === 'dd-pocket') {
      const url = info.pageUrl || tab?.url
      if (url) submitPocket(url, tab?.title || '', tab?.id).catch(() => {})
    }
  })
}

if (hasBookmarks) registerListeners()

browser.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case saved.POLL_ALARM:
      saved.poll().catch(() => {})
      break
    case PULL_ALARM:
    case PUSH_ALARM:
      if (hasBookmarks) runSync().catch(() => {})
      break
  }
})

browser.runtime.onStartup.addListener(async () => {
  const { auth, tasks, settings } = await browser.storage.local.get(['auth', 'tasks', 'settings'])
  if (auth && auth.paired === false) await setBadgeUnpaired()
  if (tasks?.active?.length) {
    await setBadgeTasks(tasks.active.length)
    await browser.alarms.create(saved.POLL_ALARM, { periodInMinutes: 1, when: Date.now() + 5000 })
  }
  if (hasBookmarks && settings?.syncEnabled) {
    await browser.alarms.create(PULL_ALARM, { periodInMinutes: 5 })
  }
})

// Sync work runs here and not in the options page: closing the tab must not
// cut an initial sync in half.
const syncActions = {
  'sync-now': runSync,
  'sync-enable': enableSync,
  'sync-disable': disableSync,
  'sync-full': fullResync,
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (Object.hasOwn(syncActions, msg?.type)) {
    if (!hasBookmarks) return undefined
    await syncActions[msg.type]()
    return null
  }
  switch (msg?.type) {
    case 'saved-submit':
      if (msg.kind === 'article') {
        return submitPocket(msg.url, msg.title || '', msg.tabId)
      }
      if (msg.kind === 'download') {
        return submitDownload(msg.url)
      }
      return saved.submit(msg.kind, msg.url, msg.title || '')
    case 'saved-cancel':
      return saved.cancel(msg.id)
    case 'i18n-changed':
      await reloadI18n()
      return setupMenus()
    default:
      return undefined
  }
})
