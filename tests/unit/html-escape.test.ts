import { describe, it, expect } from 'vitest'
import { escapeHtml, sanitizeEmailHtml } from '@/lib/html-escape'

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;')
  })

  it('neutralizes a script-tag injection in a name', () => {
    const out = escapeHtml('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('handles null/undefined/non-string safely', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Mario Rossi')).toBe('Mario Rossi')
  })
})

describe('sanitizeEmailHtml', () => {
  it('removes script blocks entirely', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>')
    expect(out).toContain('<p>hi</p>')
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })

  it('removes style and iframe blocks', () => {
    const out = sanitizeEmailHtml('<style>body{}</style><iframe src="evil"></iframe><b>ok</b>')
    expect(out.toLowerCase()).not.toContain('<style')
    expect(out.toLowerCase()).not.toContain('<iframe')
    expect(out).toContain('<b>ok</b>')
  })

  it('strips inline event-handler attributes (quoted and unquoted)', () => {
    expect(sanitizeEmailHtml('<img src="x" onerror="alert(1)">').toLowerCase()).not.toContain('onerror')
    expect(sanitizeEmailHtml('<div onclick=doit()>x</div>').toLowerCase()).not.toContain('onclick')
    expect(sanitizeEmailHtml(`<a onmouseover='x'>y</a>`).toLowerCase()).not.toContain('onmouseover')
  })

  it('neutralizes javascript: and data: URLs in href/src', () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')).toContain('href="#"')
    expect(sanitizeEmailHtml(`<a href='vbscript:evil'>x</a>`)).toContain(`href='#'`)
    expect(sanitizeEmailHtml('<img src="data:text/html,<script>">').toLowerCase()).not.toContain('data:')
    expect(sanitizeEmailHtml('<img src="javascript:alert(1)">')).toContain('src="#"')
  })

  it('allows data:image/* in src (inline email images) but never in href', () => {
    const img = '<img src="data:image/png;base64,iVBORw0KGgo=">'
    expect(sanitizeEmailHtml(img)).toBe(img)
    const jpeg = "<img src='data:image/jpeg;base64,AAAA'>"
    expect(sanitizeEmailHtml(jpeg)).toBe(jpeg)
    // data: links can smuggle full documents — always neutralized, even images
    expect(sanitizeEmailHtml('<a href="data:image/png;base64,AAAA">x</a>')).toContain('href="#"')
    // non-image data src stays blocked
    expect(sanitizeEmailHtml('<img src="data:application/pdf;base64,AAAA">')).toContain('src="#"')
  })

  it('preserves safe formatting and normal links', () => {
    const out = sanitizeEmailHtml('<p><b>Bold</b> <a href="https://x.com">link</a></p>')
    expect(out).toContain('<b>Bold</b>')
    expect(out).toContain('href="https://x.com"')
  })

  it('removes style attributes carrying expression()/javascript:', () => {
    expect(sanitizeEmailHtml('<div style="width:expression(alert(1))">x</div>')).not.toContain('expression')
  })

  it('returns empty string for falsy input', () => {
    expect(sanitizeEmailHtml('')).toBe('')
    expect(sanitizeEmailHtml(null)).toBe('')
  })
})
