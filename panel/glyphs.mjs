// The panel's icons, drawn for this plugin: status and priority glyphs in the spirit of Linear's
// issue lists (circles that fill as work moves on, signal bars for priority), plus UI icons.
// Every value that reaches the SVG text is a number or a colour checked against COLOR.
const COLOR = /^#[0-9a-fA-F]{3,8}$/
export const color = (value, fallback = 'currentColor') => (typeof value === 'string' && COLOR.test(value) ? value : fallback)

// State colours are picked for Linear's own background; a very light one vanishes on a light
// theme and a very dark one on a dark theme. Those fall back to a mid grey.
let light = false
export const setLightTheme = (value) => (light = Boolean(value))
export function luminance(hex) {
  let h = hex.slice(1)
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const saturation = (hex) => {
  let h = hex.slice(1)
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('')
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const max = Math.max(...rgb)
  return max === 0 ? 0 : (max - Math.min(...rgb)) / max
}
export function readable(value, fallback) {
  const c = color(value, fallback)
  if (!c.startsWith('#')) return c
  const l = luminance(c)
  return (light && l > 0.45 && saturation(c) < 0.2) || (!light && l < 0.04) ? '#8a8f98' : c
}

const svg = (body, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true">${body}</svg>`

// type: triage | backlog | unstarted | started | completed | canceled | duplicate; progress 0–1.
export function statusGlyph(type, stateColor, progress = 0.5) {
  const c = readable(stateColor, type === 'completed' ? '#5e6ad2' : '#8a8f98')
  switch (type) {
    case 'backlog':
      return svg(`<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="1.6 1.65"/>`)
    case 'unstarted':
      return svg(`<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/>`)
    case 'started': {
      const p = Math.min(0.95, Math.max(0.05, Number(progress) || 0.5))
      const a = 2 * Math.PI * p
      const x = (7 + 3 * Math.sin(a)).toFixed(2)
      const y = (7 - 3 * Math.cos(a)).toFixed(2)
      return svg(`<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M7 7 L7 4 A3 3 0 ${p > 0.5 ? 1 : 0} 1 ${x} ${y} Z" fill="${c}"/>`)
    }
    case 'completed':
      return svg(`<circle cx="7" cy="7" r="6.25" fill="${c}"/><path d="M4.4 7.2 L6.2 9 L9.7 5.3" fill="none" stroke="var(--glyph-cut)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`)
    case 'canceled':
    case 'duplicate':
      return svg(`<circle cx="7" cy="7" r="6.25" fill="${c}"/><path d="M5 5 L9 9 M9 5 L5 9" stroke="var(--glyph-cut)" stroke-width="1.5" stroke-linecap="round"/>`)
    case 'triage':
      return svg(`<circle cx="7" cy="7" r="6.25" fill="${c}"/><path d="M3.8 7 H10.2 M8.4 5.2 L10.2 7 L8.4 8.8 M5.6 5.2 L3.8 7 L5.6 8.8" fill="none" stroke="var(--glyph-cut)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`)
    default:
      return svg(`<circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.5"/>`)
  }
}

// 0 none, 1 urgent, 2 high, 3 medium, 4 low.
export function priorityGlyph(priority) {
  if (priority === 1) return svg(`<rect x="1" y="1" width="12" height="12" rx="3" fill="var(--urgent)"/><path d="M7 3.6 V7.6" stroke="var(--glyph-cut)" stroke-width="1.7" stroke-linecap="round"/><circle cx="7" cy="10.1" r="1" fill="var(--glyph-cut)"/>`)
  if (priority >= 2 && priority <= 4) {
    const on = 5 - priority
    return svg([0, 1, 2].map((i) => `<rect x="${1.5 + i * 4}" y="${9 - i * 3}" width="3" height="${3 + i * 3}" rx="1" fill="currentColor" opacity="${i < on ? 1 : 0.28}"/>`).join(''))
  }
  return svg([0, 1, 2].map((i) => `<rect x="${1.5 + i * 4}" y="6.25" width="3" height="1.5" rx="0.75" fill="currentColor" opacity="0.55"/>`).join(''))
}

const icon = (body, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const ICONS = {
  chevronDown: icon('<path d="M4.5 6.5 L8 10 L11.5 6.5"/>', 12),
  chevronRight: icon('<path d="M6.5 4.5 L10 8 L6.5 11.5"/>', 12),
  back: icon('<path d="M9.5 3.5 L5 8 L9.5 12.5"/>'),
  refresh: icon('<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8 V5.3 H10.5"/>'),
  external: icon('<path d="M9 3 H13 V7"/><path d="M13 3 L7.5 8.5"/><path d="M11.5 9.5 V12.5 H3.5 V4.5 H6.5"/>'),
  search: icon('<circle cx="7" cy="7" r="4"/><path d="M10 10 L13 13"/>'),
  gear: icon('<circle cx="8" cy="8" r="2"/><path d="M8 1.8 V3.4 M8 12.6 V14.2 M1.8 8 H3.4 M12.6 8 H14.2 M3.6 3.6 L4.7 4.7 M11.3 11.3 L12.4 12.4 M3.6 12.4 L4.7 11.3 M11.3 4.7 L12.4 3.6"/>'),
  branch: icon('<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5 V11 M11 7 C11 9.5 8 9 5 11"/>', 12),
  project: icon('<path d="M8 1.8 L13.4 4.9 V11.1 L8 14.2 L2.6 11.1 V4.9 Z"/>', 12),
  cycle: icon('<path d="M13 8a5 5 0 1 1-5-5"/><path d="M8 1 V5 L10.5 3"/>', 12),
  calendar: icon('<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5 H13.5 M5.5 2 V4.5 M10.5 2 V4.5"/>', 12),
  estimate: icon('<path d="M3 13 L8 3 L13 13 Z"/>', 12),
  person: icon('<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5 C3.8 10.8 5.6 9.5 8 9.5 S12.2 10.8 13 13.5"/>', 12),
  plus: icon('<path d="M8 3 V13 M3 8 H13"/>', 12),
  close: icon('<path d="M4 4 L12 12 M12 4 L4 12"/>', 12),
  link: icon('<path d="M6.5 9.5 L9.5 6.5"/><path d="M7 4.5 L8.5 3 A2.8 2.8 0 0 1 13 7.5 L11.5 9"/><path d="M9 11.5 L7.5 13 A2.8 2.8 0 0 1 3 8.5 L4.5 7"/>', 12),
  key: icon('<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7 L13 3 M11 5 L12.5 6.5"/>', 12),
  check: icon('<path d="M3.5 8.5 L6.5 11.5 L12.5 4.5"/>', 12)
}
