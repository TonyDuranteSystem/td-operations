/**
 * Copy form uploads from Supabase Storage to Google Drive.
 * Used by form review pipelines (banking, tax, formation, onboarding, ITIN, closure).
 *
 * Maps upload type → Drive subfolder:
 * - bank_statement, proof_of_address, banking docs → 4. Banking
 * - ein_letter, articles → 1. Company
 * - passport, id_document → 2. Contacts
 * - tax docs, statements → 3. Tax
 * - everything else → 5. Correspondence
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

interface CopyResult {
  copied: number
  errors: string[]
  files: { name: string; driveId: string; folder: string }[]
}

const UPLOAD_TO_FOLDER: Record<string, string> = {
  // Banking
  proof_of_address: '4. Banking',
  bank_statement: '4. Banking',
  banking: '4. Banking',

  // Company
  ein_letter: '1. Company',
  articles: '1. Company',
  operating_agreement: '1. Company',

  // Contacts
  passport: '2. Contacts',
  id_document: '2. Contacts',
  selfie: '2. Contacts',

  // Tax
  tax: '3. Tax',
  statement: '3. Tax',
  invoice: '3. Tax',
  receipt: '3. Tax',
}

function getTargetFolder(filename: string): string {
  const lower = filename.toLowerCase()
  for (const [pattern, folder] of Object.entries(UPLOAD_TO_FOLDER)) {
    if (lower.includes(pattern)) return folder
  }
  return '5. Correspondence'
}

/**
 * Copy all files from a Supabase Storage path prefix to the client's Drive folder.
 * Resolves the correct subfolder based on filename.
 */
export async function copyUploadsToDrive(
  bucket: string,
  pathPrefix: string,
  driveFolderId: string
): Promise<CopyResult> {
  const result: CopyResult = { copied: 0, errors: [], files: [] }

  // List files in the storage path
  const { data: files, error: listError } = await supabaseAdmin.storage
    .from(bucket)
    .list(pathPrefix, { limit: 50 })

  if (listError || !files?.length) {
    if (listError) result.errors.push(`List failed: ${listError.message}`)
    return result
  }

  // Get Drive subfolders
  const { listFolderAnyDrive, uploadBinaryToDrive } = await import('@/lib/google-drive')
  const subfolders = await listFolderAnyDrive(driveFolderId)
  const folderMap: Record<string, string> = {}
  for (const f of subfolders) {
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      folderMap[f.name] = f.id
    }
  }

  // Copy each file
  for (const file of files) {
    if (!file.name || file.name.startsWith('.')) continue

    const storagePath = `${pathPrefix}/${file.name}`
    const targetFolderName = getTargetFolder(file.name)
    const targetFolderId = folderMap[targetFolderName]

    if (!targetFolderId) {
      result.errors.push(`No Drive folder "${targetFolderName}" for ${file.name}`)
      continue
    }

    try {
      // Download from Supabase Storage
      const { data: blob, error: dlError } = await supabaseAdmin.storage
        .from(bucket)
        .download(storagePath)

      if (dlError || !blob) {
        result.errors.push(`Download failed: ${file.name} — ${dlError?.message}`)
        continue
      }

      // Upload to Drive
      const buffer = Buffer.from(await blob.arrayBuffer())
      const driveFile = await uploadBinaryToDrive(file.name, buffer, blob.type || 'application/pdf', targetFolderId)

      result.files.push({ name: file.name, driveId: driveFile.id, folder: targetFolderName })
      result.copied++
    } catch (err) {
      result.errors.push(`Upload failed: ${file.name} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
