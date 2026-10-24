/**
 * What the Upload panel already knows when "Choose files" opens the "Upload N files into …" window.
 *
 * Before: the window forgot the panel and filled in its own guess (the folder's default type, no person, no name), so
 * Antonio chose the document type twice (2026-10-23). Now the panel's choices carry over — but only when they still
 * make sense for what is being uploaded:
 *  - the TYPE only if the folder takes that type (a stale or "Custom…" pick falls back to the folder's default);
 *  - the PERSON only for a "2. Contacts" folder;
 *  - the shown NAME only for a single file (one name for several files would make them overwrite each other).
 * Pure, so it is tested without a browser.
 */
export interface DropPreset { type?: string; person?: string; name?: string }
export interface ResolvedDropPreset { type: string; person: string; name: string }

export function resolveDropPreset(
  preset: DropPreset | undefined,
  o: { allowedTypeSlugs: string[]; defaultType: string; folderIsContacts: boolean; fileCount: number },
): ResolvedDropPreset {
  const wanted = (preset?.type ?? '').trim()
  const type = wanted && wanted !== '__custom__' && o.allowedTypeSlugs.includes(wanted) ? wanted : o.defaultType
  const person = o.folderIsContacts ? (preset?.person ?? '').trim() : ''
  const name = o.fileCount === 1 ? (preset?.name ?? '').trim() : ''
  return { type, person, name }
}
