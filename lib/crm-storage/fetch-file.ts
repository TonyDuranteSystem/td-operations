/**
 * Pull an existing CRM Storage file's actual bytes into the browser as a
 * real File — the one thing every "send this file to X" destination needs
 * (email, fax) because each of those copies the bytes into its own separate
 * store rather than accepting a reference to ours. Portal Chat and Team
 * Chat do their own copy server-side (see the share-team-chat / share-
 * portal-chat routes) so they don't use this — only client-side destinations
 * that build a File/base64 payload in the browser do.
 */
export async function fetchStorageFileBytes(id: string, fileName: string, mimeType: string | null): Promise<File> {
  const urlRes = await fetch(`/api/crm-storage/files/${id}/preview`)
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || "Could not read the file. Please try again.")
  }
  const { url } = await urlRes.json()
  const fileRes = await fetch(url)
  if (!fileRes.ok) throw new Error("Could not read the file. Please try again.")
  const blob = await fileRes.blob()
  return new File([blob], fileName, { type: mimeType || blob.type || "application/octet-stream" })
}
