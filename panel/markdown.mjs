// A small Markdown reader for issue descriptions and comments. It returns plain data, never HTML;
// the panel builds DOM nodes from it with textContent, so nothing in Linear text can run or style
// the panel. Images become links (the panel has no network to show them).
//
//   blocks: { type: 'p' | 'h' (level) | 'ul' | 'ol' | 'quote' | 'code' | 'hr', ... }
//   inline: { t: 'text' | 'code' | 'b' | 'i' | 's' | 'link', text, href?, children? }

const SAFE_URL = /^(https?:\/\/|mailto:)/i

export function safeUrl(url) {
  const value = String(url ?? '').trim()
  return SAFE_URL.test(value) ? value : null
}

const INLINE = [
  { re: /^`([^`]+)`/, make: (m) => ({ t: 'code', text: m[1] }) },
  { re: /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, make: (m) => link(m[1] ? `Image: ${m[1]}` : 'Image', m[2]) },
  { re: /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, make: (m) => link(m[1], m[2]) },
  { re: /^<(https?:\/\/[^>\s]+)>/, make: (m) => link(m[1], m[1]) },
  { re: /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, make: (m) => link(m[0], m[0]) },
  { re: /^\*\*([^*]+)\*\*/, make: (m) => ({ t: 'b', children: inline(m[1]) }) },
  { re: /^__([^_]+)__/, make: (m) => ({ t: 'b', children: inline(m[1]) }) },
  { re: /^~~([^~]+)~~/, make: (m) => ({ t: 's', children: inline(m[1]) }) },
  { re: /^\*([^*\s][^*]*)\*/, make: (m) => ({ t: 'i', children: inline(m[1]) }) },
  { re: /^_([^_\s][^_]*)_(?![A-Za-z0-9])/, make: (m) => ({ t: 'i', children: inline(m[1]) }) }
]

function link(text, href) {
  const url = safeUrl(href)
  return url ? { t: 'link', text, href: url } : { t: 'text', text }
}

export function inline(text) {
  const out = []
  let buf = ''
  let i = 0
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf })
    buf = ''
  }
  while (i < text.length) {
    const rest = text.slice(i)
    // Only try a rule where one can start, so words with underscores stay words.
    const boundary = i === 0 || /[\s(\[]/.test(text[i - 1])
    let hit = null
    for (const rule of INLINE) {
      if (!boundary && rule.re.source.startsWith('^_')) continue
      const m = rule.re.exec(rest)
      if (m) {
        hit = { node: rule.make(m), length: m[0].length }
        break
      }
    }
    if (hit) {
      flush()
      out.push(hit.node)
      i += hit.length
    } else {
      buf += text[i]
      i += 1
    }
  }
  flush()
  return out
}

export function parseMarkdown(source, { maxBlocks = 400 } = {}) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = []
  const endPara = () => {
    if (para.length) blocks.push({ type: 'p', inline: inline(para.join(' ')) })
    para = []
  }
  for (let i = 0; i < lines.length && blocks.length < maxBlocks; i++) {
    const line = lines[i]
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      endPara()
      const code = []
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i])
      blocks.push({ type: 'code', lang: fence[2] || null, text: code.join('\n') })
      continue
    }
    if (!line.trim()) {
      endPara()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      endPara()
      blocks.push({ type: 'h', level: heading[1].length, inline: inline(heading[2].replace(/\s+#+\s*$/, '')) })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara()
      blocks.push({ type: 'hr' })
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (item) {
      endPara()
      const ordered = /\d/.test(item[2])
      const list = { type: ordered ? 'ol' : 'ul', items: [] }
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(lines[i])
        if (!m || /\d/.test(m[2]) !== ordered) {
          i--
          break
        }
        list.items.push({ depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), checked: m[3] ? /x/i.test(m[3]) : null, inline: inline(m[4]) })
      }
      blocks.push(list)
      continue
    }
    if (/^\s*>/.test(line)) {
      endPara()
      const quote = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''))
      i--
      blocks.push({ type: 'quote', inline: inline(quote.join(' ')) })
      continue
    }
    para.push(line.trim())
  }
  endPara()
  return blocks
}
