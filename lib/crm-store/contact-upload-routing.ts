/**
 * How the CONTACT page's "Upload Document" panel (app/api/crm/admin-actions/upload-document) reads its two dropdowns — one place, so the
 * save, the "a workspace step is waiting" check and its pop-up (dev job e3215801, "Door A") always agree on what "ITIN Letter" means.
 *
 *   document type label -> the Storage document type it is saved as;
 *   an ITIN document of a person's OWN documents (category "Contacts") goes to the person's ITIN folder; a passport stays in Personal documents.
 *
 * Pure: no database, safe in the browser.
 */

export interface ContactUploadRouting {
  /** The Storage document type slug the file is saved as. */
  storeType: string
  /** Set when the file goes to the person's ITIN folder (an ITIN document, category "Contacts"). */
  itinFolder: 'itin' | undefined
  /** The kind of folder the file lands in, for the "workspace step is waiting" check (null = not an ITIN-folder save). */
  checkFolderKind: 'itin' | null
}

export function contactUploadRouting(documentType: string, category: string | null | undefined): ContactUploadRouting {
  const dt = (documentType ?? '').toLowerCase()
  // A file saved hidden with NO type is closed to sharing ("choose its type first"), so a generic file gets the plain client-shareable type up front.
  const storeType = dt.includes('passport') ? 'passport' : dt.includes('itin') ? 'itin_letter' : /\bein\b/.test(dt) ? 'ein_letter_irs' : 'other_document'
  // an ITIN document (a letter, a form …) belongs in the person's ITIN folder; a passport follows the normal rule (Personal documents)
  const itinFolder: 'itin' | undefined = !dt.includes('passport') && dt.includes('itin') ? 'itin' : undefined
  // only the person's OWN documents (category "Contacts", the default when none is sent) are saved with a folder kind; every other category files into a company folder
  const isContacts = (category === undefined ? 'Contacts' : category) === 'Contacts'
  return { storeType, itinFolder, checkFolderKind: isContacts && itinFolder ? 'itin' : null }
}
