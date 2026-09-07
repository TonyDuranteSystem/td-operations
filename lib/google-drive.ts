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

/** Access tokens keyed by impersonated subject — see getAccessToken(). */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

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

/**
 * The OWNER's own Google identity and the single folder tree in his personal
 * My Drive that owner-scoped search is allowed to reach.
 *
 * Deliberately NOT the operational identity: the owner's accounting folder is
 * not shared with support@, and must not be. Impersonating him directly means
 * nothing has to be shared with the company identity to make search work, so
 * the privacy boundary that exists in Drive today stays exactly where it is.
 *
 * Scoping to a ROOT FOLDER (not his whole Drive) is the second half of that:
 * owner search reaches his accounting records and nothing else he happens to
 * keep in My Drive.
 */
const OWNER_IMPERSONATE_EMAIL = () =>
  process.env.GOOGLE_OWNER_IMPERSONATE_EMAIL || "antonio.durante@tonydurante.us"
const OWNER_DRIVE_ROOT_FOLDER_ID = () =>
  process.env.GOOGLE_OWNER_DRIVE_FOLDER_ID || "1FK9o4ipElMUJ3zhd7vgQr3uvBte_azok"

/**
 * Whether Drive writes/reads should be MOCKED. Historically this was a bare
 * `SANDBOX_MODE === '1'` at every call site, which coupled Drive to the global
 * sandbox flag — the same flag that also blocks outbound email and webhooks.
 * That made it impossible to exercise REAL Drive behaviour (folder races,
 * duplicate files, the wrong-folder misfile) in sandbox without also switching
 * email/webhooks back on.
 *
 * Now Drive can be made LIVE independently: set `GOOGLE_DRIVE_LIVE=1` to do real
 * Drive operations even under SANDBOX_MODE — WITHOUT touching the email/webhook
 * gating, which stays on their own SANDBOX_MODE checks elsewhere. SAFETY: only
 * ever point sandbox at a SEPARATE test Shared Drive via GOOGLE_SHARED_DRIVE_ID
 * (never the production drive), so real client folders can never be written.
 * Production leaves both unset → SANDBOX_MODE is not '1' → never mocked, normal.
 */
function driveMocked(): boolean {
  return process.env.SANDBOX_MODE === "1" && process.env.GOOGLE_DRIVE_LIVE !== "1"
}

// ─── Token Management ───────────────────────────────────────

/**
 * Get an access token for a specific impersonated user.
 *
 * `subject` defaults to the operational identity (support@) that every existing
 * caller uses. The owner-Drive path passes Antonio's own address instead — the
 * two identities see DIFFERENT files, which is the whole point: verified
 * 2026-08-30, support@ CANNOT see "My Drive > TD Accounting" at all, so the
 * owner's private financial documents are not reachable on the default path.
 *
 * The cache is therefore keyed BY SUBJECT. A single shared slot would hand one
 * identity's token to the other on the next call — silently leaking the owner's
 * Drive to every support@ caller, or breaking owner reads at random depending on
 * which identity warmed the cache first.
 */
async function getAccessToken(subject: string = IMPERSONATE_EMAIL()): Promise<string> {
  // Return cached token if still valid (5 min buffer)
  const cached = tokenCache.get(subject)
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  // Build JWT assertion
  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: SCOPES,
    sub: subject,
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
  tokenCache.set(subject, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  })

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

/**
 * Drive GET performed as the OWNER rather than the operational identity.
 *
 * No driveId/corpora is set: this targets his personal My Drive, not the client
 * Shared Drive. Kept separate from driveGet() so the two identities can never be
 * mixed up by an accidental parameter default.
 */
async function ownerDriveGet(endpoint: string, params?: Record<string, string>) {
  const token = await getAccessToken(OWNER_IMPERSONATE_EMAIL())
  const url = new URL(`${DRIVE_API}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }

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
 * Escape a value for embedding in a Drive `q` string literal.
 * Drive uses backslash escaping inside single-quoted literals; a raw apostrophe
 * (or backslash) would otherwise terminate the literal and change the query's
 * meaning. Backslash MUST be replaced first or it would double-escape the
 * apostrophes this same call just inserted.
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

/**
 * Collect the owner root folder plus its descendant folder IDs (breadth-first).
 *
 * Drive has no "search this subtree" operator — `'X' in parents` matches DIRECT
 * children only. Without this walk, an owner search would silently miss every
 * file that sits in a SUBFOLDER of the accounting folder, which is where the
 * statements actually live. Bounded by depth and count so a deep or wide tree
 * can never turn one search into unbounded API traffic.
 */
async function collectOwnerFolderIds(maxFolders = 100, maxDepth = 5): Promise<string[]> {
  const root = OWNER_DRIVE_ROOT_FOLDER_ID()
  const collected = [root]
  let frontier = [root]
  let depth = 0

  while (frontier.length > 0 && depth < maxDepth && collected.length < maxFolders) {
    const parentClause = frontier.map((id) => `'${escapeDriveQueryValue(id)}' in parents`).join(" or ")
    const result = (await ownerDriveGet("/files", {
      q: `(${parentClause}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id)",
      pageSize: "100",
    })) as { files?: { id: string }[] }

    const next = (result.files || []).map((f) => f.id).filter((id) => !collected.includes(id))
    for (const id of next) {
      if (collected.length >= maxFolders) break
      collected.push(id)
    }
    frontier = next
    depth++
  }

  return collected
}

/**
 * Search the OWNER's private accounting folder tree, as the owner.
 *
 * Runs under his own Google identity, so it sees files that the operational
 * support@ identity provably cannot (verified 2026-08-30). Callers MUST gate
 * this on the requester actually being the owner — see callerIsOwner() in
 * lib/mcp/auth-context.ts. It is a separate function rather than a flag on
 * searchFiles() precisely so an ungated call site is visible in review.
 */
export async function searchOwnerDriveFiles(
  query: string,
  mimeType?: string,
  maxResults = 25,
) {
  const folderIds = await collectOwnerFolderIds()
  const parentClause = folderIds.map((id) => `'${escapeDriveQueryValue(id)}' in parents`).join(" or ")

  let q = `name contains '${escapeDriveQueryValue(query)}' and (${parentClause})`
  if (mimeType) q += ` and mimeType = '${escapeDriveQueryValue(mimeType)}'`
  q += " and trashed = false"

  return ownerDriveGet("/files", {
    q,
    fields: "files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink)",
    pageSize: String(Math.min(maxResults, 100)),
  })
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
    // nextPageToken is requested so callers can TELL whether the listing was
    // truncated. Without it in the fields mask Drive omits it entirely, and a
    // caller cannot distinguish "exactly N files" from "N of many" — which
    // silently breaks any caller that reasons about the complete set of files
    // in a folder (see lib/mcp/tools/tax.ts, where a missed second P&L would
    // mean filing the wrong numbers).
    fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,thumbnailLink,iconLink)",
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'uploadFile', fileName })
    return { id: 'sandbox-mock', name: fileName }
  }
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'updateFileContent', fileId })
    return { id: fileId, name: newName ?? 'sandbox-mock' }
  }
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'renameFile', fileId })
    return { id: fileId, name: newName }
  }
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'createFolder', folderName })
    return { id: 'sandbox-mock', name: folderName }
  }
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'moveFile', fileId, newParentId })
    return { id: fileId }
  }
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'createFolderMyDrive', folderName })
    return { id: 'sandbox-mock', name: folderName }
  }
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'uploadFileMyDrive', fileName })
    return { id: 'sandbox-mock', name: fileName }
  }
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'ensureDrivePath', pathSegments })
    return 'sandbox-mock-folder-id'
  }
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
 * Google's "multipart" upload type (one request, metadata + bytes concatenated)
 * is only reliable under ~5MB per Google's own docs — larger files must use the
 * resumable protocol below. A real 18MB passport photo hit this ceiling with no
 * retry, silently leaving the file stuck in raw upload storage forever (dev_task:
 * Turcanu/Tacoli passport investigation). Kept comfortably under Google's limit.
 */
const MULTIPART_SAFE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Upload a binary file (Buffer) to the Shared Drive via Google's resumable
 * upload protocol (supports up to 5TB) — used for anything over
 * MULTIPART_SAFE_MAX_BYTES. Sent as a single PUT since the whole file is
 * already buffered in memory by the caller; no chunking needed at
 * passport/document sizes.
 */
async function uploadBinaryToDriveResumable(
  fileName: string,
  data: Buffer,
  mimeType: string,
  parentFolderId: string,
  token: string,
) {
  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentFolderId],
    driveId: SHARED_DRIVE_ID(),
  })

  const initRes = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(data.length),
      },
      body: metadata,
    },
  )

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}))
    throw new Error(
      `Drive resumable upload init ${initRes.status}: ${(err as { error?: { message?: string } }).error?.message || initRes.statusText}`
    )
  }

  const sessionUrl = initRes.headers.get("location")
  if (!sessionUrl) {
    throw new Error("Drive resumable upload init did not return a session URL")
  }

  const putRes = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(data.length),
    },
    body: new Uint8Array(data),
  })

  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}))
    throw new Error(
      `Drive resumable upload ${putRes.status}: ${(err as { error?: { message?: string } }).error?.message || putRes.statusText}`
    )
  }

  return putRes.json()
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'uploadBinaryToDrive', fileName })
    return { id: 'sandbox-mock', name: fileName }
  }
  const token = await getAccessToken()

  if (data.length > MULTIPART_SAFE_MAX_BYTES) {
    return uploadBinaryToDriveResumable(fileName, data, mimeType, parentFolderId, token)
  }

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
 * Build a name → fileId map of every non-trashed FILE directly inside a
 * folder (folders excluded, first occurrence of a name wins). Paginates past
 * the listFolder 100-item cap so the map is complete even for large folders.
 *
 * Returns null when the listing fails. Callers use this for duplicate-upload
 * guards (LT Program incident, 2026-07-07) and MUST treat null as "unknown"
 * and default to uploading — a stray duplicate beats a silently missing file.
 */
export async function folderFileNameMap(folderId: string): Promise<Map<string, string> | null> {
  try {
    const map = new Map<string, string>()
    let pageToken: string | undefined
    do {
      const params: Record<string, string> = {
        q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        driveId: SHARED_DRIVE_ID(),
        corpora: "drive",
        fields: "nextPageToken,files(id,name)",
        pageSize: "1000",
      }
      if (pageToken) params.pageToken = pageToken
      const result = await driveGet("/files", params) as { nextPageToken?: string; files?: { id: string; name: string }[] }
      for (const f of result.files || []) {
        if (!map.has(f.name)) map.set(f.name, f.id)
      }
      pageToken = result.nextPageToken
    } while (pageToken)
    return map
  } catch (e) {
    console.warn(`[folderFileNameMap] listing failed for folder ${folderId}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * Cheap single-file duplicate check: is there already a non-trashed file with
 * this exact name directly inside the folder? Returns `{ exists: true, id }`
 * when found, `{ exists: false }` when absent — AND on lookup error (callers
 * treat unknown as "upload anyway"; a stray duplicate beats a missing file).
 * Use this for single-file guards; use folderFileNameMap for loops.
 */
export async function fileExistsInFolder(folderId: string, fileName: string): Promise<{ exists: boolean; id?: string }> {
  try {
    const escaped = fileName.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
    const result = await driveGet("/files", {
      q: `'${folderId}' in parents and name = '${escaped}' and trashed = false`,
      driveId: SHARED_DRIVE_ID(),
      corpora: "drive",
      fields: "files(id,name)",
      pageSize: "1",
    }) as { files?: { id: string }[] }
    const f = result.files?.[0]
    return f ? { exists: true, id: f.id } : { exists: false }
  } catch (e) {
    console.warn(`[fileExistsInFolder] lookup failed for "${fileName}" in ${folderId}: ${e instanceof Error ? e.message : String(e)}`)
    return { exists: false }
  }
}

/**
 * Replace the CONTENT of an existing Drive file with new binary data
 * (files.update). Name, id, and folder stay the same — this is the
 * overwrite-in-place primitive for regenerated artifacts (P&L Excel,
 * form-summary PDFs) whose file name is stable across runs.
 */
export async function updateBinaryFile(fileId: string, data: Buffer, mimeType: string) {
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'updateBinaryFile', fileId })
    return { id: fileId, name: 'sandbox-mock' }
  }
  const token = await getAccessToken()
  const boundary = "----DriveUpdateBinaryBoundary"

  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n`
  )
  const contentHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  )
  const ending = Buffer.from(`\r\n--${boundary}--`)
  const body = Buffer.concat([metadataPart, contentHeader, data, ending])

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "PATCH",
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
      `Drive binary update ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`
    )
  }

  return res.json()
}

/**
 * Idempotent upload for GENERATED artifacts with a stable file name: if a
 * file with the same name already exists in the folder, its content is
 * overwritten in place (one file, fresh content); otherwise a new file is
 * created. Pass a pre-fetched folderFileNameMap to avoid re-listing when
 * upserting several files into the same folder.
 *
 * Failure posture: if the existence lookup OR the in-place update fails, we
 * fall through to a plain create — never silently omit the artifact.
 */
export async function uploadBinaryToDriveUpsert(
  fileName: string,
  data: Buffer,
  mimeType: string,
  parentFolderId: string,
  existingNames?: Map<string, string> | null,
): Promise<{ id: string; name: string; action: "created" | "overwritten" }> {
  let names = existingNames
  if (names === undefined) names = await folderFileNameMap(parentFolderId)
  const existingId = names?.get(fileName)

  if (existingId) {
    try {
      const updated = await updateBinaryFile(existingId, data, mimeType) as { id: string; name?: string }
      return { id: updated.id, name: updated.name || fileName, action: "overwritten" }
    } catch (e) {
      console.warn(`[uploadBinaryToDriveUpsert] in-place update failed for ${fileName} (${existingId}), falling back to create: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const created = await uploadBinaryToDrive(fileName, data, mimeType, parentFolderId) as { id: string; name?: string }
  return { id: created.id, name: created.name || fileName, action: "created" }
}

/**
 * Download file as binary Buffer (for attachments, PDFs, images).
 * Returns { buffer, mimeType, fileName }
 */
export async function downloadFileBinary(fileId: string): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  if (driveMocked()) {
    // Sandbox mode: mock the binary download so callers (e.g., sendEmail's
    // Drive-attachment build) don't 404 on the sandbox-mock IDs produced by
    // mocked upload functions. Returns a tiny placeholder PDF buffer.
    console.warn(`[SANDBOX] downloadFileBinary skipped for fileId='${fileId}'`)
    const placeholder = Buffer.from('%PDF-1.4\n%sandbox-mock-pdf\n%%EOF\n')
    return { buffer: placeholder, mimeType: 'application/pdf', fileName: `sandbox-mock-${fileId}.pdf` }
  }
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
 * What a Google-native file becomes when we need real BYTES for it.
 *
 * `downloadFileBinary` asks for `?alt=media`, which Drive REFUSES for anything
 * under `application/vnd.google-apps.*` (403 fileNotDownloadable) — so a Doc or
 * a Sheet cannot be attached to an email by that path at all. Exporting is the
 * only way to get bytes, and the extension has to be rewritten to match or the
 * recipient gets a file their machine cannot open.
 */
const NATIVE_EXPORTS: Array<{ match: string; mimeType: string; ext: string }> = [
  { match: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  { match: "presentation", mimeType: "application/pdf", ext: "pdf" },
  { match: "drawing", mimeType: "application/pdf", ext: "pdf" },
  // Docs and everything else Google-native → PDF, which is what we actually
  // send people.
  { match: "", mimeType: "application/pdf", ext: "pdf" },
]

/**
 * Binary bytes for a Drive file, EXPORTING it when it is a Google-native doc.
 *
 * Use this anywhere the bytes leave the building (email attachments). Returns
 * the filename with the exported extension applied, so "Engagement letter"
 * arrives as "Engagement letter.pdf" rather than as something unopenable.
 */
export async function downloadFileBinaryForSend(
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  if (driveMocked()) return downloadFileBinary(fileId)
  const meta = (await getFileMetadata(fileId)) as { mimeType: string; name: string }
  if (!meta.mimeType?.startsWith("application/vnd.google-apps.")) {
    return downloadFileBinary(fileId)
  }
  const rule = NATIVE_EXPORTS.find((r) => r.match && meta.mimeType.includes(r.match)) ?? NATIVE_EXPORTS[NATIVE_EXPORTS.length - 1]
  const token = await getAccessToken()
  const url = `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(rule.mimeType)}&supportsAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Drive export ${res.status}: ${res.statusText}`)
  const base = (meta.name || "document").replace(/\.[a-z0-9]{1,8}$/i, "")
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: rule.mimeType,
    fileName: `${base}.${rule.ext}`,
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
  if (driveMocked()) {
    console.warn('[SANDBOX] Drive write blocked:', { operation: 'trashFile', fileId })
    return { id: fileId, name: 'sandbox-blocked' }
  }
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
  const listing = (await listFolder(taxFolderId, 100)) as {
    files?: { id: string; name: string; mimeType: string }[]
    nextPageToken?: string
  }
  const yearFolder = listing.files?.find(
    f => f.name === String(year) && f.mimeType === "application/vnd.google-apps.folder"
  )
  if (yearFolder) return yearFolder.id
  // Creating a SECOND year folder is durable corruption: the writer would archive
  // into the invisible twin while every reader resolves the other, so the client's
  // confirmed workbook becomes unfindable. On a truncated listing we cannot know
  // the folder doesn't already exist — refuse rather than create a duplicate.
  if (listing.nextPageToken) {
    throw new Error(
      `Cannot resolve the ${year} folder: '3. Tax' holds more files than can be listed at once, so an existing ${year} folder may be hidden. Tidy the folder before archiving, or a duplicate ${year} folder would be created.`,
    )
  }
  const created = await createFolder(taxFolderId, String(year))
  return created.id
}
