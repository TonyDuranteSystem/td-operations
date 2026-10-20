/**
 * SANDBOX QA ONLY — Drive access for the proof scripts that build fixtures in the TEST Shared Drive.
 *
 * Stop Drive S2 (dev job 264bb882): the Drive client refuses every write outside the one-way backup (lib/google-drive-write-scope.ts).
 * These proof scripts create and remove their own fixture folders in the TEST Shared Drive (the production-Drive guard still refuses any
 * other target outside production), so their fixture writes run inside the backup scope. Reads and the code UNDER test are untouched:
 * only the calls made through this handle are wrapped. Never import this from the application.
 */
const WRITE_VERBS = new Set([
  "uploadFile", "updateFileContent", "renameFile", "createFolder", "moveFile", "createFolderMyDrive", "uploadFileMyDrive", "ensureDrivePath",
  "uploadBinaryToDrive", "uploadBinaryToDriveUpsert", "updateBinaryFile", "trashFile", "findOrCreateYearFolder", "createTaggedFolder",
  "patchTaggedItem", "uploadStreamToDrive",
])

export async function driveFixture(): Promise<typeof import("../../lib/google-drive")> {
  const drive = await import("../../lib/google-drive")
  const { runAsStoreBackup } = await import("../../lib/google-drive-write-scope")
  return new Proxy(drive, {
    get(target, key: string) {
      const value = (target as unknown as Record<string, unknown>)[key]
      if (typeof value === "function" && WRITE_VERBS.has(key)) return (...args: unknown[]) => runAsStoreBackup(() => (value as (...a: unknown[]) => Promise<unknown>)(...args))
      return value
    },
  })
}
