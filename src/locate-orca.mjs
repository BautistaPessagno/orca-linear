// Finds the `orca` executable from inside a plugin worker. The worker runs as Orca's own helper
// process with a reduced environment (HOME, PATH, TMPDIR), so the surest path is the CLI shipped
// in the Orca that runs it: Orca.app/Contents/Resources/bin/orca on macOS, resources/bin/orca
// next to the executable elsewhere. See docs/research/linear-backends.md.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { LinearError, MESSAGES } from './errors.mjs'

function derived(execPath, platform) {
  if (typeof execPath !== 'string' || !execPath) return null
  if (platform === 'darwin') {
    const at = execPath.indexOf('.app/')
    return at < 0 ? null : `${execPath.slice(0, at + 4)}/Contents/Resources/bin/orca`
  }
  const sep = platform === 'win32' ? '\\' : '/'
  const dir = execPath.slice(0, execPath.lastIndexOf(sep))
  return dir ? [dir, 'resources', 'bin', platform === 'win32' ? 'orca.cmd' : 'orca'].join(sep) : null
}

export function candidatePaths({ setting, execPath = process.execPath, platform = process.platform, env = process.env, home = env.HOME ?? '' }) {
  const sep = platform === 'win32' ? '\\' : '/'
  const name = platform === 'win32' ? 'orca.cmd' : 'orca'
  const onPath = String(env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .map((dir) => `${dir.replace(/[\\/]$/, '')}${sep}${name}`)
  const wellKnown =
    platform === 'darwin'
      ? ['/Applications/Orca.app/Contents/Resources/bin/orca', `${home}/Applications/Orca.app/Contents/Resources/bin/orca`, '/usr/local/bin/orca', `${home}/.local/bin/orca`]
      : platform === 'win32'
        ? [`${env.LOCALAPPDATA ?? `${home}\\AppData\\Local`}\\Programs\\Orca\\resources\\bin\\orca.cmd`]
        : ['/usr/local/bin/orca', '/usr/bin/orca', `${home}/.local/bin/orca`, '/opt/Orca/resources/bin/orca']
  const all = [typeof setting === 'string' && setting.trim() ? setting.trim() : null, derived(execPath, platform), ...onPath, ...wellKnown]
  return [...new Set(all.filter(Boolean))]
}

const versionProbe = (path) =>
  new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(!error && /\d+\.\d+/.test(String(stdout))))
  })

export async function locateOrca({ exists = existsSync, probe = versionProbe, ...options } = {}) {
  for (const path of candidatePaths(options)) {
    if (exists(path) && (await probe(path))) return path
  }
  throw new LinearError('no-cli', MESSAGES.noCli)
}
