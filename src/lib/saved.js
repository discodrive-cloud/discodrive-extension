import browser from 'webextension-polyfill'
import { t, ensureI18n } from './i18n.js'
import { request, ApiError } from './api.js'
import { getTasks, updateTasks, POLL_ALARM } from './tasks.js'

const RECENT_MAX = 5

function notify(title, message) {
  return browser.notifications
    .create({ type: 'basic', iconUrl: browser.runtime.getURL('icons/icon-96.png'), title, message })
    .catch(() => {})
}

// contentHtml (articles) is the text extracted in the browser; cookie (downloads)
// is the browser session for login-protected files.
export async function submit(kind, url, title = '', contentHtml = '', cookie = '') {
  await ensureI18n()
  let item
  try {
    item = await request('/me/saved', {
      method: 'POST',
      body: {
        url, kind, title,
        ...(contentHtml ? { content_html: contentHtml } : {}),
        ...(cookie ? { cookie } : {}),
      },
    })
  } catch (e) {
    await notify(t('notifError'), e.message)
    throw e
  }
  await updateTasks((tasks) => {
    if (!tasks.active.some((x) => x.id === item.id)) {
      tasks.active.push({ id: item.id, kind, url, title: item.title || title || url, status: item.status })
    }
  })
  if (kind === 'download') {
    await notify(t('extName'), t('notifAccepted'))
  }
  return item
}

// Deleting the row aborts a running download server-side; 404 means it already
// finished, which counts as success.
export async function cancel(id) {
  await ensureI18n()
  try {
    await request(`/me/saved/${id}`, { method: 'DELETE' })
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e
  }
  await updateTasks((tasks) => {
    tasks.active = tasks.active.filter((x) => x.id !== id)
  })
}

// The network round trips run outside the task lock; the results are merged
// into the list as it is by then, so a task submitted meanwhile survives. An
// overlapping alarm tick is skipped rather than polling twice.
export function poll() {
  return navigator.locks.request('dd-poll', { ifAvailable: true }, async (lock) => {
    if (!lock) return
    await ensureI18n()
    const { active } = await getTasks()
    const results = new Map()
    for (const task of active) {
      try {
        results.set(task.id, await request(`/me/saved/${task.id}`))
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) results.set(task.id, null)
      }
    }
    const notes = []
    await updateTasks((tasks) => {
      const still = []
      for (const task of tasks.active) {
        if (!results.has(task.id)) {
          still.push(task)
          continue
        }
        const item = results.get(task.id)
        if (item === null) continue
        if (item.status === 'done') {
          notes.push([t('notifDone'), item.title || task.url])
          tasks.recent.unshift({ ...task, status: 'done', title: item.title || task.title, finishedAt: Date.now() })
        } else if (item.status === 'error') {
          notes.push([t('notifError'), `${task.title}\n${item.error || ''}`])
          tasks.recent.unshift({ ...task, status: 'error', error: item.error, finishedAt: Date.now() })
        } else {
          still.push({ ...task, status: item.status, bytesDone: item.bytes_done, sizeBytes: item.size_bytes })
        }
      }
      tasks.active = still
      tasks.recent = tasks.recent.slice(0, RECENT_MAX)
    })
    for (const [title, message] of notes) await notify(title, message)
  })
}

export { getTasks, POLL_ALARM }
