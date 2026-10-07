/**
 * Staging for the PDF a staff member uploads on the E-Sign create screen.
 *
 * WHY THIS EXISTS (2026-10-07, td-bug "Can't send a document to sign to UGC
 * Italia LLC"): the create screen used to POST the whole PDF to our own API.
 * Vercel refuses any request body over 4.5 MB before our code runs (413
 * FUNCTION_PAYLOAD_TOO_LARGE, plain text, not configurable on any plan), so a
 * larger tax return failed with the generic "Could not create the envelope."
 * Measured on the sandbox 2026-10-07: 1 MB reaches our route, 6 MB gets the
 * platform 413. Vercel's own guidance is to upload straight to storage.
 *
 * HOW IT WORKS: the browser asks `POST /api/esign/upload-url` for a one-time
 * signed upload link, PUTs the PDF straight to storage, then calls the create
 * route with the staging PATH instead of the bytes. The server CLAIMS the
 * object (an atomic move to a name the client can never reference again),
 * reads it back, and runs the same PDF checks as before on the bytes it
 * actually holds — the client's declared size/type is a courtesy, never the
 * control.
 *
 * RULES THAT ARE LOAD-BEARING (each from the council review of this change):
 *  - The path is minted by the server as `esign-staging/<userId>/<uuid>.pdf`.
 *    It lives in its OWN prefix of the private `signature-requests` bucket,
 *    which also holds live signable documents under `esign/<token>/…`. The
 *    service-role client bypasses RLS, so the strict anchored shape below is
 *    the only read gate: a path outside it (a live envelope's PDF, a `..`
 *    traversal, another staff member's folder) must never reach `.download()`.
 *  - The caller's own user id is part of the path, so a staged file cannot be
 *    claimed by a different staff member.
 *  - CLAIM = atomic move. The second of two simultaneous requests for the same
 *    staged file finds nothing to move and stops, so a double-click or a
 *    replayed request can never create two envelopes with two sets of signing
 *    links. After the claim the original path no longer exists and the signed
 *    upload token (valid ~2 h) can only create a NEW object, never change the
 *    bytes that were validated.
 *  - The object is deleted on EVERY exit (success, rejection, server error).
 *    A retry re-uploads. A daily sweep (esign-reminders cron) removes anything
 *    abandoned — a staged tax return is PII and must not linger.
 */


import {
  ESIGN_MAX_PDF_BYTES,
  ESIGN_STAGING_BUCKET,
  ESIGN_STAGING_PREFIX,
  claimedPathFor,
  isStaleStagingObject,
  isStagingObjectPath,
  isValidStagingPath,
  tooLargeMessage,
} from "@/lib/esign/staging-shared"

export * from "@/lib/esign/staging-shared"

// `kind` is a string discriminant on purpose: this project compiles with strict:false, where a
// `{ ok: true } | { ok: false }` union does NOT narrow (see docs/systems/esign.md, ReopenDecision).
export type ClaimResult =
  | { kind: "claimed"; ok: true; bytes: Uint8Array; claimedPath: string }
  | { kind: "refused"; ok: false; status: number; error: string }

const GONE = "That upload is no longer available — please choose the file again."

/**
 * Claim a staged PDF for this user and return its bytes. Never trusts the
 * client's declared size: the real size is read from storage BEFORE the
 * download so an oversized object is rejected without buffering it.
 */
export async function claimStagedPdf(stagingPath: unknown, userId: string): Promise<ClaimResult> {
  if (!isValidStagingPath(stagingPath, userId)) {
    return { kind: "refused", ok: false, status: 400, error: "Invalid upload reference — please choose the file again." }
  }
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const store = supabaseAdmin.storage.from(ESIGN_STAGING_BUCKET)

  // 1) Real size, before downloading anything.
  const slash = stagingPath.lastIndexOf("/")
  const dir = stagingPath.slice(0, slash)
  const name = stagingPath.slice(slash + 1)
  const listed = await store.list(dir, { limit: 5, search: name })
  const entry = listed.data?.find(o => o.name === name)
  if (listed.error || !entry) return { kind: "refused", ok: false, status: 404, error: GONE }
  const size = Number((entry.metadata as { size?: number } | null)?.size ?? 0)
  if (size > ESIGN_MAX_PDF_BYTES) {
    await store.remove([stagingPath]).catch(() => {})
    return { kind: "refused", ok: false, status: 400, error: tooLargeMessage(size) }
  }

  // 2) Claim: atomic move. Only one concurrent request can win.
  const claimedPath = claimedPathFor(stagingPath)
  const moved = await store.move(stagingPath, claimedPath)
  if (moved.error) return { kind: "refused", ok: false, status: 409, error: GONE }

  // 3) Read the bytes we now own.
  const dl = await store.download(claimedPath)
  if (dl.error || !dl.data) {
    await store.remove([claimedPath]).catch(() => {})
    return { kind: "refused", ok: false, status: 404, error: GONE }
  }
  return { kind: "claimed", ok: true, bytes: new Uint8Array(await dl.data.arrayBuffer()), claimedPath }
}

/** Best-effort delete of a staged or claimed object. Never throws. */
export async function discardStaged(path: string | null | undefined): Promise<void> {
  if (!path || !isStagingObjectPath(path)) return
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    await supabaseAdmin.storage.from(ESIGN_STAGING_BUCKET).remove([path])
  } catch (err) {
    console.warn("[esign-staging] cleanup failed:", err)
  }
}

/**
 * Remove staged objects older than 24 h (abandoned uploads, rejected files,
 * a closed tab). Runs from the existing esign-reminders cron, so it needs no
 * new schedule. Never throws; returns how many it removed.
 */
export async function sweepEsignStaging(now: Date = new Date()): Promise<{ removed: number; error?: string }> {
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    const store = supabaseAdmin.storage.from(ESIGN_STAGING_BUCKET)
    const folders = await store.list(ESIGN_STAGING_PREFIX, { limit: 1000 })
    if (folders.error) return { removed: 0, error: folders.error.message }
    const stale: string[] = []
    for (const folder of folders.data ?? []) {
      // A folder entry has no id; files directly under the prefix (never minted by us) are ignored.
      if (folder.id) continue
      const files = await store.list(`${ESIGN_STAGING_PREFIX}/${folder.name}`, { limit: 1000 })
      for (const f of files.data ?? []) {
        const full = `${ESIGN_STAGING_PREFIX}/${folder.name}/${f.name}`
        if (!isStagingObjectPath(full)) continue
        if (isStaleStagingObject(f.created_at, now.getTime())) stale.push(full)
      }
    }
    for (let i = 0; i < stale.length; i += 100) {
      await store.remove(stale.slice(i, i + 100))
    }
    return { removed: stale.length }
  } catch (err) {
    return { removed: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
