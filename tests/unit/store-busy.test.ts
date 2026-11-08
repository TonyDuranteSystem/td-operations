/**
 * "An upload is running in the Documents tab" (dev job aa072623): the storage screen reports it, the account / contact page locks its tab
 * buttons. These tests pin the shared signal itself and — by reading the page sources, as other guards in this folder do — that BOTH pages
 * still wrap the tab in the scope. Without the scope the signal goes nowhere, every other test stays green and the tabs silently unlock.
 */
import { describe, it, expect } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import { StoreBusyScope, useStoreBusy, STORE_BUSY_HINT } from '@/components/accounts/store-busy'

// the scope's children arrive as createElement's 3rd argument (a `children:` prop key is a lint error), so type it without them
const Scope = StoreBusyScope as unknown as ComponentType<{ busy: boolean; setBusy: (busy: boolean) => void }>
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

// a consumer that prints what the context gives it
function Probe({ onValue }: { onValue?: (v: ReturnType<typeof useStoreBusy>) => void }) {
  const v = useStoreBusy()
  onValue?.(v)
  return createElement('span', null, v.busy ? 'busy' : 'idle')
}

describe('store-busy context', () => {
  it('outside any scope: never busy, and telling it something does nothing (any other page)', () => {
    let seen: ReturnType<typeof useStoreBusy> | undefined
    expect(renderToStaticMarkup(createElement(Probe, { onValue: (v) => { seen = v } }))).toContain('idle')
    expect(() => seen?.setBusy(true)).not.toThrow()
  })

  it('inside a scope: shows what the page holds, and hands the page its own setter', () => {
    const setBusy = () => undefined
    let seen: ReturnType<typeof useStoreBusy> | undefined
    const idle = renderToStaticMarkup(createElement(Scope, { busy: false, setBusy }, createElement(Probe, { onValue: (v) => { seen = v } })))
    expect(idle).toContain('idle')
    expect(seen?.setBusy).toBe(setBusy)
    const busy = renderToStaticMarkup(createElement(Scope, { busy: true, setBusy }, createElement(Probe)))
    expect(busy).toContain('busy')
  })

  it('the hint covers every kind of running action, not only the upload window', () => {
    expect(STORE_BUSY_HINT).not.toMatch(/upload window/i)
    expect(STORE_BUSY_HINT.length).toBeGreaterThan(10)
  })
})

describe('both pages lock their tab buttons while the storage screen is busy', () => {
  const account = read('components/accounts/account-detail.tsx')
  const contact = read('components/contacts/contact-detail.tsx')

  it('the account page wraps its tab content in the scope and locks the other tabs', () => {
    expect(account).toContain('<StoreBusyScope')
    expect(account).toMatch(/disabled=\{storeBusy && activeTab !== tab\.key\}/)
  })

  it('the contact page wraps its tab content in the scope, locks the other tabs and the Personal / company buttons', () => {
    expect(contact).toContain('<StoreBusyScope')
    expect(contact).toMatch(/disabled=\{storeBusy && activeTab !== tab\.key\}/)
    expect(contact).toMatch(/disabled=\{storeBusy && activeDocScope !== scope\.key\}/)
  })

  it('a locked contact tab says why to a screen reader too', () => {
    expect(contact).toMatch(/aria-label=\{storeBusy && activeTab !== tab\.key \? `\$\{tab\.tooltip\} — \$\{STORE_BUSY_HINT\}`/)
  })
})

describe('the storage screen cannot stay "busy" or keep a dead Retry', () => {
  const screen = read('components/storage/new-store-browser.tsx')

  it('a bulk upload that throws still ends the "running" state (try / finally around the loop)', () => {
    expect(screen).toMatch(/\} finally \{\s*setDropRunning\(false\)\s*setUploading\(false\)\s*\}/)
  })

  it('Retry follows the tested plan (planRetry) and remembers which load the banner is about', () => {
    expect(screen).toContain("errorFrom.current = 'nav'")
    expect(screen).toContain("errorFrom.current = 'owner'")
    expect(screen).toMatch(/planRetry\(\{ embedded: !!scopedOwnerId, failedPart: errorFrom\.current, hasOwner: !!again, hasRoot: !!root, hasList: groups !== null \}\)/)
    expect(screen).toMatch(/plan\.owner === 'refresh'\) void refreshAll\(\)/)
    expect(screen).toMatch(/plan\.owner === 'open' && again\) void openOwner\(again\)/)
    expect(screen).toMatch(/if \(plan\.list\) void loadNav\(\)/)
  })

  it('the client list recovering clears its own banner; the storage clears its banner only after every folder reloaded', () => {
    expect(screen).toMatch(/if \(errorFrom\.current === 'nav'\) setError\(null\)/)
    expect(screen).toMatch(/if \(!folderFailed && errorFrom\.current === 'owner' && ownerIdRef\.current === ownerId && seq === refreshSeq\.current\) setError\(null\)/)
    // a folder that failed twice (not "gone") is what holds the banner back
    expect(screen).toMatch(/if \(isGoneError\(e2\)\) return gone\(\)\s*folderFailed = true/)
  })

  it('a merged PDF waiting for its upload questions locks the tabs like the other pending questions', () => {
    expect(screen).toMatch(/const tabLocked = working \|\| !!plain \|\| !!drop \|\| !!mergedFile/)
  })
})
