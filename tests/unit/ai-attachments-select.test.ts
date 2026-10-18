import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isInlineImagePart, selectAttachmentsToSave, type ListedAttachment } from '@/lib/ai-agent/attachment-select'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn(), storage: { from: vi.fn() } } }))

const savedNames: string[] = []
vi.mock('@/lib/crm-store/save-for-account', () => ({
  saveDocumentForAccount: async (i: { name: string }) => { savedNames.push(i.name); return { route: 'store', pointer: `store:${i.name}`, documentRowId: 'r' } },
}))
vi.mock('@/lib/crm-store/rules', () => ({ storeNameKey: (n: string) => n }))
vi.mock('@/lib/gmail', () => ({
  getGmailAttachment: async () => ({ data: Buffer.from('x') }),
  gmailGet: async () => ({
    payload: { parts: [
      { filename: 'contract.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 10 }, headers: [] },
      { filename: 'image001.png', mimeType: 'image/png', body: { attachmentId: 'a2', size: 5 }, headers: [{ name: 'Content-ID', value: '<logo@x>' }] },
      { filename: 'photo.jpg', mimeType: 'image/jpeg', body: { attachmentId: 'a3', size: 50 }, headers: [{ name: 'Content-Disposition', value: 'attachment; filename="photo.jpg"' }] },
    ] },
  }),
}))

const all: ListedAttachment[] = [
  { filename: 'contract.pdf', mimeType: 'application/pdf', attachmentId: 'a1', size: 10, inline: false },
  { filename: 'image001.png', mimeType: 'image/png', attachmentId: 'a2', size: 5, inline: true },
]

describe('which attachments to keep', () => {
  it('an image with a Content-ID or marked inline is an embedded picture; a real photo attachment is not', () => {
    expect(isInlineImagePart({ mimeType: 'image/png', headers: [{ name: 'Content-ID', value: '<x>' }] })).toBe(true)
    expect(isInlineImagePart({ mimeType: 'image/png', headers: [{ name: 'Content-Disposition', value: 'inline; filename=a.png' }] })).toBe(true)
    expect(isInlineImagePart({ mimeType: 'image/jpeg', headers: [{ name: 'Content-Disposition', value: 'attachment' }] })).toBe(false)
    expect(isInlineImagePart({ mimeType: 'application/pdf', headers: [{ name: 'Content-ID', value: '<x>' }] })).toBe(false)
  })
  it('default: real files only', () => expect(selectAttachmentsToSave(all, {}).picked.map((a) => a.filename)).toEqual(['contract.pdf']))
  it('include_inline brings the pictures too', () => expect(selectAttachmentsToSave(all, { include_inline: true }).picked).toHaveLength(2))
  it('attachment_id picks exactly that one, even an embedded picture', () => expect(selectAttachmentsToSave(all, { attachment_id: 'a2' }).picked.map((a) => a.attachmentId)).toEqual(['a2']))
  it('an unknown attachment_id is an explicit error', () => expect(selectAttachmentsToSave(all, { attachment_id: 'zz' }).error).toMatch(/No attachment/))
})

describe('the assistant tool saves per attachment and skips embedded pictures', () => {
  beforeEach(() => { savedNames.length = 0 })
  it('save_to_storage saves the pdf and the real photo, not the logo', async () => {
    const { executeTool } = await import('@/lib/ai-agent/tools')
    const out = JSON.parse(await executeTool('gmail_get_attachments', { message_id: 'm1', save_to_storage: true, account_id: 'acc' }))
    expect(out.uploaded.map((u: { filename: string }) => u.filename)).toEqual(['contract.pdf', 'photo.jpg'])
    expect(savedNames).toEqual(['contract.pdf', 'photo.jpg'])
  })
  it('attachment_id saves only that one', async () => {
    const { executeTool } = await import('@/lib/ai-agent/tools')
    const out = JSON.parse(await executeTool('gmail_get_attachments', { message_id: 'm1', save_to_storage: true, account_id: 'acc', attachment_id: 'a1' }))
    expect(out.uploaded).toHaveLength(1)
    expect(savedNames).toEqual(['contract.pdf'])
  })
  it('update_contact with the removed gdrive_folder_url is an explicit error, not a silent drop', async () => {
    const { executeTool } = await import('@/lib/ai-agent/tools')
    const out = JSON.parse(await executeTool('update_contact', { contact_id: 'c1', phone: '1', gdrive_folder_url: 'x' }))
    expect(out.error).toMatch(/gdrive_folder_url was removed/)
  })
})
