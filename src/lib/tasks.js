import browser from 'webextension-polyfill'
import { setBadgeTasks } from './badge.js'

export const POLL_ALARM = 'saved-poll'

export async function getTasks() {
  const { tasks } = await browser.storage.local.get('tasks')
  return { active: [], recent: [], ...(tasks || {}) }
}

// Every change to the task list goes through here: submit, poll, cancel and
// the popup would otherwise save stale copies over each other. The poll alarm
// is switched under the same lock, so it can't be cleared right after a submit
// has armed it.
export function updateTasks(fn) {
  return navigator.locks.request('dd-tasks', async () => {
    const tasks = await getTasks()
    const result = await fn(tasks)
    await browser.storage.local.set({ tasks })
    await setBadgeTasks(tasks.active.length)
    if (tasks.active.length) {
      const alarm = await browser.alarms.get(POLL_ALARM)
      if (!alarm) await browser.alarms.create(POLL_ALARM, { periodInMinutes: 1, when: Date.now() + 5000 })
    } else {
      await browser.alarms.clear(POLL_ALARM)
    }
    return result
  })
}
