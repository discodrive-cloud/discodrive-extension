import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup, settle, queue, localTitles, findLocal, browser } from './helpers.mjs'
import { registerListeners } from '../src/sync/local-events.js'
import { enableSync, disableSync, runSync } from '../src/sync/engine.js'
import { uuidv5 } from '../src/lib/uuid.js'

registerListeners()

const BAR = '1'
const OTHER = '2'

async function bm(parentId, title, url = `https://example.com/${encodeURIComponent(title)}`) {
  return browser.bookmarks.create({ parentId, title, url })
}

async function folder(parentId, title) {
  return browser.bookmarks.create({ parentId, title })
}

async function start(server, seed) {
  await seed?.()
  await settle()
  const { settings } = await browser.storage.local.get('settings')
  await browser.storage.local.set({ settings: { ...settings, syncEnabled: true } })
  await enableSync()
  await settle()
  return server
}

test('initial sync pushes the local tree; a second cycle writes nothing', async () => {
  const server = await setup()
  await start(server, async () => {
    const f = await folder(BAR, 'News')
    await bm(f.id, 'A')
    await bm(OTHER, 'B')
  })
  const news = server.byTitle('News')
  assert.ok(news)
  assert.equal(server.byTitle('A').parent_id, news.id)
  assert.deepEqual(await queue(), [])

  const seq = server.seq
  await runSync()
  await settle()
  await runSync()
  assert.equal(server.seq, seq, 'pulling our own changes must not echo them back')
})

test('remote changes are applied locally without being echoed back', async () => {
  const server = await start(await setup(), () => bm(BAR, 'Local'))
  const barId = (await uuidv5(server.userId, 'roots/toolbar'))
  server.remoteCreate({ parent_id: barId, title: 'Remote', url: 'https://r.example/' })
  await runSync()
  await settle()
  assert.ok(await findLocal('Remote'))
  assert.deepEqual(await queue(), [])
  const seq = server.seq
  await runSync()
  assert.equal(server.seq, seq)
})

test('a local edit made while the queue is being pushed is not lost', async () => {
  const server = await start(await setup(), () => bm(BAR, 'B'))
  const b = await findLocal('B')
  await bm(BAR, 'A')
  await settle()

  let edited = false
  server.before = async (method, path) => {
    if (method === 'POST' && path === '/me/bookmarks' && !edited) {
      edited = true
      await browser.bookmarks.update(b.id, { title: 'B renamed' })
      await settle()
    }
  }
  await runSync()
  server.before = null
  await runSync()
  assert.ok(server.byTitle('A'))
  assert.ok(server.byTitle('B renamed'), 'the rename queued during the push must reach the server')
})

test('a burst of local creates all reach the server', async () => {
  const server = await start(await setup())
  const f = await folder(BAR, 'Burst')
  await Promise.all(Array.from({ length: 30 }, (_, i) => bm(f.id, `n${i}`)))
  await settle()
  await runSync()
  const burst = server.byTitle('Burst')
  const kids = server.live().filter((r) => r.parent_id === burst.id)
  assert.equal(kids.length, 30)
})

test('transient failures keep the queue: 503, 429, revoked pairing', async () => {
  const server = await start(await setup())
  await bm(BAR, 'Kept')
  await settle()

  for (const status of [503, 429]) {
    server.before = (method) => (method === 'POST' ? new Response('{}', { status }) : undefined)
    await runSync()
    assert.equal((await queue()).length, 1, `queue kept after ${status}`)
  }
  server.before = null

  const good = server.deviceToken
  server.deviceToken = 'revoked'
  server.jwt = 'jwt-2'
  await runSync()
  assert.equal((await queue()).length, 1, 'queue kept while the pairing is revoked')

  server.deviceToken = good
  await runSync()
  assert.ok(server.byTitle('Kept'))
  assert.deepEqual(await queue(), [])
})

test('full resync fetches server items inside existing folders and pushes lost local ones', async () => {
  const server = await start(await setup(), async () => {
    const f = await folder(BAR, 'F')
    await bm(f.id, 'old')
  })
  const f = await findLocal('F')
  const serverF = server.byTitle('F')
  server.remoteCreate({ parent_id: serverF.id, title: 'from server', url: 'https://s.example/' })

  // A local bookmark whose create op got lost: in the browser, unknown to sync.
  const { 'sync.map': map } = await browser.storage.local.get('sync.map')
  const lost = await bm(f.id, 'lost local')
  await settle()
  await browser.storage.local.set({ 'sync.map': map, 'sync.queue': [] })

  server.forceFullResync()
  await runSync()
  await settle()
  assert.ok((await localTitles(f.id)).includes('from server'))
  assert.equal(server.byTitle('lost local')?.parent_id, serverF.id)
  assert.ok(lost)
})

test('full resync removes what was deleted elsewhere instead of resurrecting it', async () => {
  const server = await start(await setup(), async () => {
    await bm(BAR, 'top')
    const f = await folder(BAR, 'Dir')
    await bm(f.id, 'inside')
  })
  server.remoteDelete(server.byTitle('top').id)
  server.remoteDelete(server.byTitle('Dir').id)
  server.forceFullResync()
  await runSync()
  await settle()
  await runSync()
  assert.equal(await findLocal('top'), null)
  assert.equal(await findLocal('Dir'), null)
  assert.equal(server.byTitle('top'), undefined)
  assert.equal(server.byTitle('Dir'), undefined)
})

test('a change landing between the server list and the cursor is not skipped', async () => {
  const server = await start(await setup(), () => bm(BAR, 'x'))
  const barId = await uuidv5(server.userId, 'roots/toolbar')
  let injected = false
  server.after = (method, path) => {
    if (method === 'GET' && path === '/me/bookmarks' && !injected) {
      injected = true
      server.remoteCreate({ parent_id: barId, title: 'between', url: 'https://b.example/' })
    }
  }
  server.forceFullResync()
  await runSync()
  server.after = null
  await settle()
  await runSync()
  await settle()
  assert.ok(await findLocal('between'))
})

test('a root this browser lacks, added later by another browser, stays on the server', async () => {
  const server = await start(await setup(), () => bm(BAR, 'bar item'))
  // Firefox pairs after this Chromium: its "Bookmarks Menu" root and content
  // arrive through the changes feed.
  const menu = await uuidv5(server.userId, 'roots/menu')
  server.remoteCreate({ id: menu, is_folder: true, title: 'Bookmarks Menu' })
  const sub = server.remoteCreate({ parent_id: menu, is_folder: true, title: 'Menu folder' })
  server.remoteCreate({ parent_id: sub, title: 'Menu item', url: 'https://m.example/' })
  await runSync()
  await settle()
  server.remoteCreate({ parent_id: sub, title: 'Menu item 2', url: 'https://m2.example/' })
  await runSync()
  server.remoteCreate({ parent_id: menu, title: 'Menu item 3', url: 'https://m3.example/' })
  await runSync()
  await settle()
  for (const title of ['Bookmarks Menu', 'Menu folder', 'Menu item', 'Menu item 2', 'Menu item 3']) {
    assert.equal(await findLocal(title), null, `${title} must not appear locally`)
  }
  const { 'sync.orphans': orphans } = await browser.storage.local.get('sync.orphans')
  assert.deepEqual(orphans || [], [])
})

test('removing a folder whose creates are still queued sends nothing', async () => {
  const server = await start(await setup())
  const g = await folder(BAR, 'G')
  await bm(g.id, 'g1')
  await bm(g.id, 'g2')
  await settle()
  await browser.bookmarks.removeTree(g.id)
  await settle()
  assert.deepEqual(await queue(), [])
  const seq = server.seq
  await runSync()
  assert.equal(server.seq, seq)
})

test('turning sync off and on again does not duplicate bookmarks', async () => {
  const server = await start(await setup(), async () => {
    const f = await folder(BAR, 'Keep')
    await bm(f.id, 'k1')
    await bm(OTHER, 'k2')
  })
  const count = server.live().length
  await disableSync()
  await enableSync()
  await settle()
  assert.equal(server.live().length, count)
  assert.equal((await localTitles(BAR)).filter((t) => t === 'Keep').length, 1)
})

test('a bookmarklet survives a full resync and is never sent', async () => {
  const server = await start(await setup(), async () => {
    await bm(BAR, 'web')
    await bm(BAR, 'bookmarklet', 'javascript:alert(1)')
  })
  await bm(BAR, 'later bookmarklet', 'javascript:void(0)')
  await settle()
  await runSync()
  server.forceFullResync()
  await runSync()
  await settle()
  assert.ok(await findLocal('bookmarklet'), 'the bulk-pushed bookmarklet must stay in the browser')
  assert.ok(await findLocal('later bookmarklet'), 'the bookmarklet created later must stay in the browser')
  assert.ok(await findLocal('web'))
  assert.ok(!server.requests.some((r) => JSON.stringify(r.body || '').includes('javascript:')))
})

test('a local create the server rejects is kept locally and pushed again', async () => {
  const server = await start(await setup())
  let rejected = false
  server.before = (method, path) => {
    if (method === 'POST' && path === '/me/bookmarks' && !rejected) {
      rejected = true
      return new Response('{"error":"parent is not your live folder"}', { status: 400 })
    }
  }
  await bm(BAR, 'Rejected once')
  await settle()
  await runSync()
  server.before = null
  await settle()
  assert.ok(await findLocal('Rejected once'), 'a rejected create must not delete the local bookmark')
  await runSync()
  assert.ok(server.byTitle('Rejected once'), 'the reconcile must push it again')
})

test('an orphan is retried and forces a full resync on the second cycle', async () => {
  const server = await start(await setup(), () => folder(BAR, 'Parent'))
  const parent = server.byTitle('Parent')
  // The local pair of the parent got lost: its children arrive as orphans.
  const { 'sync.map': map } = await browser.storage.local.get('sync.map')
  const bId = map.s2b[parent.id]
  delete map.s2b[parent.id]
  delete map.b2s[bId]
  await browser.storage.local.set({ 'sync.map': map })

  server.remoteCreate({ parent_id: parent.id, title: 'Orphan', url: 'https://o.example/' })
  await runSync()
  await settle()
  await runSync()
  await settle()
  const orphan = await findLocal('Orphan')
  assert.ok(orphan, 'the orphan must reach the browser after the forced resync')
  assert.equal(orphan.parentId, bId)
})

test('a local edit right after a remote change to the same node is pushed', async () => {
  const server = await start(await setup(), () => bm(BAR, 'Shared'))
  const row = server.byTitle('Shared')
  server.patch(row.id, { title: 'Remote title' })
  await runSync()
  const local = await findLocal('Remote title')
  assert.ok(local)
  // Inside the echo grace window of the apply pass.
  await browser.bookmarks.update(local.id, { title: 'User title' })
  await settle()
  await runSync()
  assert.equal(server.rows.get(row.id).title, 'User title')
})
