import browser from 'webextension-polyfill'

export async function getMeta() {
  const { 'sync.meta': meta } = await browser.storage.local.get('sync.meta')
  return meta || {}
}

export async function setMeta(patch) {
  const meta = await getMeta()
  await browser.storage.local.set({ 'sync.meta': { ...meta, ...patch } })
}
