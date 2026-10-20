// Server-side limits (discodrive internal/api/bookmarks.go). A node over them
// would be rejected with a 400 — and a bulk push fails as a whole — so such
// nodes (a data: URL bookmark, say) stay local-only. So do bookmarks that are
// not web links (javascript: bookmarklets, place:, file:): the server refuses
// them on create and silently leaves them out of a bulk import.
const MAX_TITLE_BYTES = 1000
const MAX_URL_BYTES = 4096
export const MAX_BULK_ITEMS = 5000

const enc = new TextEncoder()

function isWebUrl(raw) {
  try {
    const u = new URL(raw)
    return Boolean(u.host) && (u.protocol === 'http:' || u.protocol === 'https:')
  } catch {
    return false
  }
}

export function isSyncable(node) {
  return enc.encode(node.title || '').length <= MAX_TITLE_BYTES
    && enc.encode(node.url || '').length <= MAX_URL_BYTES
    && (!node.url || isWebUrl(node.url))
}
