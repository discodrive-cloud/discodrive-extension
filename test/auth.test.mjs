import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup, browser, fake } from './helpers.mjs'
import { request } from '../src/lib/api.js'

test('credentials are never sent to a server other than the one that issued them', async () => {
  const server = await setup()
  const { settings } = await browser.storage.local.get('settings')
  await browser.storage.local.set({ settings: { ...settings, baseUrl: 'https://evil.test' } })
  const hosts = []
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).host)
    return new Response('{}', { status: 401 })
  }
  await assert.rejects(request('/me'), (e) => e.kind === 'not-paired')
  assert.deepEqual(hosts.filter((h) => h === 'evil.test'), [])
  assert.ok(server)
})

test('a failing token exchange (503, network) does not mark the device unpaired', async () => {
  const server = await setup()
  server.jwt = 'jwt-rotated'
  server.tokenStatus = 503
  await assert.rejects(request('/me'), (e) => e.status === 503)
  let { auth } = await browser.storage.local.get('auth')
  assert.equal(auth.paired, true)
  assert.notEqual(fake.badge.text, '!')

  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(request('/me'), (e) => e.kind === 'network')
  ;({ auth } = await browser.storage.local.get('auth'))
  assert.equal(auth.paired, true)
})

test('a rejected device token unpairs; a later successful exchange clears the badge', async () => {
  const server = await setup()
  const good = server.deviceToken
  server.jwt = 'jwt-rotated'
  server.deviceToken = 'revoked'
  await assert.rejects(request('/me'), (e) => e.kind === 'not-paired')
  assert.equal((await browser.storage.local.get('auth')).auth.paired, false)
  assert.equal(fake.badge.text, '!')

  server.deviceToken = good
  assert.deepEqual(await request('/me'), { id: server.userId })
  assert.equal((await browser.storage.local.get('auth')).auth.paired, true)
  assert.equal(fake.badge.text, '')
})
