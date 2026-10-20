import browser from 'webextension-polyfill'
import { request, ApiError, isTransient } from '../lib/api.js'
import { getSettings, setSettings } from '../lib/settings.js'
import { loadMap, saveMap, withMapLock, removePairByServer } from './mapping.js'
import { loadQueue, takeHead, removeOp, dropForServerIds, clearQueue } from './queue.js'
import { beginApplying, endApplying, applyItems } from './apply.js'
import { processBuffered, PUSH_ALARM } from './local-events.js'
import { getMeta, setMeta } from './meta.js'
import * as reconcile from './reconcile.js'

export const PULL_ALARM = 'sync-pull'

// Every entry point below runs in the background context (options and popup
// ask it by message), serialized by a lock a dying context releases.
function withSyncLock(fn) {
  return navigator.locks.request('dd-sync', fn)
}

async function syncReady() {
  const { syncEnabled } = await getSettings()
  const meta = await getMeta()
  return syncEnabled && meta.initialized
}

// One sync cycle: pull changes, resolve conflicts against the local queue, apply
// to the browser, push the queue.
export function runSync() {
  return withSyncLock(async () => {
    if (!(await syncReady())) return
    try {
      const meta = await getMeta()
      await pullAndApply(meta)
      await pushQueue()
      await setMeta({ lastSyncAt: Date.now(), lastError: '' })
    } catch (e) {
      await setMeta({ lastError: e.message })
      if (isTransient(e)) return
      throw e
    }
  })
}

// Orphans (items whose parent is not mapped yet) are kept past the cursor and
// retried with every page; still orphaned a cycle later, they force a full
// reconcile. After a full reconcile the cursor is its own, never the feed's.
async function pullAndApply(meta) {
  let cursor = meta.cursor || 0
  const { 'sync.orphans': prev = [] } = await browser.storage.local.get('sync.orphans')
  let orphans = prev
  for (;;) {
    const feed = await request(`/me/bookmarks/changes?since=${cursor}`)
    if (feed.full_resync) {
      await reconcile.full()
      return
    }
    const fresh = new Set(feed.items.map((i) => i.id))
    const items = [...orphans.filter((o) => !fresh.has(o.id)), ...feed.items]
    if (items.length) {
      const result = await applyFeedItems(items)
      if (result.needsFull) {
        await reconcile.full()
        return
      }
      orphans = result.orphans
    }
    cursor = feed.cursor
    await setMeta({ cursor })
    if (!feed.has_more) break
  }
  await browser.storage.local.set({ 'sync.orphans': orphans })
  const prevIds = new Set(prev.map((o) => o.id))
  if (orphans.some((o) => prevIds.has(o.id))) await reconcile.full()
}

async function applyFeedItems(items) {
  const queue = await loadQueue()
  const opByServerId = new Map(queue.map((op) => [op.serverId, op]))

  const toApply = []
  const dropOps = []
  for (const item of items) {
    const op = opByServerId.get(item.id)
    if (!op) {
      toApply.push(item)
      continue
    }
    if (item.deleted) {
      dropOps.push(item.id)
      toApply.push(item)
      continue
    }
    if (op.op === 'delete') {
      continue
    }
    // Last writer wins per node; the local timestamp is the browser clock.
    const serverTs = Date.parse(item.updated_at) || 0
    if (serverTs > op.ts) {
      dropOps.push(item.id)
      toApply.push(item)
    }
  }
  if (dropOps.length) await dropForServerIds(dropOps)

  if (!toApply.length) return { orphans: [], needsFull: false }
  beginApplying()
  let result
  try {
    result = await withMapLock(async () => {
      const map = await loadMap()
      const r = await applyItems(toApply, map)
      await saveMap(map)
      return r
    })
  } finally {
    const { expected, buffered } = endApplying()
    await processBuffered(buffered, expected)
  }
  return result
}

// An op leaves the queue only once the server accepted it (or rejected it for
// good). Transient failures — network, 5xx, 429, lost pairing or host
// permission — keep it for the next cycle. A rejected create also loses its
// pair: the node is then unmapped, and the reconcile pushes it again instead
// of taking it for deleted on the server.
async function pushQueue() {
  let needsResync = false
  for (;;) {
    const op = await takeHead()
    if (!op) break
    try {
      await pushOne(op)
    } catch (e) {
      if (!(e instanceof ApiError) || isTransient(e)) throw e
      needsResync = true
      if (op.op === 'create') await forgetPair(op.serverId)
    }
    await removeOp(op.opId)
  }
  if (needsResync) await reconcile.full()
}

function forgetPair(serverId) {
  return withMapLock(async () => {
    const map = await loadMap()
    removePairByServer(map, serverId)
    await saveMap(map)
  })
}

async function pushOne(op) {
  switch (op.op) {
    case 'create': {
      const body = { ...op.payload }
      if (!body.parent_id) delete body.parent_id
      await request('/me/bookmarks', { method: 'POST', body })
      break
    }
    case 'update':
    case 'move':
      await request(`/me/bookmarks/${op.serverId}`, { method: 'PATCH', body: op.payload })
      break
    case 'delete':
      try {
        await request(`/me/bookmarks/${op.serverId}`, { method: 'DELETE' })
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return
        throw e
      }
      break
  }
}

export async function enableSync() {
  await withSyncLock(async () => {
    await setSettings({ syncEnabled: true })
    try {
      await reconcile.initialize()
    } catch (e) {
      await setSettings({ syncEnabled: false })
      throw e
    }
  })
  await browser.alarms.create(PULL_ALARM, { periodInMinutes: 5 })
  await runSync()
}

// Changes made while sync is off are not tracked, so the pairing state is
// dropped: turning sync back on is a fresh adopt-merge, not a replay.
export async function disableSync() {
  await withSyncLock(async () => {
    await setSettings({ syncEnabled: false })
    await browser.alarms.clear(PULL_ALARM)
    await browser.alarms.clear(PUSH_ALARM)
    await withMapLock(() => browser.storage.local.remove(['sync.map', 'sync.orphans']))
    await clearQueue()
    await setMeta({ initialized: false, cursor: 0 })
  })
}

export function fullResync() {
  return withSyncLock(async () => {
    if (!(await syncReady())) return
    await reconcile.full()
  })
}
