import browser from 'webextension-polyfill'

// b2s/s2b: browser id <-> server id. roots: this browser's native root folders
// (browser id -> server id). foreign: server ids of roots other browsers have
// and this one lacks (Firefox's "Bookmarks Menu" in Chromium). skip: server ids
// living under a foreign root — they stay on the server only.
export async function loadMap() {
  const { 'sync.map': map } = await browser.storage.local.get('sync.map')
  return { b2s: {}, s2b: {}, roots: {}, foreign: [], skip: {}, ...(map || {}) }
}

export async function saveMap(map) {
  await browser.storage.local.set({ 'sync.map': map })
}

// Every load-modify-save of the map runs under this lock: local bookmark events
// and apply passes would otherwise overwrite each other's pairs.
export function withMapLock(fn) {
  return navigator.locks.request('dd-map', fn)
}

export function setPair(map, browserId, serverId) {
  map.b2s[browserId] = serverId
  map.s2b[serverId] = browserId
}

export function removePairByServer(map, serverId) {
  const browserId = map.s2b[serverId]
  if (browserId !== undefined) delete map.b2s[browserId]
  delete map.s2b[serverId]
}

export function removePairByBrowser(map, browserId) {
  const serverId = map.b2s[browserId]
  if (serverId !== undefined) delete map.s2b[serverId]
  delete map.b2s[browserId]
}

export function isRootBrowserId(map, browserId) {
  return browserId in map.roots
}

export function isRootServerId(map, serverId) {
  return Object.values(map.roots).includes(serverId)
}

export function isForeignServerId(map, serverId) {
  return map.foreign.includes(serverId) || serverId in map.skip
}
