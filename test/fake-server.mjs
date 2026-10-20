// In-memory DiscoDrive server: the bookmark and saved-items contract of
// discodrive internal/api (bookmarks.go, saved.go, handlers.go), enough for
// the extension's sync and task code.
import { readFileSync } from 'node:fs'

const LOCALES = new URL('../src/_locales/', import.meta.url)
export const BASE = 'https://dd.test'

function isWebURL(raw) {
  try {
    const u = new URL(raw)
    return Boolean(u.host) && (u.protocol === 'http:' || u.protocol === 'https:')
  } catch {
    return false
  }
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

export class FakeServer {
  constructor() {
    this.userId = '6f1c2d3e-4b5a-4c6d-8e7f-0123456789ab'
    this.deviceToken = 'device-token'
    this.jwt = 'jwt-1'
    this.tokenStatus = 200 // forced status of POST /auth/device/token when != 200
    this.rows = new Map()
    this.seq = 0
    this.gcSeq = 0
    this.saved = new Map()
    this.requests = []
    // Test hooks: before(method, path, body) may return a Response to short-
    // circuit; after(method, path) runs once the response is built.
    this.before = null
    this.after = null
  }

  install() {
    globalThis.fetch = (url, init = {}) => this.fetch(String(url), init)
  }

  async fetch(url, init) {
    if (url.startsWith('ext://dd/_locales/')) {
      const file = new URL(url.slice('ext://dd/_locales/'.length), LOCALES)
      return new Response(readFileSync(file))
    }
    if (!url.startsWith(BASE)) throw new TypeError(`fetch to unexpected host: ${url}`)
    const u = new URL(url)
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    this.requests.push({ method, path: u.pathname + u.search, body, auth: init.headers?.Authorization })
    const early = await this.before?.(method, u.pathname, body)
    if (early) return early
    const resp = this.route(method, u, body, init.headers || {})
    await this.after?.(method, u.pathname)
    return resp
  }

  route(method, u, body, headers) {
    const path = u.pathname
    if (method === 'POST' && path === '/auth/device/token') {
      if (this.tokenStatus !== 200) return json(this.tokenStatus, { error: 'forced' })
      if (body?.device_token !== this.deviceToken) return json(401, { error: 'device not authorized' })
      return json(200, { token: this.jwt })
    }
    if (headers.Authorization !== `Bearer ${this.jwt}`) return json(401, { error: 'unauthorized' })
    if (method === 'GET' && path === '/me') return json(200, { id: this.userId })

    if (path === '/me/bookmarks' && method === 'GET') return json(200, this.list())
    if (path === '/me/bookmarks' && method === 'POST') return this.create(body)
    if (path === '/me/bookmarks/bulk' && method === 'POST') return this.bulk(body.items)
    if (path === '/me/bookmarks/changes' && method === 'GET') return this.changes(Number(u.searchParams.get('since') || 0))
    let m = path.match(/^\/me\/bookmarks\/([^/]+)$/)
    if (m && method === 'PATCH') return this.patch(m[1], body)
    if (m && method === 'DELETE') return this.delete(m[1])

    if (path === '/me/saved' && method === 'POST') {
      const id = `s${this.saved.size + 1}`
      const item = { id, url: body.url, kind: body.kind, title: body.title || '', status: 'pending', bytes_done: 0, size_bytes: null }
      this.saved.set(id, item)
      return json(201, item)
    }
    m = path.match(/^\/me\/saved\/([^/]+)$/)
    if (m && method === 'GET') return this.saved.has(m[1]) ? json(200, this.saved.get(m[1])) : json(404, { error: 'not found' })
    if (m && method === 'DELETE') return this.saved.delete(m[1]) ? json(204) : json(404, { error: 'not found' })
    return json(404, { error: 'no route' })
  }

  // --- bookmark store -----------------------------------------------------

  dto(r) {
    return {
      id: r.id, parent_id: r.parent_id, is_folder: r.is_folder, title: r.title, url: r.url,
      position: r.position, has_favicon: false, updated_at: r.updated_at,
    }
  }

  live() {
    return [...this.rows.values()].filter((r) => !r.deleted)
  }

  list() {
    return this.live()
      .sort((a, b) => (a.parent_id === null ? -1 : b.parent_id === null ? 1 : a.parent_id.localeCompare(b.parent_id))
        || a.position - b.position || a.title.localeCompare(b.title))
      .map((r) => this.dto(r))
  }

  liveFolder(id) {
    const p = this.rows.get(id)
    return p && p.is_folder && !p.deleted
  }

  write(row) {
    // Second precision like the server's RFC3339 updated_at.
    row.updated_at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
    this.rows.set(row.id, row)
  }

  create(b) {
    if (!b.is_folder && !b.url) return json(400, { error: 'url is required for a bookmark' })
    if (!b.is_folder && !isWebURL(b.url)) return json(400, { error: 'url must be an http or https link' })
    if (b.parent_id && !this.liveFolder(b.parent_id)) return json(400, { error: 'parent is not your live folder' })
    const id = b.id || crypto.randomUUID()
    if (this.rows.has(id)) return json(200, this.dto(this.rows.get(id)))
    this.write({
      id, parent_id: b.parent_id || null, is_folder: Boolean(b.is_folder), title: b.title || '',
      url: b.is_folder ? '' : b.url, position: b.position || 0, deleted: false, seq: ++this.seq,
    })
    return json(200, this.dto(this.rows.get(id)))
  }

  // Like the server, non-web links are left out of a bulk import, not refused.
  bulk(items) {
    const seq = ++this.seq
    for (const it of items.filter((x) => x.is_folder || isWebURL(x.url))) {
      this.write({
        id: it.id, parent_id: it.parent_id || null, is_folder: it.is_folder, title: it.title,
        url: it.is_folder ? '' : it.url, position: it.position, deleted: false, seq,
      })
    }
    return json(200, { count: items.length, cursor: seq })
  }

  changes(since) {
    if (since > 0 && since < this.gcSeq) return json(200, { cursor: this.seq, full_resync: true, has_more: false, items: [] })
    const rows = [...this.rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq).slice(0, 1000)
    const hasMore = rows.length === 1000
    return json(200, {
      cursor: hasMore ? rows.at(-1).seq : this.seq,
      full_resync: false,
      has_more: hasMore,
      items: rows.map((r) => ({ ...this.dto(r), deleted: r.deleted, seq: r.seq })),
    })
  }

  subtree(id) {
    const out = [id]
    for (let i = 0; i < out.length; i++) {
      for (const r of this.rows.values()) if (r.parent_id === out[i]) out.push(r.id)
    }
    return out
  }

  patch(id, b) {
    const cur = this.rows.get(id)
    if (!cur || cur.deleted) return json(404, { error: 'not found' })
    if (b.url !== undefined && !isWebURL(b.url)) return json(400, { error: 'url must be an http or https link' })
    if (b.parent_id !== undefined) {
      const parent = b.parent_id || null
      if (parent && !this.liveFolder(parent)) return json(400, { error: 'parent is not your live folder' })
      if (parent && this.subtree(id).includes(parent)) return json(409, { error: 'move would create a cycle' })
      cur.parent_id = parent
    }
    if (b.title !== undefined) cur.title = b.title
    if (b.url !== undefined) cur.url = b.url
    if (b.position !== undefined) cur.position = b.position
    cur.seq = ++this.seq
    this.write(cur)
    return json(200, this.dto(cur))
  }

  delete(id) {
    const ids = this.subtree(id).filter((x) => this.rows.get(x) && !this.rows.get(x).deleted)
    if (!ids.length) return json(404, { error: 'not found' })
    const seq = ++this.seq
    for (const x of ids) {
      const r = this.rows.get(x)
      r.deleted = true
      r.seq = seq
      this.write(r)
    }
    return json(204)
  }

  // --- edits made by "another device" -------------------------------------

  remoteCreate(fields) {
    const id = fields.id || crypto.randomUUID()
    this.write({ id, parent_id: null, is_folder: false, title: '', url: '', position: 0, ...fields, deleted: false, seq: ++this.seq })
    return id
  }

  remoteDelete(id) {
    return this.delete(id)
  }

  // Simulates tombstone GC past every client cursor: the next pull is told to
  // run a full resync.
  forceFullResync() {
    this.gcSeq = this.seq + 1
    this.seq += 1
  }

  byTitle(title) {
    return this.live().find((r) => r.title === title)
  }
}
