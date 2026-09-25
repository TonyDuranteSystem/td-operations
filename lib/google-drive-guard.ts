/**
 * Hard guard: code that is NOT running against the production database can never
 * write to the production Google Drive (master plan v4.4 §8.5, slice 2; job 685467b5).
 *
 * Why a guard and not just a setting: sandbox turns Drive live with GOOGLE_DRIVE_LIVE=1
 * and is SUPPOSED to also point GOOGLE_SHARED_DRIVE_ID at the test Shared Drive — but
 * nothing enforced it (the id falls back to the production drive), and even with the
 * test drive set, writes land in whatever folder id the caller passes. Sandbox's copy of
 * client records can hold REAL production folder ids, so a sandbox write could still go
 * into a real client folder. This guard therefore checks the actual TARGET: outside
 * production, every write target must live in the configured test Shared Drive, and
 * My Drive (the owner's / support@'s personal drive) is never writable.
 *
 * "Production" = the production Supabase database (the same signal lib/supabase-admin.ts
 * uses) — NOT VERCEL_ENV, because the sandbox Vercel project has its own production slot.
 */

export const PRODUCTION_SUPABASE_REF = "ydzipybqeebtpcvsbtvs"
export const PRODUCTION_SHARED_DRIVE_ID = "0AOLZHXSfKUMHUk9PVA"

export type DriveWriteTarget =
  | { kind: "shared"; ids: string[] } // parent folder ids (create) or the file/folder ids being changed
  | { kind: "my_drive" }

export class DriveWriteRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DriveWriteRefusedError"
  }
}

type Env = Record<string, string | undefined>

export function isProductionDatabase(env: Env = process.env): boolean {
  return (env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(PRODUCTION_SUPABASE_REF)
    || (env.EXPECTED_SUPABASE_REF ?? "").trim() === PRODUCTION_SUPABASE_REF
}

/**
 * Throws DriveWriteRefusedError unless the write is allowed.
 * `lookupDriveId` returns the Shared Drive id an item lives in (null for My Drive / unknown).
 */
export async function assertDriveWriteAllowed(
  target: DriveWriteTarget,
  lookupDriveId: (id: string) => Promise<string | null>,
  env: Env = process.env,
): Promise<void> {
  if (isProductionDatabase(env)) return

  const testDrive = (env.GOOGLE_SHARED_DRIVE_ID ?? "").trim()
  if (!testDrive || testDrive === PRODUCTION_SHARED_DRIVE_ID) {
    throw new DriveWriteRefusedError(
      "Drive write refused outside production: GOOGLE_SHARED_DRIVE_ID must point at the TEST Shared Drive (never the production drive).",
    )
  }
  if (target.kind === "my_drive") {
    throw new DriveWriteRefusedError("Drive write refused outside production: My Drive is never writable from a non-production environment.")
  }
  const ids = target.ids.filter(Boolean)
  if (ids.length === 0) {
    throw new DriveWriteRefusedError("Drive write refused outside production: no target folder/file id to verify.")
  }
  for (const id of ids) {
    const driveId = await lookupDriveId(id)
    if (driveId !== testDrive) {
      throw new DriveWriteRefusedError(
        `Drive write refused outside production: target ${id} is not inside the test Shared Drive.`,
      )
    }
  }
}
