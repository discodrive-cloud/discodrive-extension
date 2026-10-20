import browser from 'webextension-polyfill'
import { t, localizePage } from '../lib/i18n.js'
import { updateTasks } from '../lib/tasks.js'

const $ = (id) => document.getElementById(id)

function fmtBytes(n) {
  if (n == null) return ''
  const units = t('bytesUnits').split(',')
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

function statusLabel(task) {
  switch (task.status) {
    case 'pending': return t('stQueued')
    case 'processing':
      return task.kind === 'download' && task.bytesDone
        ? `${fmtBytes(task.bytesDone)}${task.sizeBytes ? ' / ' + fmtBytes(task.sizeBytes) : ''}`
        : t('stProcessing')
    case 'done': return t('stDone')
    case 'error': return t('stError')
    default: return task.status
  }
}

const RECENT_LINGER_MS = 4000
let purgeTimer = null

async function purgeFinished() {
  purgeTimer = null
  await updateTasks((tasks) => {
    tasks.recent = []
  })
}

async function renderTasks() {
  const { tasks } = await browser.storage.local.get('tasks')
  const list = [...(tasks?.active || []), ...(tasks?.recent || [])].slice(0, 6)
  if (tasks?.recent?.length && !purgeTimer) {
    purgeTimer = setTimeout(purgeFinished, RECENT_LINGER_MS)
  }
  const ul = $('tasks')
  ul.textContent = ''
  for (const task of list) {
    const li = document.createElement('li')
    const icon = document.createElement('span')
    icon.textContent = task.kind === 'download' ? '⬇️' : '📖'
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = task.title || task.url
    title.title = task.error || task.url
    const st = document.createElement('span')
    st.className = 'st' + (task.status === 'error' ? ' error' : '')
    st.textContent = statusLabel(task)
    li.append(icon, title, st)
    if (task.status === 'pending' || task.status === 'processing') {
      const cancel = document.createElement('button')
      cancel.className = 'cancel'
      cancel.textContent = '✕'
      cancel.title = t('popupCancel')
      cancel.addEventListener('click', async () => {
        cancel.disabled = true
        try {
          await browser.runtime.sendMessage({ type: 'saved-cancel', id: task.id })
          showStatus(t('popupCanceled'))
        } catch (e) {
          showStatus(e.message || t('stError'), true)
          cancel.disabled = false
        }
      })
      li.append(cancel)
    }
    ul.append(li)
  }
}

function showStatus(text, isError = false) {
  const el = $('status')
  el.hidden = false
  el.textContent = text
  el.className = 'status' + (isError ? ' error' : '')
}

async function submitPocket() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    showStatus(t('popupCannotSave'), true)
    return
  }
  try {
    await browser.runtime.sendMessage({ type: 'saved-submit', kind: 'article', url: tab.url, title: tab.title || '', tabId: tab.id })
    showStatus(t('popupSubmittedPocket'))
    await renderTasks()
  } catch (e) {
    showStatus(e.message || t('stError'), true)
  }
}

async function init() {
  await localizePage()
  const { auth } = await browser.storage.local.get('auth')
  const paired = Boolean(auth?.paired)
  $('unpaired').hidden = paired
  $('paired').hidden = !paired
  if (paired) await renderTasks()

  $('pocket').addEventListener('click', submitPocket)
  const openOptions = () => browser.runtime.openOptionsPage()
  $('open-options').addEventListener('click', openOptions)
  $('settings-link').addEventListener('click', (e) => { e.preventDefault(); openOptions() })

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.tasks) renderTasks()
  })
}

init()
