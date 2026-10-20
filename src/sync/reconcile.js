import browser from 'webextension-polyfill'
import { request } from '../lib/api.js'
import { uuidv4 } from '../lib/uuid.js'
import { loadMap, saveMap, withMapLock, setPair, removePairByBrowser } from './mapping.js'
import { ensureRoots } from './roots.js'
import { beginApplying, endApplying, applyItems, removeLocalTree } from './apply.js'
import { processBuffered } from './local-events.js'
import { loadQueue, dropForServerIds } from './queue.js'
import { getMeta, setMeta } from './meta.js'
import { isSyncable, MAX_BULK_ITEMS } from './limits.js'

export async function getServerCursor() {
  const resp = await request(`/me/bookmarks/changes?since=${Number.MAX_SAFE_INTEGER}`)
  return resp.cursor
}

// Pre-order (parents before children), separators and over-limit nodes (with
// their subtrees) left out.
async function snapshotBrowser(map) {
  const out = []
  for (const rootBrowserId of Object.keys(map.roots)) {
    const [subtree] = await browser.bookmarks.getSubTree(rootBrowserId)
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.type === 'separator' || !isSyncable(child)) continue
        out.push({
          browserId: child.id,
          parentBrowserId: node.id,
          isFolder: !child.url,
          title: child.title || '',
          url: child.url || '',
          position: child.index ?? 0,
        })
        if (child.children) walk(child)
      }
    }
    walk(subtree)
  }
  return out
}

async function bulkPush(nodes, map) {
  const items = nodes.map((n) => {
    const id = uuidv4()
    setPair(map, n.browserId, id)
    return { node: n, id }
  })
  const body = items.map(({ node, id }) => ({
    id,
    parent_id: map.b2s[node.parentBrowserId] || null,
    is_folder: node.isFolder,
    title: node.title,
    url: node.isFolder ? '' : node.url,
    position: node.position,
  }))
  // Pre-order is kept across chunks, so every parent lands before its children.
  for (let i = 0; i < body.length; i += MAX_BULK_ITEMS) {
    await request('/me/bookmarks/bulk', { method: 'POST', body: { items: body.slice(i, i + MAX_BULK_ITEMS) } })
  }
}

// Server ids under a foreign root (a root this browser does not have).
function foreignSubtrees(server, foreign) {
  const kids = new Map()
  for (const s of server) {
    const key = s.parent_id || null
    if (!kids.has(key)) kids.set(key, [])
    kids.get(key).push(s.id)
  }
  const skip = {}
  const stack = [...foreign]
  while (stack.length) {
    for (const id of kids.get(stack.pop()) || []) {
      if (id in skip) continue
      skip[id] = true
      stack.push(id)
    }
  }
  return skip
}

// Matches unmapped nodes of both sides level by level, starting from pairs of
// folders that already correspond ([null, null] = server top level, created in
// the fallback root). Unmatched server nodes are created locally, unmatched
// local subtrees are pushed.
function matchTrees(serverNodes, localNodes, map, startPairs) {
  const serverByParent = new Map()
  for (const s of serverNodes) {
    const key = s.parent_id || null
    if (!serverByParent.has(key)) serverByParent.set(key, [])
    serverByParent.get(key).push(s)
  }
  const localByParent = new Map()
  for (const l of localNodes) {
    if (!localByParent.has(l.parentBrowserId)) localByParent.set(l.parentBrowserId, [])
    localByParent.get(l.parentBrowserId).push(l)
  }

  const toCreate = []
  const toPush = []
  const pushSubtree = (l) => {
    toPush.push(l)
    for (const child of localByParent.get(l.browserId) || []) pushSubtree(child)
  }

  const queue = startPairs.slice()
  while (queue.length) {
    const [sParent, bParent] = queue.shift()
    const sKids = serverByParent.get(sParent) || []
    const lFree = new Set(bParent === null ? [] : localByParent.get(bParent) || [])
    for (const s of sKids) {
      let match = null
      for (const l of lFree) {
        if (l.isFolder === s.is_folder && (s.is_folder ? l.title === s.title : l.url === s.url && l.title === s.title)) {
          match = l
          break
        }
      }
      if (match) {
        lFree.delete(match)
        setPair(map, match.browserId, s.id)
        if (s.is_folder) queue.push([s.id, match.browserId])
      } else {
        toCreate.push({ ...s, deleted: false })
        if (s.is_folder) queue.push([s.id, null])
      }
    }
    for (const l of lFree) pushSubtree(l)
  }
  return { toCreate, toPush }
}

// Brings the browser in line with the server list; the server is the source of
// truth. A pair whose server node is gone means it was deleted elsewhere, so
// the local node is removed too — unless its create is still queued. Unmapped
// nodes on either side are merged by matchTrees.
async function reconcileTree(map, server) {
  map.skip = foreignSubtrees(server, map.foreign)
  const serverIds = new Set(server.map((s) => s.id))
  const queue = await loadQueue()
  const pendingCreates = new Set(queue.filter((op) => op.op === 'create').map((op) => op.serverId))

  let local = await snapshotBrowser(map)
  const localIds = new Set(local.map((l) => l.browserId))
  for (const b of Object.keys(map.b2s)) {
    if (!(b in map.roots) && !localIds.has(b)) removePairByBrowser(map, b)
  }
  const gone = Object.entries(map.b2s)
    .filter(([b, s]) => !(b in map.roots) && !pendingCreates.has(s) && (!serverIds.has(s) || s in map.skip))
    .map(([b]) => b)
  for (const b of gone) {
    if (b in map.b2s) await removeLocalTree(map, b)
  }
  if (gone.length) local = await snapshotBrowser(map)

  const rootServerIds = new Set(Object.values(map.roots))
  const live = server.filter((s) => !rootServerIds.has(s.id) && !map.foreign.includes(s.id) && !(s.id in map.skip))
  const unmappedServer = live.filter((s) => !(s.id in map.s2b))
  const mappedServer = live.filter((s) => s.id in map.s2b)
  const unmappedLocal = local.filter((l) => !(l.browserId in map.b2s))

  const localFolders = new Set(local.filter((l) => l.isFolder).map((l) => l.browserId))
  const startPairs = [[null, null]]
  for (const [b, s] of Object.entries(map.b2s)) {
    if (b in map.roots || localFolders.has(b)) startPairs.push([s, b])
  }

  const { toCreate, toPush } = matchTrees(unmappedServer, unmappedLocal, map, startPairs)
  const { orphans } = await applyItems([...mappedServer, ...toCreate], map)
  await bulkPush(toPush, map)
  return orphans
}

// The cursor is taken before the server list: a change made in between is then
// both in the list and in the next pull (applied twice, idempotently) instead
// of in neither.
async function reconcile(fresh) {
  beginApplying()
  try {
    await withMapLock(async () => {
      const map = fresh ? { b2s: {}, s2b: {}, roots: {}, foreign: [], skip: {} } : await loadMap()
      if (fresh) {
        let { userId } = await getMeta()
        if (!userId) {
          userId = (await request('/me')).id
          await setMeta({ userId })
        }
        await ensureRoots(map, userId)
      }
      const cursor = await getServerCursor()
      const server = await request('/me/bookmarks')
      const before = Object.keys(map.s2b)
      const orphans = await reconcileTree(map, server)
      await saveMap(map)
      const unpaired = before.filter((s) => !(s in map.s2b))
      if (unpaired.length) await dropForServerIds(unpaired)
      await setMeta({ cursor, initialized: true, lastError: '' })
      await browser.storage.local.set({ 'sync.orphans': orphans })
    })
  } finally {
    const { expected, buffered } = endApplying()
    await processBuffered(buffered, expected)
  }
}

// Turning sync on: map the roots, then adopt-merge both sides. Nothing local is
// overwritten or removed — the map starts empty, so there are no stale pairs.
export function initialize() {
  return reconcile(true)
}

// Full resync: the server is the source of truth, unmatched local nodes are
// pushed. Running it twice in a row must be a no-op.
export function full() {
  return reconcile(false)
}
