// In-memory stand-in for the WebExtension API surface the extension uses,
// Chromium flavoured (roots "1" bookmarks bar, "2" other, "3" mobile). Bookmark
// events are dispatched on a later macrotask, like the real browsers do.

function event() {
  const listeners = new Set()
  return {
    addListener: (f) => listeners.add(f),
    removeListener: (f) => listeners.delete(f),
    hasListener: (f) => listeners.has(f),
    fire: (...args) => { for (const f of listeners) f(...args) },
  }
}

const clone = (v) => (v === undefined ? v : structuredClone(v))
// Storage calls are IPC in a real browser: they resolve on a later macrotask,
// which is what lets concurrent read-modify-write cycles interleave.
const ipc = () => new Promise((r) => setImmediate(r))

function storageArea(onChanged, areaName) {
  let data = {}
  return {
    async get(keys) {
      await ipc()
      if (keys == null) return clone(data)
      const out = {}
      if (typeof keys === 'string') keys = [keys]
      if (Array.isArray(keys)) {
        for (const k of keys) if (k in data) out[k] = clone(data[k])
      } else {
        for (const [k, d] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : d
      }
      return out
    },
    async set(obj) {
      await ipc()
      const changes = {}
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k], newValue: clone(v) }
        data[k] = clone(v)
      }
      onChanged.fire(changes, areaName)
    },
    async remove(keys) {
      await ipc()
      for (const k of [].concat(keys)) delete data[k]
    },
    async clear() {
      data = {}
    },
    reset() {
      data = {}
    },
  }
}

function bookmarksApi() {
  const onCreated = event()
  const onChanged = event()
  const onMoved = event()
  const onRemoved = event()
  let nodes
  let nextId

  function reset() {
    nodes = new Map()
    nodes.set('0', { id: '0', title: '', children: ['1', '2', '3'] })
    nodes.set('1', { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [] })
    nodes.set('2', { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] })
    nodes.set('3', { id: '3', parentId: '0', title: 'Mobile bookmarks', folderType: 'mobile', children: [] })
    nextId = 100
  }
  reset()

  const later = (f) => setTimeout(f, 0)
  const must = (id) => {
    const n = nodes.get(String(id))
    if (!n) throw new Error(`Can't find bookmark for id ${id}`)
    return n
  }
  const info = (n) => {
    const out = { id: n.id, title: n.title, dateAdded: 0 }
    if (n.parentId !== undefined) {
      out.parentId = n.parentId
      out.index = nodes.get(n.parentId).children.indexOf(n.id)
    }
    if (n.url !== undefined) out.url = n.url
    if (n.folderType) out.folderType = n.folderType
    return out
  }
  const tree = (n) => {
    const out = info(n)
    if (n.children) out.children = n.children.map((c) => tree(nodes.get(c)))
    return out
  }
  const detach = (n) => {
    const siblings = nodes.get(n.parentId).children
    const index = siblings.indexOf(n.id)
    siblings.splice(index, 1)
    return index
  }
  const drop = (n) => {
    for (const c of n.children || []) drop(nodes.get(c))
    nodes.delete(n.id)
  }

  return {
    onCreated, onChanged, onMoved, onRemoved, reset,
    async getTree() { return [tree(nodes.get('0'))] },
    async getSubTree(id) { return [tree(must(id))] },
    async get(ids) { return [].concat(ids).map((id) => info(must(id))) },
    async getChildren(id) { return (must(id).children || []).map((c) => info(nodes.get(c))) },
    async create({ parentId = '2', title = '', url, index }) {
      const parent = must(parentId)
      if (!parent.children) throw new Error('Parent is not a folder')
      const id = String(nextId++)
      const n = { id, parentId: parent.id, title }
      if (url !== undefined) n.url = url
      else n.children = []
      nodes.set(id, n)
      const at = index === undefined ? parent.children.length : Math.min(index, parent.children.length)
      parent.children.splice(at, 0, id)
      const created = info(n)
      later(() => onCreated.fire(id, created))
      return info(n)
    },
    async update(id, changes) {
      const n = must(id)
      if (changes.title !== undefined) n.title = changes.title
      if (changes.url !== undefined) n.url = changes.url
      const ev = { title: n.title, ...(n.url !== undefined ? { url: n.url } : {}) }
      later(() => onChanged.fire(n.id, ev))
      return info(n)
    },
    async move(id, { parentId, index }) {
      const n = must(id)
      const oldParentId = n.parentId
      const oldIndex = detach(n)
      const parent = must(parentId ?? oldParentId)
      const at = index === undefined ? parent.children.length : Math.min(index, parent.children.length)
      parent.children.splice(at, 0, n.id)
      n.parentId = parent.id
      const ev = { parentId: parent.id, index: at, oldParentId, oldIndex }
      later(() => onMoved.fire(n.id, ev))
      return info(n)
    },
    async remove(id) {
      const n = must(id)
      if (n.children?.length) throw new Error("Can't remove non-empty folder")
      return this.removeTree(id)
    },
    async removeTree(id) {
      const n = must(id)
      const node = tree(n)
      const parentId = n.parentId
      const index = detach(n)
      drop(n)
      later(() => onRemoved.fire(n.id, { parentId, index, node }))
    },
  }
}

function alarmsApi() {
  let alarms = new Map()
  return {
    onAlarm: event(),
    async create(name, info) { alarms.set(name, { name, ...info }) },
    async get(name) { return alarms.get(name) },
    async getAll() { return [...alarms.values()] },
    async clear(name) { return alarms.delete(name) },
    async clearAll() { alarms = new Map() },
    reset() { alarms = new Map() },
  }
}

const storageChanged = event()
const badge = { text: '', color: '' }
const notifications = []

const browser = {
  storage: {
    local: storageArea(storageChanged, 'local'),
    session: storageArea(storageChanged, 'session'),
    onChanged: storageChanged,
  },
  bookmarks: bookmarksApi(),
  alarms: alarmsApi(),
  action: {
    async setBadgeText({ text }) { badge.text = text },
    async setBadgeBackgroundColor({ color }) { badge.color = color },
  },
  notifications: {
    async create(opts) { notifications.push(opts); return String(notifications.length) },
  },
  permissions: {
    async contains() { return true },
    async request() { return true },
  },
  runtime: {
    getURL: (p) => `ext://dd/${p}`,
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
    async sendMessage() {},
  },
  i18n: { getUILanguage: () => 'en' },
}

export const fake = {
  badge,
  notifications,
  reset() {
    browser.storage.local.reset()
    browser.storage.session.reset()
    browser.bookmarks.reset()
    browser.alarms.reset()
    badge.text = ''
    badge.color = ''
    notifications.length = 0
  },
}

export default browser
