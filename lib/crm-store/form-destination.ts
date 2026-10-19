/**
 * CRM Store — where a COMPANY's form package (summary PDF + the client's uploads) is filed (Stop Drive S1d, dev job 264bb882).
 *
 * The banking / closure / wizard completion flows used to read `accounts.drive_folder_id` and, when it was empty, quietly file
 * nothing (a company in the storage with no Drive folder — every new client — lost its form package). Now:
 *   - a company in storage      → the marker "account-storage:<id>" (`saveFormToDrive` files it in the company's storage)
 *   - a company left on Drive   → its own Drive folder (folder, no storage, not Closed / Cancelled)
 *   - anyone else                → no destination: the caller reports the plain sentence as an ERROR and a staff alarm is raised
 */
import { legacyDriveForAccount, raiseDriveWriteRefused, LEGACY_REFUSAL_SENTENCE, type LegacyRefusalReason } from "./legacy-drive"

// (the optional `undefined` members let callers read `.sentence` / `.folderId` without narrowing: tsconfig is not strict)
export type FormDestination =
  | { ok: true; folderId: string; via: "storage" | "legacy-drive"; reason?: undefined; sentence?: undefined }
  | { ok: false; reason: LegacyRefusalReason; sentence: string; folderId?: undefined; via?: undefined }

export interface FormDestinationDeps {
  storageMarker: (accountId: string) => Promise<string | null>
  /** "drive" | "moving" | "store": a company in the middle of its move takes nothing yet (the caller retries) */
  state: (accountId: string) => Promise<"drive" | "moving" | "store">
  legacy: typeof legacyDriveForAccount
  alarm: typeof raiseDriveWriteRefused
}

export async function formDestinationForAccount(accountId: string | null | undefined, flow: string, deps?: FormDestinationDeps): Promise<FormDestination> {
  const d: FormDestinationDeps = deps ?? {
    storageMarker: async (id: string): Promise<string | null> => (await (await import("./lead-form-store")).storageDestinationForForm({ accountId: id })).marker,
    state: async (id: string) => (await import("./switched-drive-guard")).companyDocState(id) as Promise<"drive" | "moving" | "store">,
    legacy: legacyDriveForAccount,
    alarm: raiseDriveWriteRefused,
  }
  if (!accountId) {
    const sentence = await d.alarm({ flow, reason: "no_company" })
    return { ok: false, reason: "no_company", sentence }
  }
  // a company in the middle of its move: no lookup that could throw, no alarm — a plain "try again", which the caller retries
  if ((await d.state(accountId)) === "moving") return { ok: false, reason: "moving", sentence: LEGACY_REFUSAL_SENTENCE.moving }
  const marker = await d.storageMarker(accountId)
  if (marker) return { ok: true, folderId: marker, via: "storage" }
  const v = await d.legacy(accountId)
  if (v.allowed) return { ok: true, folderId: v.folderId as string, via: "legacy-drive" }
  const sentence = await d.alarm({ flow, accountId, reason: v.reason as LegacyRefusalReason })
  return { ok: false, reason: v.reason as LegacyRefusalReason, sentence }
}
