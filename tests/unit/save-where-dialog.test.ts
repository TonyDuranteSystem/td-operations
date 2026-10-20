/**
 * The "Where should this fax be saved?" window must be REQUIRED: no X, Escape does nothing, a click on the backdrop does nothing.
 * (No browser DOM in this suite: the shell is a plain function component, so its element tree is inspected directly, and the
 * server-rendered markup is checked for the same things.)
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RequiredDialog, trapTarget } from '@/components/storage/save-where-dialog'

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>
function walk(node: ReactNode, visit: (el: El) => void) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return }
  if (!isValidElement(node)) return
  const el = node as El
  visit(el)
  walk(el.props.children, visit)
}

describe('RequiredDialog — cannot be dismissed by accident', () => {
  const tree = RequiredDialog({ labelledBy: 't', children: createElement('h3', { id: 't' }, 'Where?') }) as El
  const all: El[] = []
  walk(tree, (e) => all.push(e))

  it('is a modal dialog with an accessible title', () => {
    const dlg = all.find((e) => e.props.role === 'dialog')!
    expect(dlg).toBeTruthy()
    expect(String(dlg.props['aria-modal'])).toBe('true')
    expect(dlg.props['aria-labelledby']).toBe('t')
  })
  it('the backdrop has NO click / mouse / pointer handler (a click outside does nothing)', () => {
    for (const k of ['onClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onTouchStart']) expect(tree.props[k], k).toBeUndefined()
  })
  it('there is no close button anywhere (no X, no Close, no Cancel)', () => {
    for (const e of all) {
      expect(String(e.props['aria-label'] ?? '')).not.toMatch(/close|cancel|dismiss/i)
      if (e.type === 'button') expect(e.props.onClick).toBeUndefined()
    }
    const html = renderToStaticMarkup(createElement(RequiredDialog, { labelledBy: 't' }, createElement('h3', { id: 't' }, 'Where?')))
    expect(html).not.toMatch(/<button/i)
    expect(html).not.toMatch(/aria-label="(close|cancel)/i)
  })
  it('Escape is swallowed: default prevented and not passed on, so nothing behind the window reacts', () => {
    const dlg = all.find((e) => e.props.role === 'dialog')!
    const onKeyDown = dlg.props.onKeyDown as (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void
    const preventDefault = vi.fn(), stopPropagation = vi.fn()
    onKeyDown({ key: 'Escape', preventDefault, stopPropagation })
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce()
    const other = vi.fn()
    onKeyDown({ key: 'a', preventDefault: other, stopPropagation: other })
    expect(other).not.toHaveBeenCalled()
  })
  it('Tab stays inside the window: the last control wraps to the first, Shift+Tab on the first wraps to the last, focus outside is brought in', () => {
    expect(trapTarget(['a', 'b', 'c'], 'c', false)).toBe('a')
    expect(trapTarget(['a', 'b', 'c'], 'a', true)).toBe('c')
    expect(trapTarget(['a', 'b', 'c'], 'b', false)).toBeNull()   // inside: the browser moves on by itself
    expect(trapTarget(['a', 'b', 'c'], 'b', true)).toBeNull()
    expect(trapTarget(['a', 'b', 'c'], null, false)).toBe('a')
    expect(trapTarget(['a', 'b', 'c'], 'zzz', true)).toBe('c')
    expect(trapTarget([], null, false)).toBeNull()
  })
  it('the key handler applies the trap and still ignores Escape', () => {
    const dlg = all.find((e) => e.props.role === 'dialog')!
    const onKeyDown = dlg.props.onKeyDown as (e: unknown) => void
    const first = { focus: vi.fn() }, last = { focus: vi.fn() }
    ;(globalThis as unknown as { document: unknown }).document = { activeElement: last }
    const preventDefault = vi.fn()
    onKeyDown({ key: 'Tab', shiftKey: false, preventDefault, currentTarget: { querySelectorAll: () => [first, last] } })
    expect(preventDefault).toHaveBeenCalledOnce(); expect(first.focus).toHaveBeenCalledOnce()
    delete (globalThis as unknown as { document?: unknown }).document
  })
  it('the page-behind lock (scroll lock, inert, Escape after a backdrop click) is wired in', () => {
    const names: string[] = []
    walk(tree, (e) => { if (typeof e.type === 'function') names.push((e.type as { name: string }).name) })
    expect(names).toContain('DialogEffects')
  })
  it('takes no onClose prop at all', () => {
    expect(RequiredDialog.length).toBe(1)
    expect(Object.keys((RequiredDialog as unknown as { propTypes?: object }).propTypes ?? {})).toEqual([])
  })
})
