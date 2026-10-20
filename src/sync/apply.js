import browser from 'webextension-polyfill'
import { setPair, removePairByServer, removePairByBrowser, isRootServerId, isForeignServerId } from './mapping.js'

// Echo suppression. Apply passes and the bookmark listeners both run in the
// background context, so the state lives in memory: if the context dies, the
// apply pass dies with it. A pass records the state it gave each node (null =
// removed). Events that arrive during the pass are buffered and replayed
// afterwards; a short grace window covers events the browser dispatches after
// the API call resolved. Either way an event on a recorded node is an echo only
// while the node still looks the way the pass left it — a user edit to the same
// node in the meantime is a real change.
const ECHO_GRACE_MS = 2000
const state = { active: false, expected: new Map(), events: [], grace: new Map(), graceUntil: 0 }

export function beginApplying() {
  state.active = true
  state.expected = new Map()
  state.events = []
}

// fields: the properties the pass set ({ title, url, parentId }), or null.
function expect(browserId, fields) {
  if (!state.active) return
  state.expected.set(browserId, fields && { ...state.expected.get(browserId), ...fields })
}

export function endApplying() {
  const expected = state.expected
  const buffered = state.events
  state.active = false
  state.expected = new Map()
  state.events = []
  state.grace = expected
  state.graceUntil = Date.now() + ECHO_GRACE_MS
  return { expected, buffered }
}

// true = the event was buffered by the running pass.
export function bufferEvent(ev) {
  if (!state.active) return false
  state.events.push(ev)
  return true
}

// The grace-window expectations, or null once the window is over.
export function graceExpectations() {
  return Date.now() < state.graceUntil ? state.grace : null
}

export async function isEcho(browserId, expected) {
  if (!expected?.has(browserId)) return false
  const want = expected.get(browserId)
  let node = null
  try {
    ;[node] = await browser.bookmarks.get(browserId)
  } catch { /* gone */ }
  if (want === null) return !node
  return Boolean(node) && Object.entries(want).every(([k, v]) => (node[k] ?? '') === (v ?? ''))
}

// Removes a browser subtree and forgets the pairs of every node in it.
export async function removeLocalTree(map, browserId) {
  let ids = [browserId]
  try {
    const [sub] = await browser.bookmarks.getSubTree(browserId)
    ids = []
    const walk = (n) => {
      ids.push(n.id)
      for (const c of n.children || []) walk(c)
    }
    walk(sub)
  } catch { /* already gone */ }
  for (const id of ids) {
    expect(id, null)
    removePairByBrowser(map, id)
  }
  try {
    await browser.bookmarks.removeTree(browserId)
  } catch {
    try { await browser.bookmarks.remove(browserId) } catch { /* already gone */ }
  }
}

// Creates whose parent is not mapped yet are retried within the loop (a bulk
// import shares one seq, so parent/child order is not guaranteed). needsFull:
// a folder came out of a foreign subtree, and its contents (unchanged, so not
// in the feed) can only be fetched by a full reconcile.
export async function applyItems(items, map) {
  const ctx = { needsFull: false }
  let pending = items.slice()
  while (pending.length) {
    const next = []
    let progress = false
    for (const item of pending) {
      if (await applyOne(item, map, ctx)) progress = true
      else next.push(item)
    }
    if (!progress) return { orphans: next, needsFull: ctx.needsFull }
    pending = next
  }
  return { orphans: [], needsFull: ctx.needsFull }
}

async function applyOne(item, map, ctx) {
  if (isRootServerId(map, item.id) || map.foreign.includes(item.id)) return true

  const browserId = map.s2b[item.id]

  if (item.deleted) {
    delete map.skip[item.id]
    if (browserId !== undefined) await removeLocalTree(map, browserId)
    removePairByServer(map, item.id)
    return true
  }

  if (item.parent_id && isForeignServerId(map, item.parent_id)) {
    map.skip[item.id] = true
    if (browserId !== undefined) await removeLocalTree(map, browserId)
    return true
  }
  if (item.id in map.skip) {
    delete map.skip[item.id]
    if (item.is_folder) ctx.needsFull = true
  }

  const parentBrowserId = item.parent_id ? map.s2b[item.parent_id] : null
  if (item.parent_id && parentBrowserId === undefined) {
    return false
  }

  if (browserId === undefined) {
    const targetParent = parentBrowserId ?? fallbackRoot(map)
    if (!targetParent) return true
    const siblings = await browser.bookmarks.getChildren(targetParent).catch(() => [])
    const index = Math.max(0, Math.min(item.position ?? 0, siblings.length))
    let node
    try {
      node = await browser.bookmarks.create({
        parentId: targetParent,
        title: item.title,
        ...(item.is_folder ? {} : { url: item.url }),
        index,
      })
    } catch {
      return true
    }
    expect(node.id, observed(node))
    setPair(map, node.id, item.id)
    return true
  }

  let node
  try {
    ;[node] = await browser.bookmarks.get(browserId)
  } catch {
    return true
  }
  const wantUrl = item.is_folder ? undefined : item.url
  if (node.title !== item.title || (wantUrl !== undefined && node.url !== wantUrl)) {
    try {
      const updated = await browser.bookmarks.update(browserId, {
        title: item.title,
        ...(wantUrl !== undefined && node.url !== wantUrl ? { url: wantUrl } : {}),
      })
      expect(browserId, observed(updated))
    } catch { /* invalid url and the like: do not retry-loop */ }
  }
  const wantParent = parentBrowserId ?? node.parentId
  if (node.parentId !== wantParent || node.index !== item.position) {
    const siblings = await browser.bookmarks.getChildren(wantParent).catch(() => [])
    const maxIndex = node.parentId === wantParent ? siblings.length - 1 : siblings.length
    const index = Math.max(0, Math.min(item.position, Math.max(maxIndex, 0)))
    if (node.parentId !== wantParent || node.index !== index) {
      try {
        await browser.bookmarks.move(browserId, { parentId: wantParent, index })
        expect(browserId, { parentId: wantParent })
      } catch { /* target folder gone and the like */ }
    }
  }
  return true
}

// The browser may normalize what it was given (a URL gains its trailing slash),
// so expectations are taken from the node it returned.
function observed(node) {
  return { parentId: node.parentId, title: node.title, ...(node.url ? { url: node.url } : {}) }
}

function fallbackRoot(map) {
  const ids = Object.keys(map.roots)
  return ids[0]
}
