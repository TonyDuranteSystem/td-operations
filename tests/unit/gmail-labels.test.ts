import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/gmail', () => ({
  gmailGet: vi.fn(),
  gmailPost: vi.fn(),
}))

import {
  getOrCreateLabelId,
  addLabelToMessage,
  labelPortalChatNotification,
  PORTAL_CHAT_LABEL,
} from '@/lib/gmail-labels'
import { gmailGet, gmailPost } from '@/lib/gmail'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getOrCreateLabelId', () => {
  it('returns the existing label id on a case-insensitive name match', async () => {
    vi.mocked(gmailGet).mockResolvedValue({
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_7', name: 'PORTAL CHAT notifications', type: 'user' },
      ],
    })
    // Unique name per test — the module-level cache persists across tests.
    const id = await getOrCreateLabelId('Portal chat NOTIFICATIONS')
    expect(id).toBe('Label_7')
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('creates the label when missing and returns the new id', async () => {
    vi.mocked(gmailGet).mockResolvedValue({ labels: [] })
    vi.mocked(gmailPost).mockResolvedValue({
      id: 'Label_9',
      name: 'Fresh Label A',
      type: 'user',
    })
    const id = await getOrCreateLabelId('Fresh Label A')
    expect(id).toBe('Label_9')
    expect(gmailPost).toHaveBeenCalledWith(
      '/labels',
      expect.objectContaining({ name: 'Fresh Label A' }),
      undefined,
    )
  })

  it('caches the id — the second call hits no API', async () => {
    vi.mocked(gmailGet).mockResolvedValue({ labels: [] })
    vi.mocked(gmailPost).mockResolvedValue({
      id: 'Label_10',
      name: 'Fresh Label B',
      type: 'user',
    })
    await getOrCreateLabelId('Fresh Label B')
    vi.clearAllMocks()
    const id = await getOrCreateLabelId('Fresh Label B')
    expect(id).toBe('Label_10')
    expect(gmailGet).not.toHaveBeenCalled()
    expect(gmailPost).not.toHaveBeenCalled()
  })
})

describe('addLabelToMessage', () => {
  it('calls messages.modify with the label id', async () => {
    vi.mocked(gmailPost).mockResolvedValue({})
    await addLabelToMessage('msg123', 'Label_1')
    expect(gmailPost).toHaveBeenCalledWith(
      '/messages/msg123/modify',
      { addLabelIds: ['Label_1'] },
      undefined,
    )
  })
})

describe('labelPortalChatNotification', () => {
  it('no-ops without a message id (sandbox sends return none)', async () => {
    await labelPortalChatNotification(undefined)
    expect(gmailGet).not.toHaveBeenCalled()
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('labels the message under the portal chat label', async () => {
    // Distinct mailbox — the per-user cache would otherwise reuse the id
    // resolved by an earlier test for the default mailbox.
    vi.mocked(gmailGet).mockResolvedValue({
      labels: [{ id: 'Label_pc', name: PORTAL_CHAT_LABEL, type: 'user' }],
    })
    vi.mocked(gmailPost).mockResolvedValue({})
    await labelPortalChatNotification('msg456', 'labeltest@tonydurante.us')
    expect(gmailPost).toHaveBeenCalledWith(
      '/messages/msg456/modify',
      { addLabelIds: ['Label_pc'] },
      'labeltest@tonydurante.us',
    )
  })

  it('swallows API failures — labeling must never break the send path', async () => {
    // Distinct mailbox so the label-id cache (keyed per user) can't shortcut
    // past the failing lookup.
    vi.mocked(gmailGet).mockRejectedValue(new Error('boom'))
    await expect(
      labelPortalChatNotification('msg789', 'other@tonydurante.us'),
    ).resolves.toBeUndefined()
    expect(gmailGet).toHaveBeenCalled()
  })
})
