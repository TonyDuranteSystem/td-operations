/**
 * Where the closure wizard pinned a package: the "Company closure_<name>" folder under the PERSON's storage, if it did (Company Closure part B).
 * Pure. A later staff review of the same submission must not re-file the package into a company's storage when the wizard deliberately kept it
 * with the person (the name / EIN the client wrote did not match the company the job is linked to) — bug hunt 2026-11-06.
 */
export function pinnedPersonFolder(archiveMeta: unknown): string | null {
  const f = (archiveMeta as { pinned_plan?: { storeRootSubFolder?: unknown } } | null | undefined)?.pinned_plan?.storeRootSubFolder
  return typeof f === "string" && f.startsWith("Company closure_") ? f : null
}
