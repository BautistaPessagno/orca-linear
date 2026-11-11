import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidatePaths, locateOrca } from '../src/locate-orca.mjs'

const MAC_HELPER = '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'

test('derives the CLI of the Orca that runs the worker on macOS', () => {
  const paths = candidatePaths({ execPath: '/Users/pat/Apps/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper', platform: 'darwin', env: { PATH: '' }, home: '/Users/pat' })
  assert.equal(paths[0], '/Users/pat/Apps/Orca.app/Contents/Resources/bin/orca')
})

test('derives the CLI next to the executable on Linux and Windows', () => {
  assert.equal(candidatePaths({ execPath: '/opt/Orca/orca', platform: 'linux', env: {}, home: '/home/pat' })[0], '/opt/Orca/resources/bin/orca')
  assert.equal(candidatePaths({ execPath: 'C:\\Program Files\\Orca\\Orca.exe', platform: 'win32', env: {}, home: 'C:\\Users\\pat' })[0], 'C:\\Program Files\\Orca\\resources\\bin\\orca.cmd')
})

test('the setting comes first, then the derived path, PATH and well-known places', () => {
  const paths = candidatePaths({ setting: '/custom/orca', execPath: MAC_HELPER, platform: 'darwin', env: { PATH: '/usr/local/bin:/opt/homebrew/bin' }, home: '/Users/pat' })
  assert.deepEqual(paths.slice(0, 4), ['/custom/orca', '/Applications/Orca.app/Contents/Resources/bin/orca', '/usr/local/bin/orca', '/opt/homebrew/bin/orca'])
  assert.ok(paths.includes('/Users/pat/Applications/Orca.app/Contents/Resources/bin/orca'))
  assert.equal(new Set(paths).size, paths.length)
})

test('picks the first candidate that answers --version', async () => {
  const probed = []
  const found = await locateOrca({
    execPath: MAC_HELPER,
    platform: 'darwin',
    env: { PATH: '/usr/local/bin' },
    home: '/Users/pat',
    exists: (p) => p !== '/Applications/Orca.app/Contents/Resources/bin/orca',
    probe: async (p) => (probed.push(p), p === '/usr/local/bin/orca')
  })
  assert.equal(found, '/usr/local/bin/orca')
  assert.deepEqual(probed, ['/usr/local/bin/orca'])
})

test('says how to fix it when no Orca CLI is found', async () => {
  await assert.rejects(
    locateOrca({ execPath: '/x/node', platform: 'linux', env: {}, home: '/h', exists: () => false, probe: async () => true }),
    (error) => error.kind === 'no-cli' && /Orca CLI path/.test(error.message)
  )
})
