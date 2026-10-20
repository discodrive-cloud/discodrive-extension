import browser from 'webextension-polyfill'

// Every read-modify-write of the queue runs under this lock: bookmark events
// enqueue while pushQueue is sending, and a stale copy saved by either side
// would drop the other's ops.
function withQueueLock(fn) {
  return navigator.locks.request('dd-queue', fn)
}

export async function loadQueue() {
  const { 'sync.queue': q } = await browser.storage.local.get('sync.queue')
  return q || []
}

async function saveQueue(q) {
  await browser.storage.local.set({ 'sync.queue': q })
}

// Coalescing: repeated update/move of one node merge into a pending op; an op
// already being sent (inFlight) is never modified, the change becomes a new op.
export function enqueue(op) {
  return withQueueLock(async () => {
    const q = await loadQueue()
    const entry = { ...op, opId: crypto.randomUUID() }
    if (op.op === 'update' || op.op === 'move') {
      const existing = q.find((x) => !x.inFlight && x.serverId === op.serverId && (x.op === op.op || x.op === 'create'))
      if (existing) {
        existing.payload = { ...existing.payload, ...op.payload }
        existing.ts = op.ts
        await saveQueue(q)
        return
      }
    }
    q.push(entry)
    await saveQueue(q)
  })
}

// Delete of a node (and its known descendants) cancels their pending ops. A
// create that never left the browser means the server never saw the node, so
// the delete itself is not sent either.
export function enqueueDelete(serverId, descendantServerIds = [], ts = Date.now()) {
  return withQueueLock(async () => {
    const q = await loadQueue()
    const ids = new Set([serverId, ...descendantServerIds])
    const unsentCreate = q.some((x) => x.serverId === serverId && x.op === 'create' && !x.inFlight)
    const rest = q.filter((x) => !ids.has(x.serverId))
    if (!unsentCreate) rest.push({ op: 'delete', serverId, payload: {}, ts, opId: crypto.randomUUID() })
    await saveQueue(rest)
  })
}

// Returns the head op marked inFlight, or null for an empty queue.
export function takeHead() {
  return withQueueLock(async () => {
    const q = await loadQueue()
    if (!q.length) return null
    q[0].inFlight = true
    await saveQueue(q)
    return q[0]
  })
}

export function removeOp(opId) {
  return withQueueLock(async () => {
    const q = await loadQueue()
    await saveQueue(q.filter((x) => x.opId !== opId))
  })
}

export function dropForServerIds(serverIds) {
  const set = new Set(serverIds)
  return withQueueLock(async () => {
    const q = await loadQueue()
    await saveQueue(q.filter((x) => !set.has(x.serverId)))
  })
}

export function clearQueue() {
  return withQueueLock(() => saveQueue([]))
}
