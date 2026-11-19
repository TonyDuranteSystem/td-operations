import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ShareMessageDialog } from '@/components/storage/share-message-dialog'
import type { ShareContext } from '@/lib/portal/document-share-text'

type Askable = Extract<ShareContext, { askable: true }>
const target = (over: Partial<Askable['targets'][number]> & { key: string; label: string }): Askable['targets'][number] => ({
  kind: 'company', accountId: 'a1', contactId: null, closed: false, isDefault: false, topics: [], ...over,
})
const ctx = (over: Partial<Askable>): Askable => ({ askable: true, fileName: 'OA.pdf', locale: 'en', defaultTopic: 'Documents', targets: [], ...over })

describe('ShareMessageDialog — the shared destination choices still render the same', () => {
  it('document mode: the eye pop-up shows its title, "Show only", the pre-selected owner and the Documents topic', () => {
    const html = renderToStaticMarkup(createElement(ShareMessageDialog, {
      fileNames: ['OA.pdf'],
      onResult: () => {},
      ctx: ctx({ targets: [target({ key: 'company:a1', label: 'Open LLC', isDefault: true, topics: ['Documents', 'Tax'] }), target({ key: 'company:a2', label: 'Old LLC', accountId: 'a2', closed: true })] }),
    }))
    expect(html).toContain('Tell the client about this document?')
    expect(html).toContain('Show only')
    expect(html).toContain('Open LLC')
    expect(html).toContain("Old LLC (client can&#x27;t see this chat)")
    expect(html).toContain('Visible to everyone in Open LLC.') // the default company is pre-selected
    expect(html).toContain('>Documents<')
    expect(html).toContain('Send message')
  })

  it('message mode: no "Show only", nothing pre-selected with two open choices', () => {
    const html = renderToStaticMarkup(createElement(ShareMessageDialog, {
      mode: 'message',
      onResult: () => {},
      ctx: ctx({ defaultTopic: '', recipientName: 'Ada Rossi', targets: [target({ key: 'person:c1', kind: 'person', accountId: null, contactId: 'c1', label: 'Ada Rossi — personal chat' }), target({ key: 'company:a1', label: 'Open LLC' })] }),
    }))
    expect(html).toContain('Message Ada Rossi')
    expect(html).not.toContain('Show only')
    expect(html).toContain('Pick who the message goes to.')
    expect(html).not.toContain('Visible to everyone in')
    expect(html).toContain('>General<')
  })

  it('message mode: exactly one open choice is pre-selected, and the notice and info lines show', () => {
    const html = renderToStaticMarkup(createElement(ShareMessageDialog, {
      mode: 'message',
      onResult: () => {},
      ctx: ctx({ defaultTopic: '', notice: 'Nobody can read it yet.', info: 'The alert goes to one person only: Ada.', targets: [target({ key: 'company:a1', label: 'Open LLC' })] }),
    }))
    expect(html).toContain('Visible to everyone in Open LLC.')
    expect(html).toContain('Nobody can read it yet.')
    expect(html).toContain('The alert goes to one person only: Ada.')
    expect(html).not.toContain('Pick who the message goes to.')
  })
})
