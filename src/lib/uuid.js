export function uuidv4() {
  return crypto.randomUUID()
}

function parseUUID(s) {
  const hex = s.replace(/-/g, '')
  const b = new Uint8Array(16)
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return b
}

function formatUUID(b) {
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Deterministic ids for bookmark root folders: every browser of the same user
// derives the same server id from (userId, "roots/<alias>").
export async function uuidv5(namespaceUUID, name) {
  const ns = parseUUID(namespaceUUID)
  const nameBytes = new TextEncoder().encode(name)
  const data = new Uint8Array(ns.length + nameBytes.length)
  data.set(ns)
  data.set(nameBytes, ns.length)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', data))
  const b = hash.slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  return formatUUID(b)
}
