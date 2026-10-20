import browser, { fake } from './fake-browser.mjs'
import { FakeServer, BASE } from './fake-server.mjs'
import * as localEvents from '../src/sync/local-events.js'

export { browser, fake }

// Fresh browser + server, paired and with host permission.
export async function setup() {
  fake.reset()
  const server = new FakeServer()
  server.install()
  await browser.storage.local.set({
    settings: { baseUrl: BASE, syncEnabled: false, lang: 'en' },
    auth: { deviceToken: server.deviceToken, jwt: server.jwt, paired: true, baseUrl: BASE },
    'sync.meta': { userId: server.userId },
  })
  return server
}

// Lets pending bookmark events fire and the event chain drain.
export async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await localEvents.eventsIdle?.()
  }
}

export async function queue() {
  const { 'sync.queue': q } = await browser.storage.local.get('sync.queue')
  return q || []
}

export async function localTitles(folderId) {
  const [tree] = await browser.bookmarks.getSubTree(folderId)
  const out = []
  const walk = (n) => {
    for (const c of n.children || []) {
      out.push(c.title)
      walk(c)
    }
  }
  walk(tree)
  return out
}

export async function findLocal(title) {
  const [tree] = await browser.bookmarks.getTree()
  let hit = null
  const walk = (n) => {
    if (n.title === title && n.id !== '0') hit = hit || n
    for (const c of n.children || []) walk(c)
  }
  walk(tree)
  return hit
}
