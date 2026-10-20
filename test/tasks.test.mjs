import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup, browser } from './helpers.mjs'
import * as saved from '../src/lib/saved.js'

async function active() {
  const { tasks } = await browser.storage.local.get('tasks')
  return (tasks?.active || []).map((x) => x.url)
}

test('a download submitted while a poll is running is not dropped', async () => {
  const server = await setup()
  await saved.submit('download', 'https://f.example/one.zip')
  let submitted = false
  server.before = async (method, path) => {
    if (method === 'GET' && path.startsWith('/me/saved/') && !submitted) {
      submitted = true
      await saved.submit('download', 'https://f.example/two.zip')
    }
  }
  await saved.poll()
  assert.deepEqual((await active()).sort(), ['https://f.example/one.zip', 'https://f.example/two.zip'])
  assert.ok(await browser.alarms.get(saved.POLL_ALARM), 'polling continues for the new task')
})

test('finished tasks move to recent and stop the polling', async () => {
  const server = await setup()
  const item = await saved.submit('download', 'https://f.example/done.zip')
  server.saved.get(item.id).status = 'done'
  await saved.poll()
  const { tasks } = await browser.storage.local.get('tasks')
  assert.deepEqual(tasks.active, [])
  assert.equal(tasks.recent[0].status, 'done')
  assert.equal(await browser.alarms.get(saved.POLL_ALARM), undefined)
})
