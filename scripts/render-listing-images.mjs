// Renders the plugin directory's images into images/: the cover, the screenshots and the icon.
// Every panel in them is the real panel/index.html talking to the real worker (worker.mjs) in its
// fixture mode, so the issues, teams and people are the made-up ones in scripts/fixture-backend.mjs.
// A small local server runs one worker per panel and answers the panel's `orca.plugin.request`
// calls from it; a dev route (`view`, `issue`, `menu`, `settings`…) moves the panel to the state a
// shot shows. No Linear logo or artwork: the service is named in text only, and the icon is drawn
// here.
//
//   node scripts/render-listing-images.mjs           # all of them
//   node scripts/render-listing-images.mjs cover     # one
//   KEEP=1 node scripts/render-listing-images.mjs    # also print the scene URLs and keep serving
//
// The cover is shown small in Orca's plugin list and cropped to about 1.9:1 around its middle when
// the plugin's link is shared, so what matters stays inside the middle 840 px of height and reads
// at about 500 px wide.
//
// Needs Google Chrome (or set CHROME to a Chrome or Chromium binary).
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import activate from '../worker.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'images')
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WIDTH = 1600
const HEIGHT = 1000
const ACCENT = '#5e6ad2'

// Orca's panel tokens (--orca-*), light and dark.
const THEMES = {
  dark: {
    background: '#0a0a0a', foreground: '#f0f0f0', card: '#0a0a0a', 'card-foreground': '#f0f0f0', popover: '#171717',
    'popover-foreground': '#f0f0f0', 'muted-foreground': '#acacac', border: '#262626', input: '#262626', ring: '#737373',
    destructive: '#ef4444', radius: '6px'
  },
  light: {
    background: '#ffffff', foreground: '#0a0a0a', card: '#ffffff', 'card-foreground': '#0a0a0a', popover: '#ffffff',
    'popover-foreground': '#0a0a0a', 'muted-foreground': '#696969', border: '#e5e5e5', input: '#e5e5e5', ring: '#a1a1a1',
    destructive: '#dc2626', radius: '6px'
  }
}

// ---------- one real worker per panel, in fixture mode ----------

function memory() {
  const values = new Map()
  return {
    get: async (key) => (values.has(key) ? structuredClone(values.get(key)) : null),
    set: async (key, value) => void values.set(key, structuredClone(value)),
    delete: async (key) => void values.delete(key),
    keys: async () => [...values.keys()]
  }
}

function startWorker(fixtures, { onHostCall = () => null } = {}) {
  const handlers = new Map()
  const orca = {
    panels: { handle: (name, fn) => (handlers.set(name, fn), { dispose() {} }), post: () => {} },
    settings: { get: async () => undefined, set: async () => {}, onDidChange: () => ({ dispose() {} }) },
    secrets: memory(),
    storage: memory(),
    host: { call: async (method, params) => onHostCall(method, params) },
    log: () => {}
  }
  const run = async () => {
    throw new Error('No Orca CLI while rendering listing images.')
  }
  activate(orca, { fixtures, run, poll: false })
  return handlers
}

// What the worker puts in the status bar for the made-up issues, for the cover's status bar.
async function statusBarText() {
  let text = null
  const handlers = startWorker({}, { onHostCall: (method, params) => void (method === 'statusBar.update' && (text = params.text)) })
  await handlers.get('issues.list')({ view: 'mine', workspace: 'all' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (!text) throw new Error('The worker set no status bar text for the made-up issues.')
  return text
}
const STATUS = await statusBarText()

const PANEL = readFileSync(join(ROOT, 'panel/index.html'), 'utf8')
const panels = new Map() // id → { theme, handlers }

// The panel as Orca would serve it: theme class and tokens, and a window.orca whose requests go to
// this panel's worker.
function panelDoc(id) {
  const { theme } = panels.get(id)
  const tokens = Object.entries(THEMES[theme]).map(([k, v]) => `--orca-${k}: ${v};`).join(' ')
  const stub = `<style>:root { ${tokens} } html, body { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }</style><script>
    window.orca = Object.freeze({
      plugin: {
        request: function (name, input) {
          return fetch('/p/${id}/rpc', { method: 'POST', body: JSON.stringify({ name: name, input: input }) }).then(function (r) { return r.json() })
        },
        on: function () { return { dispose: function () {} } }
      },
      on: function () { return { dispose: function () {} } },
      storage: { get: function () { return Promise.resolve(null) }, set: function () { return Promise.resolve() }, delete: function () { return Promise.resolve() } },
      shell: { openExternal: function () { return Promise.resolve({ opened: false }) } }
    })
  </script>`
  return PANEL.replace('<html>', `<html class="${theme}">`).replace('<head>', '<head>' + stub)
}

let nextId = 0
// An iframe holding one panel. `route` is the dev route the worker hands the panel (fixture-backend.mjs).
function panel({ theme = 'dark', route = {}, focusBranch, noKeys, width = 380, height = 800, zoom = 1, style = '' } = {}) {
  const id = `p${++nextId}`
  panels.set(id, { theme, handlers: startWorker({ route, focusBranch, noKeys }) })
  return `<div class="frame ${theme}" style="width:${width * zoom}px;height:${height * zoom}px;background:${THEMES[theme].background};${style}">
    <iframe style="width:${width}px;height:${height}px;zoom:${zoom}" src="/p/${id}/panel/index.html"></iframe>
  </div>`
}

// ---------- the pages ----------

function page(body, { theme = 'dark', glow = ACCENT, glow2 = '#26b5ce' } = {}) {
  const t = THEMES[theme]
  const dark = theme === 'dark'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body {
      position: relative;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      color: ${t.foreground};
      background:
        radial-gradient(900px 700px at 74% 34%, color-mix(in srgb, ${glow} ${dark ? 30 : 18}%, transparent), transparent 70%),
        radial-gradient(800px 600px at 6% 100%, color-mix(in srgb, ${glow2} ${dark ? 14 : 10}%, transparent), transparent 70%),
        ${dark ? '#08080b' : '#f4f4f7'};
    }
    .frame { border-radius: 16px; overflow: hidden; flex: none;
      border: 1px solid ${dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.09)'};
      box-shadow: 0 50px 100px -30px rgba(0,0,0,${dark ? 0.85 : 0.28}), 0 2px 8px rgba(0,0,0,0.16); }
    .frame iframe { border: 0; display: block; }
    .eyebrow { font-size: 15px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${t['muted-foreground']}; }
    h1 { font-size: 100px; line-height: 0.95; letter-spacing: -0.045em; margin: 18px 0 26px; font-weight: 750; }
    h2 { font-size: 50px; line-height: 1.06; letter-spacing: -0.03em; margin: 16px 0 20px; font-weight: 700; }
    p.lead { font-size: 26px; line-height: 1.4; color: ${t['muted-foreground']}; margin: 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 36px; }
    .chips span { font-size: 19px; font-weight: 550; padding: 10px 18px; border-radius: 999px;
      border: 1px solid ${dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)'}; background: ${dark ? 'rgba(255,255,255,0.04)' : '#fff'}; }
    .chips span.hot { border-color: color-mix(in srgb, ${ACCENT} 70%, transparent); color: #a5adff; background: color-mix(in srgb, ${ACCENT} 16%, transparent); }
    .fine { font-size: 15px; color: ${t['muted-foreground']}; opacity: 0.85; margin-top: 30px; }
    .caption { font-size: 17px; font-weight: 600; color: ${t['muted-foreground']}; text-align: center; margin-top: 16px; }
    /* A slice of Orca's window around the sidebar: a terminal, the right sidebar, the status bar. */
    .win { position: absolute; border-radius: 14px; overflow: hidden; background: #0d0d10;
      border: 1px solid rgba(255,255,255,0.10); box-shadow: 0 60px 120px -30px rgba(0,0,0,0.9), 0 2px 10px rgba(0,0,0,0.4);
      display: grid; grid-template-rows: 40px 1fr 30px; }
    .win-bar { display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #131317; border-bottom: 1px solid rgba(255,255,255,0.06);
      font-size: 13px; font-weight: 600; color: #8b8d94; }
    .win-bar i { width: 12px; height: 12px; border-radius: 50%; background: #34353b; }
    .win-bar span { margin-left: 12px; }
    .win-main { display: grid; grid-template-columns: 1fr auto; min-height: 0; }
    .term { padding: 22px 24px; font: 14.5px/1.75 "SF Mono", ui-monospace, Menlo, monospace; color: #c9ccd3; overflow: hidden; white-space: pre; }
    .term .dim { color: #6f727b; } .term .ok { color: #4cb782; } .term .br { color: #a5adff; } .term .cmd { color: #f2f3f5; }
    .side { border-left: 1px solid rgba(255,255,255,0.08); background: ${THEMES.dark.background}; }
    .side iframe { border: 0; display: block; }
    .status { display: flex; align-items: center; gap: 18px; padding: 0 14px; background: #131317; border-top: 1px solid rgba(255,255,255,0.06);
      font-size: 12.5px; color: #8b8d94; }
    .status .count { margin-left: auto; display: flex; align-items: center; gap: 7px; color: #f2c94c; font-weight: 600; }
    .status svg { width: 13px; height: 13px; }
  </style></head><body>${body}</body></html>`
}

// The status bar item's activity icon (Lucide's, as Orca draws it).
const ACTIVITY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>'
const BRANCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 9v6M18 9a9 9 0 0 1-9 9"/></svg>'

const FOCUS = 'pat/eng-142-retry-queued-writes'

const SCENES = {
  // The panel in Orca's right sidebar, on the branch of ENG-142, with the status bar count.
  cover: () =>
    page(`
    <div style="position:absolute;left:100px;top:0;bottom:0;width:600px;display:flex;flex-direction:column;justify-content:center">
      <div class="eyebrow">Plugin for Orca</div>
      <h1>Linear Issues</h1>
      <p class="lead">Your issues, the current cycle and the team's backlog in Orca's sidebar.</p>
      <div class="chips"><span class="hot">My issues</span><span>Cycle</span><span>Backlog</span><span>Triage</span><span>Start work</span></div>
      <div class="fine">Made-up issues. Not affiliated with Linear.</div>
    </div>
    <div class="win" style="left:730px;top:80px;width:810px;height:840px">
      <div class="win-bar"><i></i><i></i><i></i><span>eng-142</span></div>
      <div class="win-main">
        <div class="term"><span class="dim">~/app</span> <span class="br">(${FOCUS.slice(0, 18)}…)</span>
<span class="cmd">$ npm test -- sync</span>
<span class="ok">✓</span> queues writes while offline
<span class="ok">✓</span> retries after reconnect
<span class="ok">✓</span> keeps the queue order
<span class="ok">✓</span> backs off on failure

<span class="dim">4 passing (812ms)</span>
<span class="cmd">$ git commit -am "Retry on reconnect"</span>
<span class="dim">[pat/eng-142… 3f9c2a1] Retry on reconnect</span>
<span class="dim"> 2 files changed, 48 insertions(+)</span>
<span class="cmd">$ </span><span style="background:#a5adff">&nbsp;</span></div>
        <div class="side">${panel({ route: { view: 'mine' }, focusBranch: FOCUS, width: 400, height: 700, zoom: 1.1 }).replace(/class="frame[^"]*"/, 'class="bare"')}</div>
      </div>
      <div class="status"><span style="display:flex;gap:6px;align-items:center">${BRANCH}${FOCUS}</span><span class="count">${ACTIVITY}${STATUS}</span></div>
    </div>`),

  // My issues and the team backlog, light theme.
  'my-issues': () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:48px">
      <div style="width:440px">
        <div class="eyebrow">My issues, cycle, backlog, triage</div>
        <h2>Everything assigned to you, grouped by status.</h2>
        <p class="lead">Urgent first in each group. The issue of the branch you are on is pinned on top, and the status bar counts what is in progress.</p>
      </div>
      ${panel({ theme: 'light', route: { view: 'mine' }, focusBranch: FOCUS, height: 820 })}
      ${panel({ theme: 'light', route: { view: 'backlog' }, height: 820 })}
    </div>`, { theme: 'light', glow: ACCENT, glow2: '#f2c94c' }),

  // An issue with its status menu open, then its comments, dark theme.
  issue: () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:48px">
      <div style="width:440px">
        <div class="eyebrow">Issue details</div>
        <h2>Read it, comment, change it.</h2>
        <p class="lead">Description, sub-issues, links and comments. Set status, priority or assignee, and start an Orca workspace on the issue's branch.</p>
      </div>
      ${panel({ route: { issue: 'ENG-142', menu: 'status' }, height: 820 })}
      ${panel({ route: { issue: 'ENG-142', scroll: 2000 }, height: 820 })}
    </div>`, { glow: ACCENT, glow2: '#4cb782' }),

  // The current cycle (dark) and the API key screen that turns it on (light).
  cycle: () =>
    page(`
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:48px">
      <div style="width:440px">
        <div class="eyebrow">The current cycle</div>
        <h2>Add an API key, see the cycle.</h2>
        <p class="lead">Progress and days left above the cycle's issues. Keys stay in Orca's encrypted secrets, one per Linear workspace.</p>
      </div>
      <div>${panel({ route: { view: 'cycle' }, height: 780 })}<div class="caption">Cycle, dark theme</div></div>
      <div>${panel({ theme: 'light', route: { settings: true }, height: 780 })}<div class="caption">Settings, light theme</div></div>
    </div>`, { glow: '#f2c94c', glow2: ACCENT })
}

// The icon: three issue rows, the first one in progress, on the panel's indigo. Not Linear's mark.
const ICON = `<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin: 0; width: 512px; height: 512px; background: transparent; }</style></head><body>
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7480e8"/><stop offset="1" stop-color="#3f4ab0"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g transform="translate(96 118)">
    <rect x="0" y="0" width="320" height="76" rx="20" fill="#fff"/>
    <circle cx="44" cy="38" r="17" fill="none" stroke="#e0a915" stroke-width="7"/>
    <path d="M44 21 A17 17 0 0 1 44 55 Z" fill="#e0a915"/>
    <rect x="80" y="30" width="168" height="16" rx="8" fill="#3f4ab0"/>
    <rect x="0" y="100" width="320" height="76" rx="20" fill="#fff" fill-opacity="0.82"/>
    <circle cx="44" cy="138" r="17" fill="none" stroke="#9aa0c8" stroke-width="7"/>
    <rect x="80" y="130" width="196" height="16" rx="8" fill="#8f96cf"/>
    <rect x="0" y="200" width="320" height="76" rx="20" fill="#fff" fill-opacity="0.62"/>
    <circle cx="44" cy="238" r="17" fill="none" stroke="#9aa0c8" stroke-width="7" stroke-dasharray="6 6"/>
    <rect x="80" y="230" width="140" height="16" rx="8" fill="#8f96cf"/>
  </g>
</svg></body></html>`

// ---------- serve and shoot ----------

const pages = new Map() // path → html
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (status, type, body) => (res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }), res.end(body))
  try {
    if (pages.has(url.pathname)) return send(200, 'text/html; charset=utf-8', pages.get(url.pathname))
    const m = url.pathname.match(/^\/p\/(p\d+)\/(.+)$/)
    if (!m || !panels.has(m[1])) return send(404, 'text/plain', 'not found')
    const [, id, rest] = m
    if (rest === 'rpc') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { name, input } = JSON.parse(body)
      const handler = panels.get(id).handlers.get(name)
      let out
      try {
        out = handler ? await handler(input ?? {}) : { error: { kind: 'error', message: `No handler ${name}` } }
      } catch (error) {
        out = { error: { kind: error.kind ?? 'error', message: error.message } }
      }
      return send(200, 'application/json', JSON.stringify(out ?? null))
    }
    if (rest === 'panel/index.html') return send(200, 'text/html; charset=utf-8', panelDoc(id))
    const file = normalize(join(ROOT, rest))
    // The panel's modules, and the shared model it imports from src/.
    const served = ['panel', 'src'].some((dir) => file.startsWith(join(ROOT, dir) + '/'))
    if (!served || !file.endsWith('.mjs')) return send(404, 'text/plain', 'not found')
    return send(200, 'text/javascript; charset=utf-8', readFileSync(file))
  } catch (error) {
    send(500, 'text/plain', String(error?.stack ?? error))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const shoot = (path, target, width, height) =>
  promisify(execFile)(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    '--virtual-time-budget=6000',
    `--user-data-dir=${work}`,
    `--window-size=${width},${height}`,
    `--screenshot=${target}`,
    base + path
  ])

mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
const work = mkdtempSync(join(tmpdir(), 'linear-issues-images-'))
try {
  for (const [name, scene] of Object.entries(SCENES)) {
    if (only.length && !only.includes(name)) continue
    pages.set(`/${name}.html`, scene())
    const target = join(OUT, `${name}.png`)
    await shoot(`/${name}.html`, target, WIDTH, HEIGHT)
    console.log(`${target} (${Math.round(statSync(target).size / 1024)} KB)`)
  }
  if (!only.length || only.includes('icon')) {
    pages.set('/icon.html', ICON)
    const target = join(OUT, 'icon.png')
    await shoot('/icon.html', target, 512, 512)
    console.log(`${target} (${Math.round(statSync(target).size / 1024)} KB)`)
  }
  if (process.env.KEEP) {
    for (const path of pages.keys()) console.log(base + path)
    await new Promise(() => {})
  }
} finally {
  rmSync(work, { recursive: true, force: true })
  server.close()
}
