import { describe, it, expect } from 'vitest'
import { appThreadPlan } from '@/lib/inbox/app-thread-actions'

// The short toolbar of an open email / chat inside the TD Social phone app (Step 1b, fix-list item 4).
describe('appThreadPlan', () => {
  it('email: Reply, archive, read/unread and delete on the bar; everything else under "…"', () => {
    const p = appThreadPlan({ channel: 'gmail', isTrash: false, hasWhatsAppGroup: false })
    expect(p.primary).toEqual(['reply', 'archive', 'toggleRead', 'delete'])
    expect(p.more).toEqual(['task', 'service', 'invoice', 'worker', 'share', 'forward', 'star', 'link', 'print'])
  })

  it('email from Trash: Restore replaces Delete (Delete on a trashed email does nothing)', () => {
    const p = appThreadPlan({ channel: 'gmail', isTrash: true, hasWhatsAppGroup: false })
    expect(p.primary).toEqual(['reply', 'archive', 'toggleRead', 'restore'])
    expect(p.primary).not.toContain('delete')
  })

  it('WhatsApp chat: only Reply on the bar; Worker and the link under "…" when the chat has its id', () => {
    expect(appThreadPlan({ channel: 'whatsapp', isTrash: false, hasWhatsAppGroup: true })).toEqual({ primary: ['reply'], more: ['worker', 'copyLink'] })
    expect(appThreadPlan({ channel: 'whatsapp', isTrash: false, hasWhatsAppGroup: false })).toEqual({ primary: ['reply'], more: [] })
  })

  it('never offers email-only actions on WhatsApp, and never loses Reply', () => {
    for (const channel of ['gmail', 'whatsapp', 'telegram']) {
      const p = appThreadPlan({ channel, isTrash: false, hasWhatsAppGroup: true })
      expect(p.primary[0]).toBe('reply')
    }
    const wa = appThreadPlan({ channel: 'whatsapp', isTrash: false, hasWhatsAppGroup: true })
    for (const emailOnly of ['archive', 'toggleRead', 'delete', 'forward', 'share', 'print', 'star', 'task'] as const) {
      expect([...wa.primary, ...wa.more]).not.toContain(emailOnly)
    }
  })

  it('any other channel keeps what the computer layout shows it', () => {
    expect(appThreadPlan({ channel: 'telegram', isTrash: false, hasWhatsAppGroup: false })).toEqual({
      primary: ['reply'], more: ['task', 'service', 'invoice', 'worker'],
    })
  })
})
