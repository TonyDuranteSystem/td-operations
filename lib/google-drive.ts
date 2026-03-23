/**
 * Google Drive API Helper
 * Uses Service Account with Domain-Wide Delegation to access Shared Drive.
 *
 * Auth flow:
 *   1. Decode SA key from GOOGLE_SA_KEY env var (base64-encoded JSON)
 *   2. Build JWT, exchange for access token
 *   3. Impersonate support@tonydurante.us via DWD
 *
 * All calls target the "Tony Durante LLC" Shared Drive.
 */

import { SignJWT, importPKCS8 } from "jose"

// ─── Configuration ──────────────────────────────────────────

interface SACredentials {
  client_email: string
  private_key: string
  token_uri: string
}

let cachedToken: { token: string; expiresAt: number } | null = null

function getCredentials(): SACredentials {
  const b64 = process.env.GOOGLE_SA_KEY
  if (!b64) throw new Error("GOOGLE_SA_KEY not configured")

  const json = Buffer.from(b64, "base64").toString("utf-8")
  return JSON.parse(json)
}

const SCOPES = "https://www.googleapis.com/auth/drive"
const IMPERSONATE_EMAIL = () =>
  process.env.GOOGLE_IMPERSONATE_EMAIL || "support@tonydurante.us"
const SHARED_DRIVE_ID = () =>
  process.env.GOOGLE_SHARED_DRIVE_ID || "0AOLZHXSfKUMHUk9PVA"

// ─── Token Management ───────────────────────────────────────

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (5 min buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  // Build JWT assertion
  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: SCOPES,
    sub: IMPERSONATE_EMAIL(),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.client_email)
    .setAudience(creds.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)

  // Exchange JWT for access token
  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google OAuth error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

// ─── API Helpers ────────────────────────────────────────────

const DRIVE_API = "https://www.googleapis.com/drive/v3"

async function driveGet(endpoint: string, params?: Record<string, string>) {
  const token = await getAccessToken()
  const url = new URL(`${DRIVE_API}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }
  // Always include Shared Drive support
  url.searchParams.set("supportsAllDrives", "true")
  url.searchParams.set("includeItemsFromAllDrives", "true")

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive API ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

async function driveUpload(
  fileName: string,
  content: string,
  mimeType: string,
  parentFolderId: string,
) {
  const token = await getAccessToken()

  // Multipart upload: metadata + content
  const boundary = "----DriveUploadBoundary"
  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentFolderId],
    driveId: SHARED_DRIVE_ID(),
  })

  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n")

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive upload ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Search files across the Shared Drive
 */
export async function searchFiles(
  query: string,
  mimeType?: string,
  maxResults = 25,
) {
  let q = `name contains '${query.replace(/'/g, "\\'")}'`
  if (mimeType) q += ` and mimeType = '${mimeType}'`
  q += " and trashed = false"

  const result = await driveGet("/files", {
    q,
    driveId: SHARED_DRIVE_ID(),
    corpora: "drive",
    fields: "files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink)",
    pageSize: String(Math.min(maxResults, 100)),
  })

  return result
}

/**
 * List contents of a folder
 */
export async function listFolder(folderId: string, maxResults = 50) {
  const q = `'${folderId}' in parents and trashed = false`

  const result = await driveGet("/files", {
    q,
    driveId: SHARED_DRIVE_ID(),
    corpora: "drive",
    fields: "files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink)",
    pageSize: String(Math.min(maxResults, 100)),
    orderBy: "folder,name",
  })

  return result
}

/**
 * Get file metadata
 */
export async function getFileMetadata(fileId: string) {
  return driveGet(`/files/${fileId}`, {
    fields: "id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,description,owners,sharingUser",
  })
}

/**
 * Upload a text-based file to Drive (creates new file)
 */
export async function uploadFile(
  parentFolderId: string,
  fileName: string,
  content: string,
  mimeType = "text/plain",
) {
  return driveUpload(fileName, content, mimeType, parentFolderId)
}

/**
 * Update (overwrite) an existing file's content on Drive
 * Uses PATCH to replace the content while keeping the same file ID.
 */
export async function updateFileContent(
  fileId: string,
  content: string,
  mimeType = "text/plain",
  newName?: string,
) {
  const token = await getAccessToken()

  const boundary = "----DriveUpdateBoundary"
  const metadata: Record<string, string> = {}
  if (newName) metadata.name = newName

  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n")

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive update ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * Rename a file or folder on Drive (metadata-only update)
 */
export async function renameFile(fileId: string, newName: string) {
  const token = await getAccessToken()

  const res = await fetch(
    `${DRIVE_API}/files/${fileId}?supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: newName }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive rename ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * Create a folder in Drive
 */
export async function createFolder(parentFolderId: string, folderName: string) {
  const token = await getAccessToken()

  const res = await fetch(
    `${DRIVE_API}/files?supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
        driveId: SHARED_DRIVE_ID(),
      }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive create folder ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * Move a file to a different folder
 */
export async function moveFile(
  fileId: string,
  newParentId: string,
) {
  const token = await getAccessToken()

  // Get current parents
  const meta = (await getFileMetadata(fileId)) as { parents?: string[] }
  const previousParents = meta.parents?.join(",") || ""

  const res = await fetch(
    `${DRIVE_API}/files/${fileId}?addParents=${newParentId}&removeParents=${previousParents}&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive move ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * List files in any folder (My Drive or Shared Drive)
 * Uses corpora=allDrives to search across all drives.
 */
export async function listFolderAnyDrive(folderId: string, maxResults = 50) {
  const token = await getAccessToken()
  const q = `'${folderId}' in parents and trashed = false`

  const url = new URL(`${DRIVE_API}/files`)
  url.searchParams.set("q", q)
  url.searchParams.set("corpora", "user")
  url.searchParams.set("supportsAllDrives", "true")
  url.searchParams.set("includeItemsFromAllDrives", "true")
  url.searchParams.set("fields", "files(id,name,mimeType,size,modifiedTime)")
  url.searchParams.set("pageSize", String(Math.min(maxResults, 100)))

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive API ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

// ─── My Drive Operations (no driveId) ───────────────────────

/**
 * Create a folder in My Drive (not Shared Drive).
 * Used for TD Operations mirror structure.
 */
export async function createFolderMyDrive(parentFolderId: string, folderName: string) {
  const token = await getAccessToken()

  const res = await fetch(
    `${DRIVE_API}/files?supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive create folder ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * Upload a file to My Drive (not Shared Drive).
 * Used for TD Operations mirror.
 */
export async function uploadFileMyDrive(
  parentFolderId: string,
  fileName: string,
  content: string,
  mimeType = "text/plain",
) {
  const token = await getAccessToken()

  const boundary = "----DriveUploadBoundary"
  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentFolderId],
  })

  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n")

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive upload ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * Ensure a folder path exists in My Drive, creating folders as needed.
 * Returns the ID of the deepest folder.
 * Example: ensureDrivePath("rootId", ["SOP", "Templates"]) → creates SOP/ and SOP/Templates/ if needed
 */
export async function ensureDrivePath(rootFolderId: string, pathSegments: string[]): Promise<string> {
  let currentParent = rootFolderId

  for (const segment of pathSegments) {
    // List current folder to check if subfolder exists
    const listing = (await listFolderAnyDrive(currentParent, 200)) as {
      files?: { id: string; name: string; mimeType: string }[]
    }

    const existing = listing.files?.find(
      (f) => f.name === segment && f.mimeType === "application/vnd.google-apps.folder",
    )

    if (existing) {
      currentParent = existing.id
    } else {
      // Create the folder
      const created = (await createFolderMyDrive(currentParent, segment)) as { id: string }
      currentParent = created.id
    }
  }

  return currentParent
}

/**
 * Upload a binary file (Buffer) to the Shared Drive.
 * Used for PDFs, images, and other non-text files.
 */
export async function uploadBinaryToDrive(
  fileName: string,
  data: Buffer,
  mimeType: string,
  parentFolderId: string,
) {
  const token = await getAccessToken()
  const boundary = "----DriveUploadBinaryBoundary"

  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentFolderId],
    driveId: SHARED_DRIVE_ID(),
  })

  // Build multipart body with binary content
  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
  )
  const contentHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  )
  const ending = Buffer.from(`\r\n--${boundary}--`)

  const body = Buffer.concat([metadataPart, contentHeader, data, ending])

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive binary upload ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * Download file as binary Buffer (for attachments, PDFs, images).
 * Returns { buffer, mimeType, fileName }
 */
export async function downloadFileBinary(fileId: string): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const token = await getAccessToken()
  const meta = (await getFileMetadata(fileId)) as { mimeType: string; name: string }

  const url = `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new Error(`Drive binary download ${res.status}: ${res.statusText}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: meta.mimeType,
    fileName: meta.name,
  }
}

/**
 * Download file content (text-based files only)
 */
export async function downloadFileContent(fileId: string): Promise<string> {
  const token = await getAccessToken()

  // Check if it's a Google Docs/Sheets/Slides (need export)
  const meta = (await getFileMetadata(fileId)) as { mimeType: string; name: string }

  let url: string
  if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
    // Google native file — export as appropriate format
    const exportMime = meta.mimeType.includes("spreadsheet")
      ? "text/csv"
      : meta.mimeType.includes("presentation")
      ? "text/plain"
      : "text/plain" // Docs → plain text
    url = `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`
  } else {
    // Regular file — direct download
    url = `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    throw new Error(`Drive download ${res.status}: ${res.statusText}`)
  }

  return res.text()
}

/**
 * Trash a file (soft-delete, recoverable for 30 days)
 */
export async function trashFile(fileId: string): Promise<{ id: string; name: string }> {
  const token = await getAccessToken()

  const res = await fetch(
    `${DRIVE_API}/files/${fileId}?supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Drive trash ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  const data = await res.json() as { id: string; name: string }
  return { id: data.id, name: data.name }
}

// ─── Tax Folder Helpers (shared by bank-statements + tax tools) ───

/**
 * Find the "3. Tax" subfolder in a client's Drive folder.
 * Returns the folder ID or null if not found.
 */
export async function findTaxFolder(driveFolderId: string): Promise<string | null> {
  const listing = (await listFolder(driveFolderId)) as {
    files?: { id: string; name: string; mimeType: string }[]
  }
  const taxFolder = listing.files?.find(
    f => f.mimeType === "application/vnd.google-apps.folder" && /^3\.\s*Tax/i.test(f.name)
  )
  return taxFolder?.id || null
}

/**
 * Find or create a year subfolder inside a Tax folder (e.g., "2025").
 * Returns the year folder ID.
 */
export async function findOrCreateYearFolder(taxFolderId: string, year: number): Promise<string> {
  const listing = (await listFolder(taxFolderId)) as {
    files?: { id: string; name: string; mimeType: string }[]
  }
  const yearFolder = listing.files?.find(
    f => f.name === String(year) && f.mimeType === "application/vnd.google-apps.folder"
  )
  if (yearFolder) return yearFolder.id
  const created = await createFolder(taxFolderId, String(year))
  return created.id
}
