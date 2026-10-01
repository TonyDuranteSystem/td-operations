/**
 * The principal-address question on an Annual Report filing (Calendar "Mark Filed" dialog + To-Do card): what the
 * form holds while staff fill it in, and how it becomes the answer sent to the server. Pure — no network.
 */

export interface PrincipalOfficeDraft {
  choice: 'unchanged' | 'changed' | null
  address_line1: string
  address_line2: string
  city: string
  state: string
  zip: string
}

export const EMPTY_PRINCIPAL_OFFICE_DRAFT: PrincipalOfficeDraft = {
  choice: null,
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  zip: '',
}

/** The answer to send, or null while the question is not fully answered (the Mark filed button stays off). */
export function principalOfficeAnswer(d: PrincipalOfficeDraft):
  | { changed: false }
  | { changed: true; address_line1: string; address_line2: string; city: string; state: string; zip: string }
  | null {
  if (d.choice === 'unchanged') return { changed: false }
  if (d.choice === 'changed') {
    const address_line1 = d.address_line1.trim()
    const city = d.city.trim()
    const state = d.state.trim()
    const zip = d.zip.trim()
    if (!address_line1 || !city || !state || !zip) return null
    return { changed: true, address_line1, address_line2: d.address_line2.trim(), city, state, zip }
  }
  return null
}
