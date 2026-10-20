import browser from 'webextension-polyfill'
import { t, ensureI18n } from '../lib/i18n.js'
import { uuidv5 } from '../lib/uuid.js'
import { request } from '../lib/api.js'
import { setPair } from './mapping.js'

const ROOT_TITLE_KEYS = {
  toolbar: 'rootToolbar',
  menu: 'rootMenu',
  other: 'rootOther',
  mobile: 'rootMobile',
}

const FIREFOX_ROOTS = {
  toolbar_____: 'toolbar',
  menu________: 'menu',
  unfiled_____: 'other',
  mobile______: 'mobile',
}
const CHROMIUM_FOLDER_TYPES = { 'bookmarks-bar': 'toolbar', other: 'other', mobile: 'mobile' }
const CHROMIUM_ID_FALLBACK = { 1: 'toolbar', 2: 'other', 3: 'mobile' }

export async function detectRoots() {
  const [tree] = await browser.bookmarks.getTree()
  const roots = []
  for (const child of tree.children || []) {
    let alias = FIREFOX_ROOTS[child.id]
    if (!alias && child.folderType) alias = CHROMIUM_FOLDER_TYPES[child.folderType]
    if (!alias) alias = CHROMIUM_ID_FALLBACK[child.id]
    if (alias === 'managed' || !alias) continue
    roots.push({ browserId: child.id, alias })
  }
  return roots
}

// Root folders are immutable: never PATCH/DELETE them and never apply server
// deletes/moves to them. Roots this browser lacks become foreign: their
// subtrees stay on the server (see helpBookmarksRoots).
export async function ensureRoots(map, userId) {
  await ensureI18n()
  const roots = await detectRoots()
  const present = new Set(roots.map((r) => r.alias))
  map.foreign = []
  for (const alias of Object.keys(ROOT_TITLE_KEYS)) {
    if (!present.has(alias)) map.foreign.push(await uuidv5(userId, `roots/${alias}`))
  }
  for (const { browserId, alias } of roots) {
    const serverId = await uuidv5(userId, `roots/${alias}`)
    await request('/me/bookmarks', {
      method: 'POST',
      body: { id: serverId, is_folder: true, title: t(ROOT_TITLE_KEYS[alias]) || alias, url: '', position: 0 },
    })
    map.roots[browserId] = serverId
    setPair(map, browserId, serverId)
  }
  return roots
}
