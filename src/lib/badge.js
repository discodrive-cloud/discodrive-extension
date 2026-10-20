import browser from 'webextension-polyfill'

export async function setBadgeUnpaired() {
  await browser.action.setBadgeText({ text: '!' })
  await browser.action.setBadgeBackgroundColor({ color: '#dc2626' })
}

export async function setBadgeTasks(n) {
  await browser.action.setBadgeText({ text: n > 0 ? String(n) : '' })
  await browser.action.setBadgeBackgroundColor({ color: '#6366f1' })
}

export async function clearBadge() {
  await browser.action.setBadgeText({ text: '' })
}

// Back from the unpaired "!": show the task counter again.
export async function restoreBadge() {
  const { tasks } = await browser.storage.local.get('tasks')
  await setBadgeTasks(tasks?.active?.length || 0)
}
