import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAvatars } from '../src/avatars.mjs'

const image = (type, size) => ({ ok: true, headers: new Map([['content-type', type]]), arrayBuffer: async () => new Uint8Array(size).buffer })

test('fetches only avatar URLs it handed out', async () => {
  const fetched = []
  const avatars = createAvatars({ fetchImpl: async (url) => (fetched.push(url), image('image/png', 10)) })
  assert.equal(await avatars.get('https://example.com/anything.png'), null)
  avatars.remember({ issues: [{ assignee: { avatarUrl: 'https://public.linear.app/a.png' } }, { assignee: { avatarUrl: 'http://insecure/b.png' } }] })
  assert.match(await avatars.get('https://public.linear.app/a.png'), /^data:image\/png;base64,/)
  assert.equal(await avatars.get('http://insecure/b.png'), null)
  await avatars.get('https://public.linear.app/a.png')
  assert.deepEqual(fetched, ['https://public.linear.app/a.png'])
})

test('refuses non-images and big files', async () => {
  let reply
  const avatars = createAvatars({ fetchImpl: async () => reply })
  avatars.remember({ avatarUrl: 'https://x.test/1' })
  avatars.remember({ avatarUrl: 'https://x.test/2' })
  reply = image('text/html', 10)
  assert.equal(await avatars.get('https://x.test/1'), null)
  reply = image('image/jpeg', 100 * 1024)
  assert.equal(await avatars.get('https://x.test/2'), null)
})
