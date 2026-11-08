import { describe, it, expect, vi } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// the real storage screen is a 3,500-line client component; this test only checks HOW the panel mounts it
vi.mock('@/components/storage/new-store-browser', () => ({ NewStoreBrowser: () => null }))
// the panel reads the page's "an upload is running" setter from a context; here it is a plain stand-in
const reportBusy = vi.fn()
vi.mock('@/components/accounts/store-busy', () => ({ useStoreBusy: () => ({ busy: false, setBusy: reportBusy }) }))

import { StoreDocumentsPanel } from '@/components/accounts/store-documents-panel'
import { NewStoreBrowser } from '@/components/storage/new-store-browser'
import { CardErrorBoundary } from '@/components/dashboard/card-error-boundary'

// the panel's only hook is mocked above, so it can be called as a plain function to look at what it returns:
// a crash guard (keyed by the owner) around the real storage screen
type ScreenProps = { ownerId: string; scopedKind: string; onBusyChange?: (busy: boolean) => void }
function mounted(props: Parameters<typeof StoreDocumentsPanel>[0]) {
  const guard = StoreDocumentsPanel(props) as React.ReactElement<{ children: React.ReactElement<ScreenProps>; fallbackTitle?: string }>
  const screen = guard.props.children
  return { guard, screen }
}

describe('StoreDocumentsPanel (Documents tab of a company / person in storage)', () => {
  it('shows the real storage screen for exactly the owner it was given', () => {
    const { screen } = mounted({ ownerId: 'owner-1' })
    expect(screen.type).toBe(NewStoreBrowser)
    expect(screen.props.ownerId).toBe('owner-1')
  })

  it('a crash inside the screen is caught by the card guard, not the whole account / contact page', () => {
    const { guard } = mounted({ ownerId: 'owner-1' })
    expect(guard.type).toBe(CardErrorBoundary)
    expect(guard.props.fallbackTitle).toBe('Documents')
  })

  it('the guard turns a crash into "Documents / Failed to load / Retry" in the tab\'s place (and shows the screen when nothing crashed)', () => {
    // no DOM here, so the guard is driven by hand: the state React gives it after a crash, then what it draws
    const guard = new CardErrorBoundary({ children: 'the screen', fallbackTitle: 'Documents' })
    expect(guard.render()).toBe('the screen')
    guard.state = CardErrorBoundary.getDerivedStateFromError()
    const html = renderToStaticMarkup(guard.render() as React.ReactElement)
    expect(html).toContain('Documents')
    expect(html).toContain('Failed to load')
    expect(html).toContain('Retry')
    expect(html).not.toContain('the screen')
  })

  it('starts from a clean screen for a new owner (remounts: the key follows the owner)', () => {
    expect(mounted({ ownerId: 'owner-1' }).guard.key).toBe('owner-1')
    expect(mounted({ ownerId: 'owner-2' }).guard.key).toBe('owner-2')
  })

  it('a company by default, a person when the contact page says so (first-moment fallback only)', () => {
    expect(mounted({ ownerId: 'o' }).screen.props.scopedKind).toBe('company')
    expect(mounted({ ownerId: 'o', who: 'company' }).screen.props.scopedKind).toBe('company')
    expect(mounted({ ownerId: 'o', who: 'person' }).screen.props.scopedKind).toBe('person')
  })

  it('hands the page\'s busy setter to the screen, so its tab buttons can stay put (the Storage page has the same lock)', () => {
    const { screen } = mounted({ ownerId: 'o' })
    expect(screen.props.onBusyChange).toBe(reportBusy)
  })
})
