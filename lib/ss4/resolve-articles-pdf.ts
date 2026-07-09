/**
 * Resolve the Articles of Organization PDF for a formation, from the `documents`
 * table (the source of truth) rather than by scanning a Drive folder.
 *
 * WHY (Slack bug report 2026-07-08): the signed-SS-4 IRS merge in
 * app/api/ss4-signed scans the Drive "1. Company" folder for an Articles PDF.
 * When the Articles are still parked in Supabase Storage (see
 * lib/flows/relocate-flow-storage-docs.ts for the root cause), that scan finds
 * nothing and the merge SILENTLY produces an SS-4-only package. This resolver is
 * the fallback: it looks up the formation's Articles documents row and fetches
 * the binary from wherever it actually lives — Drive (real `drive_file_id`) or
 * Supabase Storage (`storage:flow-uploads/...` pointer). The merge uses it when
 * the Drive scan comes up empty, so the IRS package is complete regardless of
 * where the binary sits; if this ALSO returns null the caller flags a loud,
 * non-silent warning instead of faxing an incomplete package.
 *
 * The core (`resolveArticlesPdf`) takes I/O via injected deps for DB-free unit
 * tests. `resolveArticlesForSs4` is the production wrapper.
 */

const STORAGE_BUCKET = "onboarding-uploads"
const STORAGE_PREFIX = "storage:"
const ARTICLES_FLOW_STAGE = "Filed with State"

export interface ArticlesDocRow {
  drive_file_id: string
  file_name: string
}

export interface ResolveArticlesDeps {
  /** The formation's Articles documents row (Drive or storage pointer), or null. */
  findArticlesDoc: () => Promise<ArticlesDocRow | null>
  /** Download a binary from a Supabase Storage bucket by path; null if missing. */
  downloadStorage: (bucket: string, path: string) => Promise<Buffer | null>
  /** Download a binary from Google Drive by file id; null if missing. */
  downloadDrive: (fileId: string) => Promise<Buffer | null>
}

/**
 * Pure core: return the Articles PDF bytes, or null if it can't be found /
 * fetched. Never throws — a failed fetch resolves to null so the caller can
 * flag the miss loudly.
 */
export async function resolveArticlesPdf(deps: ResolveArticlesDeps): Promise<Buffer | null> {
  try {
    const doc = await deps.findArticlesDoc()
    if (!doc?.drive_file_id) return null
    if (doc.drive_file_id.startsWith(STORAGE_PREFIX)) {
      const path = doc.drive_file_id.slice(STORAGE_PREFIX.length)
      return await deps.downloadStorage(STORAGE_BUCKET, path)
    }
    return await deps.downloadDrive(doc.drive_file_id)
  } catch {
    return null
  }
}

/**
 * Production wrapper: find the formation's Articles of Organization
 * (the "Filed with State" flow upload) for this service delivery / account and
 * return its PDF bytes from Drive or Supabase Storage. Best-effort — null when
 * no Articles row exists or the binary can't be fetched.
 */
export async function resolveArticlesForSs4(params: {
  serviceDeliveryId: string | null
  accountId: string | null
}): Promise<Buffer | null> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")

  const deps: ResolveArticlesDeps = {
    findArticlesDoc: async () => {
      // Prefer the SD-scoped "Filed with State" flow upload (the Articles).
      if (params.serviceDeliveryId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id/flow_stage not in generated types
        const { data } = await (supabaseAdmin as any)
          .from("documents")
          .select("drive_file_id, file_name")
          .eq("service_delivery_id", params.serviceDeliveryId)
          .eq("flow_stage", ARTICLES_FLOW_STAGE)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (data?.drive_file_id) return data as ArticlesDocRow
      }
      // Fallback: any Articles-named PDF on the account.
      if (params.accountId) {
        const { data } = await supabaseAdmin
          .from("documents")
          .select("drive_file_id, file_name")
          .eq("account_id", params.accountId)
          .ilike("file_name", "%articles%")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (data?.drive_file_id) return data as ArticlesDocRow
      }
      return null
    },
    downloadStorage: async (bucket, path) => {
      const { data } = await supabaseAdmin.storage.from(bucket).download(path)
      return data ? Buffer.from(await data.arrayBuffer()) : null
    },
    downloadDrive: async (fileId) => {
      const { downloadFileBinary } = await import("@/lib/google-drive")
      const { buffer } = await downloadFileBinary(fileId)
      return buffer
    },
  }

  return resolveArticlesPdf(deps)
}
