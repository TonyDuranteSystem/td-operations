/**
 * "Office Lease and Services Agreement" — template_version 2 (Antonio 2026-10-10).
 *
 * ONE text for every place that shows or prints it: the signing page (React), the signed PDF the browser captures from that
 * page, and the server-side PDF (lib/lease-pdf.ts, used when staff regenerate a copy). They all render the blocks built
 * here, so the wording can never drift between them. Leases with template_version 1 keep the original text untouched.
 *
 * What it says, in short: Tony Durante LLC is a consulting firm and a CMRA; the client (owners abroad) gets the right to
 * use the office by appointment and Provider handles the client's mail; no separate rent or deposit; fixed term from the date
 * of the last signature to December 31 of that year (a new agreement is issued each January); the official address (10225 Ulmerton Rd 3D) and the mailing address (the same + the
 * client's own PMB number).
 */
import { companyOfficialRow, companyMailingRow, formatAddressString, pmbNumberFromSuite } from '@/lib/addresses'

export const AGREEMENT_V2_TITLE = 'OFFICE LEASE AND SERVICES AGREEMENT'
export const AGREEMENT_V2_VERSION = 2

/** Provider's address in the heading: the official address, one line. */
export const PROVIDER_ADDRESS_V2 = '10225 Ulmerton Rd 3D, Largo, FL 33771'
export const PROVIDER_NOTICE_EMAIL = 'support@tonydurante.us'

/** Photos of the premises (Exhibit A). Empty until the photographer delivers — with no photos the Exhibit is not printed at all. */
export interface ExhibitPhoto { url: string; caption: string }
export const EXHIBIT_A_PHOTOS: ExhibitPhoto[] = []

export interface AgreementV2Input {
  providerName: string
  clientCompany: string
  clientState: string | null
  clientEin: string | null
  clientRepName: string
  /** "Manager" / "Member" as stored on the lease. */
  clientRepTitle: string | null
  /** Company number "3D-318" — the PMB number is derived from it. */
  suiteNumber: string
  /** Typed by the client when signing; null before. */
  operatingAddress: string | null
  exhibitPhotos?: ExhibitPhoto[]
}

export type AgreementBlock =
  | { t: 'title'; text: string }
  | { t: 'center'; text: string }
  | { t: 'para'; text: string; label?: string; italic?: boolean }
  | { t: 'heading'; text: string }
  | { t: 'address'; lines: string[] }
  | { t: 'party'; role: string; lines: string[] }

export interface AgreementV2Doc {
  blocks: AgreementBlock[]
  /** Closing signature block data (renderers draw the signature area themselves). */
  officialAddressLine: string
  mailingAddressLine: string
  exhibitPhotos: ExhibitPhoto[]
}

/** "a Wyoming" / "an Illinois" / "a Utah" (the sound, not the letter, decides). */
function article(state: string | null): string {
  if (!state) return 'a'
  return /^[aeio]/i.test(state.trim()) ? `an ${state}` : `a ${state}`
}

/** "limited liability company" unless the name says it is a corporation (Inc / Corp / Corporation). */
function entityWord(companyName: string): string {
  return /\b(inc|incorporated|corp|corporation)\.?\s*$/i.test(companyName.trim()) ? 'corporation' : 'limited liability company'
}

/** Both company addresses exactly as they print in Section 1.2. Throws if the number is not a numbered TD suite. */
export function agreementAddresses(suiteNumber: string): { official: string[]; mailing: string[]; officialLine: string; mailingLine: string } {
  if (!pmbNumberFromSuite(suiteNumber)) throw new Error(`"${suiteNumber}" is not a numbered TD suite — no PMB can be printed`)
  const official = companyOfficialRow(suiteNumber)!
  const mailing = companyMailingRow(suiteNumber)!
  const cityLine = `${official.city}, ${official.state} ${official.zip}`
  return {
    official: [official.address_line1, cityLine],
    mailing: [mailing.address_line1, cityLine],
    officialLine: formatAddressString(official)!,
    mailingLine: formatAddressString(mailing)!,
  }
}

export function buildAgreementV2(input: AgreementV2Input): AgreementV2Doc {
  const a = agreementAddresses(input.suiteNumber)
  const photos = input.exhibitPhotos ?? EXHIBIT_A_PHOTOS
  const hasExhibit = photos.length > 0
  const client = input.clientCompany
  const ein = input.clientEin ? `, EIN ${input.clientEin}` : ''
  const rep = input.clientRepTitle ? `${input.clientRepName}, ${input.clientRepTitle} of Client` : `${input.clientRepName}, who signs for Client`

  const b: AgreementBlock[] = []
  b.push({ t: 'title', text: AGREEMENT_V2_TITLE })
  b.push({ t: 'para', text: 'This Office Lease and Services Agreement ("Agreement") is made and effective on the date of the last signature below (the "Effective Date"). It is made as part of, and depends on, the annual service agreement between the parties (the "Annual Service Agreement"). The parties are:' })
  b.push({ t: 'party', role: 'PROVIDER', lines: [`${input.providerName}, a Florida limited liability company, ${PROVIDER_ADDRESS_V2}, notices to ${PROVIDER_NOTICE_EMAIL} ("Provider").`] })
  b.push({ t: 'party', role: 'CLIENT', lines: [`${client}, ${article(input.clientState)} ${entityWord(client)}${ein}, address of record as stated in Section 1.2 ("Client"), represented by ${rep}.`] })

  b.push({ t: 'heading', text: 'Background' })
  b.push({ t: 'para', label: 'A.', text: 'Provider is a consulting firm. Its principal, Antonio Durante, is an IRS Certified Acceptance Agent, a tax return preparer, a notary public and a business consultant.' })
  b.push({ t: 'para', label: 'B.', text: 'Provider manages the U.S. business affairs of companies whose owners live outside the United States, including tax work, state compliance, and administrative and operational consulting.' })
  b.push({ t: 'para', label: 'C.', text: 'Provider is a commercial mail receiving agency ("CMRA") registered with the U.S. Postal Service. Provider receives and handles its clients\' mail so that it is managed safely, lawfully and by a verified, accountable agent.' })
  b.push({ t: 'para', label: 'D.', text: 'Client\'s owner(s) live outside the United States.' })
  b.push({ t: 'para', label: 'E.', text: 'The Premises described below are Provider\'s own working office. Their use is not offered to the public and is available only to clients who have an annual service agreement with Provider for professional services.' })

  b.push({ t: 'heading', text: '1. Client\'s Operating Address and U.S. Office' })
  b.push({
    t: 'para', label: '1.1',
    text: input.operatingAddress
      ? `Client's day-to-day business operations are run from ${input.operatingAddress} (the "Operating Address"). Client will tell Provider in writing if it changes.`
      : 'Client\'s day-to-day business operations are run from the address Client enters when signing (the "Operating Address"). Client will tell Provider in writing if it changes.',
  })
  b.push({ t: 'para', label: '1.2', text: 'The Premises described in Section 2 are Client\'s United States office. Client\'s official address, which it uses for its United States filings, is:' })
  b.push({ t: 'address', lines: [client, ...a.official] })
  b.push({ t: 'para', text: 'Client\'s mailing address, for the mail and packages Provider handles under Section 3, is:' })
  b.push({ t: 'address', lines: [client, ...a.mailing] })
  b.push({ t: 'para', text: 'Client will use these addresses exactly as written, including "PMB", on its filings, accounts and correspondence, and will not write the PMB number as part of a suite number. The addresses on Client\'s Form 1583, EIN records and state filings will match this Section. From there Provider manages Client\'s U.S. affairs and handles its mail, in addition to Provider\'s professional services.' })

  b.push({ t: 'heading', text: '2. The Premises and Right of Use' })
  b.push({ t: 'para', label: '2.1', text: `"Premises" means Suite 3D at 10225 Ulmerton Rd, Largo, FL 33771${hasExhibit ? ', including the office areas shown in Exhibit A' : ''}. Provider grants Client the right, by appointment with Provider, to use a furnished office with a desk, a computer connection and internet access, and the meeting room, on the days Client's owner visits the United States. Client may meet its own clients and business contacts in the meeting room. These spaces are shared with Provider's other clients and are not reserved for Client alone; Provider will make an available office or the meeting room open to Client at the time agreed.` })
  b.push({ t: 'para', label: '2.2', text: `Client may use the lobby (not staffed), the kitchenette and the restroom while visiting.${hasExhibit ? ' Photographs of the Premises are attached as Exhibit A.' : ''} Furniture may be moved or replaced without changing Client's rights.` })

  b.push({ t: 'heading', text: '3. Provider\'s Services and Mail Handling' })
  b.push({ t: 'para', label: '3.1', text: 'Provider\'s services for Client are set out in the Annual Service Agreement. Depending on the package, they include preparing and filing tax returns, state annual reports and renewals, arranging a registered agent, handling communications with the IRS and the state, and operational consulting and support throughout the year.' })
  b.push({ t: 'para', label: '3.2', text: 'Provider receives and handles mail and packages addressed to Client at the mailing address in Section 1.2 as a CMRA registered with the U.S. Postal Service. Postal rules require every addressee to be identified on its own PS Form 1583, with two forms of identification, before mail is accepted for it. This procedure protects Client: mail is accepted only for addressees verified on file, and mail for anyone else is returned to the sender.' })
  b.push({ t: 'para', label: '3.3', text: 'Before Provider begins handling Client\'s mail, Client\'s authorized person completes PS Form 1583 and provides two forms of identification. Provider keeps the form during this Agreement and for at least six months after it ends. Client states on the form the address to which its mail is to be remailed, and keeps its information current, including telling Provider promptly if an officer, address, name or identification changes or expires.' })
  b.push({ t: 'para', label: '3.4', text: 'How mail is handled. Provider logs each item received and notifies Client through the client portal. On Client\'s request, and with Client\'s authorization to open it, Provider scans mail and places the scan in Client\'s portal documents. Receiving, logging, notifying and scanning are included in the Annual Service Agreement. Forwarding mail or packages is paid by Client for each shipment and is sent after payment. Debit cards and similar items are held securely until Client arranges and pays for shipping.' })
  b.push({ t: 'para', label: '3.5', text: 'Provider will not accept mail for any addressee without a complete, current PS Form 1583 and will return that mail as the postal rules require. Provider does not refuse mail for an addressee on file.' })
  b.push({ t: 'para', label: '3.6', text: 'On Client\'s written request, Provider will confirm to a bank or other institution that this Agreement is genuine and in force.' })

  b.push({ t: 'heading', text: '4. Term' })
  b.push({ t: 'para', label: '4.1', text: 'The term is fixed. It begins on the Effective Date and ends on December 31 of the year in which the Effective Date falls (the "Term").' })
  b.push({ t: 'para', label: '4.2', text: 'This Agreement does not renew automatically. While Client\'s Annual Service Agreement continues, Provider will issue a new agreement each January for that calendar year, for Client to sign. Until the new agreement is signed, Provider continues to provide the same services and to handle Client\'s mail on the same terms.' })

  b.push({ t: 'heading', text: '5. Consideration' })
  b.push({ t: 'para', text: 'In consideration of the fees Client pays under the Annual Service Agreement, Provider grants the rights in this Agreement and provides the mail handling in Section 3.4 other than forwarding. No separate rent and no security deposit are payable.' })

  b.push({ t: 'heading', text: '6. Access' })
  b.push({ t: 'para', text: 'Provider\'s office is currently staffed by Antonio Durante alone. Access to the Premises is by appointment with Provider. There is no reception service.' })

  b.push({ t: 'heading', text: '7. Use and Conduct' })
  b.push({ t: 'para', text: 'Client will use the Premises only for lawful business purposes, will leave the spaces clean and in the condition found, and will be responsible for damage caused by Client or its guests. Client will not use the address or the Premises for any unlawful or deceptive purpose.' })

  b.push({ t: 'heading', text: '8. Termination and What Happens After' })
  b.push({ t: 'para', label: '8.1', text: 'Provider may end this Agreement immediately by written notice if the address or the Premises is used unlawfully or deceptively, if Client gives false identity information, if the U.S. Postal Service or the law requires it, or if the Annual Service Agreement ends or is unpaid.' })
  b.push({ t: 'para', label: '8.2', text: 'Otherwise either party may end this Agreement before the end of the Term only if the other party materially breaches it and does not correct the breach within thirty (30) days after written notice.' })
  b.push({ t: 'para', label: '8.3', text: 'When this Agreement ends and is not replaced by a new agreement, Client will stop using the addresses in Section 1.2 as its office and mailing addresses and will update its records with the state, the IRS, its banks and other institutions.' })
  b.push({ t: 'para', label: '8.4', text: 'As the postal rules require, Provider will remail Client\'s mail for at least six (6) months after this Agreement ends and is not replaced by a new agreement, with new postage paid by Client. Client may waive remailing of all or specified types of mail in writing, but may not instruct Provider to refuse, return or discard it. Provider will record the termination date on Client\'s PS Form 1583.' })

  b.push({ t: 'heading', text: '9. General' })
  b.push({ t: 'para', label: '9.1', text: 'Accuracy. Client confirms that the information it gives Provider, including its Operating Address and the identity of its owners, is true and complete. Client is responsible for the information it gives to banks and other third parties. Provider does not guarantee that any bank, broker or other institution will accept Client\'s address or documents.' })
  b.push({ t: 'para', label: '9.2', text: 'Confidentiality. Provider keeps Client\'s information and mail confidential and uses them only to perform the services, or as the law or the postal rules require, including disclosure to the U.S. Postal Service and law enforcement when required.' })
  b.push({ t: 'para', label: '9.3', text: 'Mail and liability. The contents of mail are at Client\'s risk. Provider is not liable for delay, loss or damage caused by the U.S. Postal Service, carriers or events beyond its control, or for indirect or consequential damages. Provider\'s total liability is limited to the fees Client paid under the Annual Service Agreement for the Term.' })
  b.push({ t: 'para', label: '9.4', text: 'Relocation. If Provider moves its office, it will give Client at least sixty (60) days\' written notice and a replacement address, and Client will update its records.' })
  b.push({ t: 'para', label: '9.5', text: 'Order of documents. If this Agreement and the Annual Service Agreement conflict, this Agreement controls as to the Premises and the mail handling, and the Annual Service Agreement controls otherwise.' })
  b.push({ t: 'para', label: '9.6', text: 'Authority. Each person signing for a party confirms that he or she is authorized to sign for it.' })
  b.push({ t: 'para', label: '9.7', text: 'Assignment. Neither party may assign this Agreement without the other\'s written consent.' })
  b.push({ t: 'para', label: '9.8', text: 'Language. This Agreement is made in English. If Client is given a translation for convenience, the English text controls.' })
  b.push({ t: 'para', label: '9.9', text: 'Signing record. This Agreement may be signed electronically. Provider keeps the record of the electronic signatures and provides it on request.' })
  b.push({ t: 'para', label: '9.10', text: 'Notices may be given by email to Provider at the address on the first page and to Client at the email address Provider has on file for it. This Agreement is governed by Florida law, and the courts of Pinellas County, Florida have exclusive jurisdiction. This is the entire agreement about the Premises and the mail handling described here. If a provision is invalid, the rest remains in force. This Agreement may be signed in counterparts.' })

  return { blocks: b, officialAddressLine: a.officialLine, mailingAddressLine: a.mailingLine, exhibitPhotos: photos }
}

/** The calendar date (YYYY-MM-DD) in New York right now — the date written next to both signatures. Server-issued, never the browser's clock. */
export function newYorkToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** "2026-10-10" -> "October 10, 2026" (no timezone shift). */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`
}

/** "2026-10-10" -> "2026-12-31" (the term ends on December 31 of the year it starts). */
export function endOfYearIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) throw new Error(`bad date ${iso}`)
  return `${m[1]}-12-31`
}

/** Calendar months from the start date's month through December, counting both ("2026-10-10" -> 3). Shown only as a rough length. */
export function termMonthsThroughYearEnd(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) throw new Error(`bad date ${iso}`)
  return 13 - parseInt(m[2], 10)
}

/** "2026-10-10" + 12 months -> "2027-10-10" (the same day next year; Feb 29 -> Feb 28). */
export function addMonthsIso(iso: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) throw new Error(`bad date ${iso}`)
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10)
  const total = y * 12 + mo + months
  const ny = Math.floor(total / 12), nm = total % 12
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}
