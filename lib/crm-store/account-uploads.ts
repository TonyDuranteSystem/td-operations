/**
 * When a flow that is NOT piloted yet (tax-return intake, onboarding setup …) reaches a company whose files
 * live in the new CRM store, `ensureCompanyFolder` refuses to make a Drive folder (job 685467b5). The
 * client's uploads must not then be filed nowhere: this saves each one into the store instead — the
 * company's "1. Company" folder, or the person's own storage for a passport — with no document type yet
 * (staff classify it), hidden from the client, and raises one alarm so staff see it. Idempotent: the same
 * upload path saves once (re-runs make no copies).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export class StoreOwnedAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StoreOwnedAccountError"
  }
}

export function isStoreOwnedRefusal(e: unknown): boolean {
  return e instanceof StoreOwnedAccountError || (e instanceof Error && e.name === "StoreOwnedAccountError")
}

export interface FallbackResult {
  saved: number
  failed: { path: string; error: string }[]
  ownerId: string | null
  /** the passport that went to the person's own storage — its bytes, for the passport-data read */
  passport?: { content: ArrayBuffer; mimeType: string; fileName: string } | null
}

export async function saveUploadsToStoreForAccount(p: {
  accountId: string
  flow: "tax-intake" | "onboarding" | "ra-switch"
  paths: string[]
  bucket?: string
  /** passport uploads of this person go to the person's own storage */
  passportContact?: { contactId: string; name: string } | null
}): Promise<FallbackResult> {
  const { storeOwnerForAccount } = await import("./browse")
  const { savePilotFile, ensurePersonOwner, raisePilotAlarm } = await import("./formation-pilot")
  const ownerId = await storeOwnerForAccount(p.accountId)
  const out: FallbackResult = { saved: 0, failed: [], ownerId }
  if (!ownerId) {
    await raisePilotAlarm("store_save_failed", { accountId: p.accountId, what: `${p.flow} uploads`, error: "company has no store owner yet (hand-over pending) — uploads left in the upload area" })
    out.failed = p.paths.map((path) => ({ path, error: "hand-over pending" }))
    return out
  }
  const bucket = p.bucket ?? "onboarding-uploads"
  let newlyAdded = 0
  for (const raw of p.paths) {
    const path = raw.replace(/^\/+/, "")
    try {
      const { data: blob, error } = await supabaseAdmin.storage.from(bucket).download(path)
      if (error || !blob) throw new Error(error?.message ?? "no data")
      const bytes = Buffer.from(await blob.arrayBuffer())
      const name = path.split("/").pop() || "upload"
      const isPassport = !!p.passportContact && /passport/i.test(name)
      const target = isPassport ? await ensurePersonOwner(p.passportContact!.contactId, p.passportContact!.name) : ownerId
      if (isPassport) {
        out.passport = { content: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, mimeType: blob.type || "application/pdf", fileName: name }
      }
      const w = await savePilotFile({
        ownerId: target, folderKind: isPassport ? "personal" : "company", name, bytes, mimeType: blob.type || null,
        documentType: isPassport ? "passport" : null, callerKey: `${p.flow}-upload:${p.accountId}:${path}`, published: false,
      })
      out.saved++
      if (w.status === "created" || w.status === "versioned") newlyAdded++
    } catch (e) {
      out.failed.push({ path, error: e instanceof Error ? e.message : String(e) })
    }
  }
  // one alarm when something new landed (or failed) — a re-run that changed nothing stays quiet
  if (newlyAdded > 0 || out.failed.length > 0) await raisePilotAlarm("store_unmapped_upload", { ownerId, accountId: p.accountId, what: `${p.flow} uploads saved to the new store without a document type — classify them`, saved: out.saved, failed: out.failed })
  return out
}
