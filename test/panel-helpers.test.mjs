import assert from 'node:assert/strict'
import { test } from 'node:test'
import { color, priorityGlyph, statusGlyph } from '../panel/glyphs.mjs'
import { inline, parseMarkdown, safeUrl } from '../panel/markdown.mjs'

test('markdown blocks: headings, lists, quotes, code, rules and paragraphs', () => {
  const blocks = parseMarkdown('# Title\n\nSome *made-up* text\nthat wraps.\n\n- one\n- [x] two\n\n1. first\n\n> quoted\n\n```js\nconst a = 1\n```\n\n---')
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr'])
  assert.equal(blocks[2].items[1].checked, true)
  assert.equal(blocks[5].text, 'const a = 1')
  assert.equal(blocks[5].lang, 'js')
})

test('inline: links only for http(s) and mailto, code, emphasis', () => {
  assert.deepEqual(inline('see [docs](https://example.com/a) now'), [
    { t: 'text', text: 'see ' },
    { t: 'link', text: 'docs', href: 'https://example.com/a' },
    { t: 'text', text: ' now' }
  ])
  assert.deepEqual(inline('[bad](javascript:alert(1))'), [{ t: 'text', text: 'bad' }, { t: 'text', text: ')' }])
  assert.deepEqual(inline('`x<y>`'), [{ t: 'code', text: 'x<y>' }])
  assert.equal(inline('**bold** and _it_')[0].t, 'b')
  assert.equal(inline('snake_case_name').length, 1)
  assert.deepEqual(inline('![shot](https://uploads.linear.app/x.png)'), [{ t: 'link', text: 'Image: shot', href: 'https://uploads.linear.app/x.png' }])
  assert.equal(inline('go to https://example.com/x.').at(-1).text, '.')
  assert.equal(safeUrl('  HTTPS://a.b '), 'HTTPS://a.b')
  assert.equal(safeUrl('file:///etc/passwd'), null)
})

test('HTML in text stays text', () => {
  const [p] = parseMarkdown('<img src=x onerror=alert(1)>')
  assert.deepEqual(p.inline, [{ t: 'text', text: '<img src=x onerror=alert(1)>' }])
})

test('glyphs take only real colours', () => {
  assert.equal(color('#ff0000'), '#ff0000')
  assert.equal(color('red"/><script>', '#000'), '#000')
  assert.ok(!statusGlyph('started', '"><script>alert(1)</script>').includes('<script>'))
  for (const type of ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate', 'other']) assert.match(statusGlyph(type, '#123456', 0.4), /^<svg/)
  for (const p of [0, 1, 2, 3, 4, 9]) assert.match(priorityGlyph(p), /^<svg/)
})
