import { fetchWithNetworkRetry } from '@/lib/chat/upload-with-retry'
import { docRefusal } from '@/lib/marketing/documents-rules'
import type { TFn } from '@/lib/marketing/i18n'

const API = '/api/marketing/documents'
const UPLOAD_ATTEMPT_MS = 15 * 60_000

async function post<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof d.error === 'string' && d.error ? d.error : fallback)
  return d as T
}

/**
 * Puts ONE file into a folder of the team's Documents (TD Marketing, dev job 9aec66fa): the browser asks for a signed upload link, sends the file there, then the server registers it (a same name becomes the
 * next version; `replaceFileId` replaces that file, keeping the old one). Used by the Documents screen and by the Upload button on Antonio's Home, so both behave the same. Returns the server's sentence.
 */
export async function uploadDocument(file: File, folder: string, replaceFileId: string | null, t: TFn): Promise<string> {
  const bad = docRefusal(file.name, file.size)
  if (bad) throw new Error(t(bad))
  const link = await post<{ signedUrl: string; path: string }>(`${API}/upload-url`, { folderId: folder, fileName: file.name, size: file.size }, t('Could not start the upload. Please try again.'))
  let put: Response
  try { put = await fetchWithNetworkRetry(link.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }, { attemptTimeoutMs: UPLOAD_ATTEMPT_MS }) }
  catch { throw new Error(t("Couldn't upload the file — the connection was interrupted. Please try again.")) }
  if (!put.ok) throw new Error(put.status === 413 ? t('That file is too large.') : t('Upload failed. Please check your connection and try again.'))
  const r = await post<{ message: string }>(`${API}/register`, { folderId: folder, path: link.path, fileName: file.name, mimeType: file.type || null, replaceFileId }, t('The upload could not be saved. Please try again.'))
  return r.message
}
