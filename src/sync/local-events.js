import browser from 'webextension-polyfill'
import { uuidv4 } from '../lib/uuid.js'
import { loadMap, saveMap, withMapLock, setPair, removePairByBrowser, isRootBrowserId } from './mapping.js'
import { enqueue, enqueueDelete } from './queue.js'
import { bufferEvent, graceExpectations, isEcho } from './apply.js'
import { isSyncable } from './limits.js'

export const PUSH_ALARM = 'sync-push'

async function syncEnabled() {
  const { settings, 'sync.meta': meta } = await browser.storage.local.get(['settings', 'sync.meta'])
  return Boolean(settings?.syncEnabled && meta?.initialized)
}

function schedulePush() {
  return browser.alarms.create(PUSH_ALARM, { when: Date.now() + 5000 })
}

// Events are handled one at a time in arrival order: a bulk import fires
// hundreds of onCreated at once, and a child must see its parent's pair.
let chain = Promise.resolve()

// expected: what an apply pass left the nodes like; an event matching it is
// that pass's echo and is dropped.
function dispatch(ev, expected = null) {
  const run = chain
    .then(async () => {
      if (await isEcho(eventNodeId(ev), expected)) return
      await handleEvent(ev)
    })
    .catch(() => {})
  chain = run
  return run
}

function eventNodeId(ev) {
  return ev.type === 'created' ? ev.node.id : ev.id
}

// Queues create ops for a browser subtree whose parent is already mapped.
async function enqueueCreates(map, node, parentServerId) {
  if (node.type === 'separator' || !isSyncable(node)) return
  const serverId = uuidv4()
  setPair(map, node.id, serverId)
  await enqueue({
    op: 'create',
    serverId,
    payload: {
      id: serverId,
      parent_id: parentServerId,
      is_folder: !node.url,
      title: node.title || '',
      url: node.url || '',
      position: node.index ?? 0,
    },
    ts: Date.now(),
  })
  for (const child of node.children || []) await enqueueCreates(map, child, serverId)
}

async function subtree(id) {
  try {
    const [node] = await browser.bookmarks.getSubTree(id)
    return node
  } catch {
    return null
  }
}

// Pairs of a removed subtree. onRemoved carries the children in Chromium; where
// it does not, stale pairs are pruned by the next full reconcile.
function forgetRemoved(map, node) {
  const ids = []
  const walk = (n) => {
    const sid = map.b2s[n.id]
    if (sid) ids.push(sid)
    removePairByBrowser(map, n.id)
    for (const c of n.children || []) walk(c)
  }
  walk(node)
  return ids
}

export async function handleEvent(ev) {
  if (!(await syncEnabled())) return
  const changed = await withMapLock(async () => {
    const map = await loadMap()
    switch (ev.type) {
      case 'created': {
        const node = ev.node
        if (node.id in map.b2s || isRootBrowserId(map, node.id)) return false
        const parentServerId = map.b2s[node.parentId]
        // Parent outside the synced tree (managed folder, skipped node).
        if (!parentServerId) return false
        // A folder moved in from elsewhere arrives with children only via getSubTree.
        const full = (!node.url && (await subtree(node.id))) || node
        await enqueueCreates(map, full, parentServerId)
        await saveMap(map)
        return true
      }
      case 'changed': {
        const serverId = map.b2s[ev.id]
        if (!serverId || isRootBrowserId(map, ev.id)) return false
        const node = await subtree(ev.id)
        if (node && !isSyncable(node)) {
          // Edited into something the server refuses: local-only from now on.
          const [top, ...rest] = forgetRemoved(map, node)
          await saveMap(map)
          await enqueueDelete(top, rest)
          return true
        }
        const payload = {}
        if (ev.info.title !== undefined) payload.title = ev.info.title
        if (ev.info.url !== undefined) payload.url = ev.info.url
        await enqueue({ op: 'update', serverId, payload, ts: Date.now() })
        return true
      }
      case 'moved': {
        if (isRootBrowserId(map, ev.id)) return false
        const serverId = map.b2s[ev.id]
        const parentServerId = map.b2s[ev.info.parentId]
        if (serverId && parentServerId) {
          await enqueue({
            op: 'move',
            serverId,
            payload: { parent_id: parentServerId, position: ev.info.index },
            ts: Date.now(),
          })
          return true
        }
        if (serverId) {
          // Moved out of the synced tree: gone for the other browsers.
          const node = (await subtree(ev.id)) || { id: ev.id }
          const [top, ...rest] = forgetRemoved(map, node)
          await saveMap(map)
          await enqueueDelete(top, rest)
          return true
        }
        if (parentServerId) {
          // Moved into the synced tree from an unsynced place.
          const node = await subtree(ev.id)
          if (!node) return false
          await enqueueCreates(map, node, parentServerId)
          await saveMap(map)
          return true
        }
        return false
      }
      case 'removed': {
        if (isRootBrowserId(map, ev.id)) return false
        const serverId = map.b2s[ev.id]
        const node = ev.info?.node ? { ...ev.info.node, id: ev.id } : { id: ev.id }
        const ids = forgetRemoved(map, node)
        await saveMap(map)
        if (!serverId) return false
        await enqueueDelete(serverId, ids.filter((x) => x !== serverId))
        return true
      }
    }
    return false
  })
  if (changed) await schedulePush()
}

function listen(ev) {
  if (bufferEvent(ev)) return
  dispatch(ev, graceExpectations())
}

export function registerListeners() {
  browser.bookmarks.onCreated.addListener((id, node) => listen({ type: 'created', id, node }))
  browser.bookmarks.onChanged.addListener((id, info) => listen({ type: 'changed', id, info }))
  browser.bookmarks.onMoved.addListener((id, info) => listen({ type: 'moved', id, info }))
  browser.bookmarks.onRemoved.addListener((id, info) => listen({ type: 'removed', id, info }))
}

// Resolves once every event dispatched so far has been handled.
export function eventsIdle() {
  return chain
}

// Replays events buffered during an apply pass, in order and ahead of any
// newer event, minus the echoes of the pass itself.
export function processBuffered(buffered, expected) {
  let last = chain
  for (const ev of buffered) last = dispatch(ev, expected)
  return last
}
