/**
 * TD Marketing — put one file into a lead's chat (browser only; dev job 9aec66fa). Same steps and the same size / type policy as TD Talk's upload
 * (lib/team/attachment.ts): ask our server for a signed link into THIS lead's own folder of the private bucket, then send the file straight to storage
 * (so the web server's request-size limit never applies). A network failure is retried quietly; every failure ends as a message a person can read.
 */
import { validateChatAttachment, CHAT_ATTACHMENT_MAX_MB } from '@/lib/portal/chat-attachment'
import { fetchWithNetworkRetry } from '@/lib/chat/upload-with-retry'
import type { StoredAttachment } from '@/lib/marketing/lead-chat'

/** `api` is the chat's own address (the lead chat by default; the team chat passes /api/marketing/team-chat): the signed link is asked of THAT chat, into its own folder. */
export async function uploadLeadAttachment(file: File, leadId: string, api = '/api/marketing/chat'): Promise<StoredAttachment> {
  const invalid = validateChatAttachment(file.name, file.size, file.type)
  if (invalid) throw new Error(invalid)

  let urlRes: Response
  try {
    urlRes = await fetchWithNetworkRetry(`${api}/${leadId}/upload-url`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_name: file.name }),
    })
  } catch {
    throw new Error("Couldn't reach the server to start the upload. Your message and files are still here — check your connection and press Send to try again.")
  }
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not start the upload. Please try again.')
  }
  const { signedUrl, path } = await urlRes.json()
  if (!signedUrl || !path) throw new Error('Could not start the upload. Please try again.')

  let putRes: Response
  try {
    putRes = await fetchWithNetworkRetry(signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
  } catch {
    throw new Error("Couldn't upload the file — the connection was interrupted. Your message and files are still here — press Send to try again.")
  }
  if (!putRes.ok) {
    if (putRes.status === 413) throw new Error(`File too large. Maximum allowed: ${CHAT_ATTACHMENT_MAX_MB} MB.`)
    throw new Error('Upload failed. Please check your connection and try again.')
  }
  return { path, name: file.name, mime_type: file.type || undefined, size: file.size }
}
