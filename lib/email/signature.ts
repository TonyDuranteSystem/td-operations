/**
 * Outgoing email signatures — the ONE definition, shared by every send path.
 *
 * Before this module there were three different shells and no signature:
 *   - compose put a logo BANNER on top plus a thin footer with no human name;
 *   - replies were deliberately Gmail-parity plain and carried nothing at all;
 *   - the worker had a one-line sign-off, DUPLICATED byte-for-byte across
 *     lib/ai-agent/tools.ts and lib/inbox/worker-email-send.ts.
 * All four sites now call in here, so the signature cannot drift again.
 *
 * THREE RULES THIS FILE EXISTS TO HOLD:
 *
 * 1. ASCII ONLY. sanitizeToAscii() in lib/operations/email.ts rewrites em
 *    dashes, curly quotes, bullets and ellipses on the compose/gmail_send
 *    path. A signature built from typographic characters is mangled on one
 *    path and not the others, which is worse than plain. So: "-", not em
 *    dashes. Straight quotes. No bullets.
 *
 * 2. EVERY FACT LIVES IN THE TEXT. Outlook and most corporate clients block
 *    remote images until the reader clicks "show images", so the photo and
 *    the logo are decoration — never the carrier of a phone number, an
 *    address or a name. Verified against the mockup Antonio approved
 *    2026-08-05: with images off the block still reads completely.
 *
 * 3. THE PLAIN-TEXT PART IS AUTHORED, NOT DERIVED. sendEmail() falls back to
 *    tag-stripping the HTML when no body_text is supplied, which turns a
 *    table-based signature into junk. Callers MUST pass buildSignatureText()
 *    alongside buildSignatureHtml().
 *
 * Known and accepted (Antonio, 2026-08-05): the round photo renders SQUARE in
 * Outlook for Windows, which draws mail with Word and ignores border-radius.
 */

import { APP_BASE_URL } from "@/lib/config"

// ─── Variants ───────────────────────────────────────────────

/**
 * What the sender picked for this one email.
 *  - "gala" / "hat" -> full signature: banner logo, plus Antonio's photo when
 *    the mail leaves from his own address (support has no photo by design).
 *  - "text"         -> COMPACT: the identity block with a small TD mark and
 *    nothing else - no portrait, no banner. The default on replies so a face
 *    and a wide banner do not repeat down a thread. The mark stays because
 *    Antonio wants the TD logo present on every signed email, however small
 *    (2026-08-05: "I want the logo TD everywhere also in text only").
 *  - "none"         -> NOTHING. Not a block, not a sign-off, not a stray
 *    blank line. For the one-line reply mid-thread where any signature is
 *    noise (Antonio, 2026-08-05).
 */
export const SIGNATURE_VARIANTS = ["gala", "hat", "text", "none"] as const
export type SignatureVariant = (typeof SIGNATURE_VARIANTS)[number]

/**
 * Whether this variant produces anything at all.
 *
 * Call sites MUST branch on this rather than appending an empty string:
 * concatenating "" still leaves the separator around it, which is how a
 * "no signature" email ends up with two trailing blank lines before the
 * quoted history.
 */
export function hasSignature(variant: SignatureVariant): boolean {
  return variant !== "none"
}

/** New emails lead with the award portrait (Antonio, 2026-08-05). */
export const DEFAULT_SIGNATURE_VARIANT: SignatureVariant = "gala"
/** Replies stay text-only unless the sender says otherwise, same decision. */
export const DEFAULT_REPLY_SIGNATURE_VARIANT: SignatureVariant = "text"

/** Which mailbox the mail leaves from. Drives WHOSE signature is used. */
export const SIGNATURE_SENDERS = ["support", "antonio"] as const
export type SignatureSender = (typeof SIGNATURE_SENDERS)[number]

/**
 * Narrow untrusted input (a request body, a query param) to a real variant.
 * Anything unrecognised falls back rather than throwing: a bad value must
 * never be the reason a staff member's email fails to send.
 */
export function parseSignatureVariant(
  value: unknown,
  fallback: SignatureVariant = DEFAULT_SIGNATURE_VARIANT
): SignatureVariant {
  return SIGNATURE_VARIANTS.includes(value as SignatureVariant)
    ? (value as SignatureVariant)
    : fallback
}

/** Same narrowing for the sending mailbox. Unknown -> the shared mailbox. */
export function parseSignatureSender(value: unknown): SignatureSender {
  return value === "antonio" ? "antonio" : "support"
}

/** The real Workspace mailboxes behind each key. */
export const SIGNATURE_MAILBOX_ADDRESSES: Record<SignatureSender, string> = {
  support: "support@tonydurante.us",
  antonio: "antonio.durante@tonydurante.us",
}

/**
 * Which signature belongs on mail leaving a given address.
 *
 * Matched on the FULL address, never on a prefix: "antonio" as a prefix test
 * would also claim antonio.someoneelse@ or a lookalike, putting his name and
 * direct line on mail that is not his. Anything unrecognised - including the
 * GOOGLE_IMPERSONATE_EMAIL default, which is not guaranteed to be either of
 * ours - gets the company block, which is true of any TD mailbox.
 */
export function signatureSenderForAddress(
  address: string | null | undefined
): SignatureSender {
  const bare = (address ?? "")
    .toLowerCase()
    .replace(/^.*</, "")
    .replace(/>.*$/, "")
    .trim()
  return bare === SIGNATURE_MAILBOX_ADDRESSES.antonio ? "antonio" : "support"
}

/**
 * The From display name for a mailbox. Mail from Antonio's address signed
 * "Antonio Noel Durante" must not arrive labelled as the company - the From
 * line is the first identity a recipient reads, and it should agree with the
 * block at the bottom.
 */
export function signatureFromName(sender: SignatureSender): string {
  return sender === "antonio" ? ANTONIO_NAME : COMPANY_NAME
}

// ─── The facts ──────────────────────────────────────────────
//
// Sourced from what the business already uses, not invented:
//   company phone  - lib/invoice-pdf.ts, lib/pdf/1040nr-fill.ts,
//                    lib/pdf/w7-fill.ts, lib/mcp/tools/closure.ts
//   Antonio direct - lib/pdf/ss4-fill.ts (APPLICANT_PHONE), and mapped to
//                    "Antonio Durante" in app/api/inbox/messages/[id]/route.ts
//   address        - lib/form-to-drive.ts (the PDF footer)
//   brand red      - sampled from the logo artwork itself

const COMPANY_NAME = "Tony Durante LLC"
const COMPANY_ADDRESS = "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771"
const COMPANY_PHONE = "+1 (727) 452-1093"
const COMPANY_EMAIL = "support@tonydurante.us"

const ANTONIO_NAME = "Antonio Noel Durante"
const ANTONIO_TITLE = "Executive Director"
const ANTONIO_PHONE = "+1 727 423 4285"
const ANTONIO_EMAIL = "antonio.durante@tonydurante.us"

/** Brand red, sampled from the TD mark. Used for the rule and the links. */
export const BRAND_RED = "#BD2033"
const INK = "#1a1a1a"
const MUTED = "#6b7280"
const RULE = "#e5e7eb"
const FONT = "Arial,Helvetica,sans-serif"

const SIGNOFF = "Best regards,"

/** Photo files live in public/images and are square, 192px (2x of 96px). */
const PHOTO_FILES: Record<Exclude<SignatureVariant, "text" | "none">, string> = {
  gala: "signature-antonio-gala.jpg",
  hat: "signature-antonio-hat.jpg",
}

const LOGO_FILE = "tony-logos.png"

/**
 * The standalone red TD mark — the same file the app uses as its icon, which
 * is the shape people already recognise (Antonio, 2026-08-05). On the compact
 * variant it sits beside the company block the way Antonio's portrait sits
 * beside his, giving mail from the shared mailbox a recognisable face.
 */
const TD_MARK_FILE = "signature-td-mark.png"

/**
 * Company full-variant artwork (Antonio, 2026-08-07, from Luca's Team Chat
 * review: the old layout showed the TD logo twice — the small mark beside the
 * block AND again inside the wide banner — and the script tagline read busy):
 *  - the LOCKUP: TD mark with "TONY DURANTE" under it, no tagline. Replaces
 *    the small mark beside the company block on full variants.
 *  - the BADGES strip: ONLY the three certification badges, larger, centered.
 *    Replaces the wide banner on company mail. Antonio's own mail keeps the
 *    original banner — his block carries his portrait, so the banner is the
 *    only TD logo on it and stays.
 * Both cropped from the same tony-logos.png artwork; canvases are exact
 * multiples of their render size (480x336 -> 120x84, 520x160 -> 260x80) so
 * the explicit width/height attributes stay integers.
 */
const TD_LOCKUP_FILE = "signature-td-lockup.png"
const BADGES_FILE = "signature-badges.png"

export function signatureMarkUrl(baseUrl: string = APP_BASE_URL): string {
  return assetUrl(TD_MARK_FILE, baseUrl)
}

export function signatureLockupUrl(baseUrl: string = APP_BASE_URL): string {
  return assetUrl(TD_LOCKUP_FILE, baseUrl)
}

export function signatureBadgesUrl(baseUrl: string = APP_BASE_URL): string {
  return assetUrl(BADGES_FILE, baseUrl)
}

interface Identity {
  name: string
  title: string | null
  address: string
  phone: string
  email: string
  /** Only Antonio's block carries a portrait; the company block never does. */
  showsPhoto: boolean
}

function identityFor(sender: SignatureSender): Identity {
  return sender === "antonio"
    ? {
        name: ANTONIO_NAME,
        title: `${ANTONIO_TITLE}, ${COMPANY_NAME}`,
        address: COMPANY_ADDRESS,
        phone: ANTONIO_PHONE,
        email: ANTONIO_EMAIL,
        showsPhoto: true,
      }
    : {
        name: COMPANY_NAME,
        title: null,
        address: COMPANY_ADDRESS,
        phone: COMPANY_PHONE,
        email: COMPANY_EMAIL,
        showsPhoto: false,
      }
}

// ─── URLs ───────────────────────────────────────────────────

/**
 * Absolute URLs only. A relative src is dead the moment the message leaves
 * our server, and baseUrl is injectable so tests do not depend on env.
 */
function assetUrl(file: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/${file}`
}

export function signaturePhotoUrl(
  variant: SignatureVariant,
  baseUrl: string = APP_BASE_URL
): string | null {
  if (variant === "text" || variant === "none") return null
  return assetUrl(PHOTO_FILES[variant], baseUrl)
}

export function signatureLogoUrl(baseUrl: string = APP_BASE_URL): string {
  return assetUrl(LOGO_FILE, baseUrl)
}

// ─── Options ────────────────────────────────────────────────

export interface SignatureOptions {
  /** Which mailbox this email leaves from. */
  sender: SignatureSender
  /** What the sender picked for this one email. */
  variant: SignatureVariant
  /**
   * Prefix the block with "Best regards,". True for automated sends, which
   * have no typed closing. Set false when the author writes their own.
   */
  includeSignoff?: boolean
  /** Overridable so tests never depend on deployment config. */
  baseUrl?: string
}

// ─── Plain text ─────────────────────────────────────────────

/**
 * The text/plain half. Authored deliberately - see rule 3 in the file header.
 * Uses \n; MIME builders normalise line endings themselves.
 */
export function buildSignatureText(options: SignatureOptions): string {
  if (!hasSignature(options.variant)) return ""
  const id = identityFor(options.sender)
  const lines: string[] = []

  if (options.includeSignoff !== false) lines.push(SIGNOFF, "")

  lines.push(id.name)
  if (id.title) lines.push(id.title)
  lines.push(id.address, id.phone, id.email)

  return lines.join("\n")
}

// ─── HTML ───────────────────────────────────────────────────

function detailRows(id: Identity): string {
  const row = (content: string) =>
    `<div style="font-size:13px;line-height:1.5">${content}</div>`

  return [
    `<div style="font-size:16px;font-weight:bold;color:${INK};line-height:1.4">${id.name}</div>`,
    id.title
      ? `<div style="font-size:13px;font-weight:bold;color:${BRAND_RED};letter-spacing:0.3px;padding-bottom:6px">${id.title}</div>`
      : `<div style="height:6px;font-size:1px">&nbsp;</div>`,
    row(`<span style="color:${MUTED}">${id.address}</span>`),
    row(
      `<a href="tel:${id.phone.replace(/[^\d+]/g, "")}" style="color:${MUTED};text-decoration:none">${id.phone}</a>`
    ),
    row(
      `<a href="mailto:${id.email}" style="color:${BRAND_RED};text-decoration:none">${id.email}</a>`
    ),
  ].join("")
}

/**
 * The text/html half.
 *
 * Tables, not flexbox: Outlook draws mail with Word, which supports neither
 * flex nor grid. Every image carries explicit width/height so the layout does
 * not jump when a blocked image is finally loaded, and real alt text so the
 * blocked state still says who this is.
 */
export function buildSignatureHtml(options: SignatureOptions): string {
  const { sender, variant } = options
  if (!hasSignature(variant)) return ""
  const baseUrl = options.baseUrl ?? APP_BASE_URL
  const id = identityFor(sender)
  const withImages = variant !== "text"
  const photoUrl = id.showsPhoto ? signaturePhotoUrl(variant, baseUrl) : null

  const signoff =
    options.includeSignoff !== false
      ? `<tr><td style="font-family:${FONT};font-size:14px;color:${INK};padding-bottom:14px">${SIGNOFF}</td></tr>`
      : ""

  // The identity block: a red rule down the left, details to the right of it.
  const details =
    `<td valign="top" style="border-left:3px solid ${BRAND_RED};padding-left:16px;font-family:${FONT}">` +
    detailRows(id) +
    `</td>`

  // The left cell beside the identity block: Antonio's portrait on his mail,
  // the recognisable TD mark on the company's. The compact variant keeps a
  // SMALL mark - the TD logo is present on every signed email, however small
  // (Antonio, 2026-08-05); only "none" sends bare.
  const markCell = (px: number) =>
    `<td valign="top" style="padding-right:16px">` +
    `<img src="${signatureMarkUrl(baseUrl)}" width="${px}" height="${px}" alt="${COMPANY_NAME}" ` +
    `style="display:block;width:${px}px;height:${px}px" />` +
    `</td>`

  let avatarCell: string
  if (photoUrl) {
    avatarCell =
      `<td valign="top" style="padding-right:16px">` +
      `<img src="${photoUrl}" width="96" height="96" alt="${id.name}" ` +
      `style="display:block;width:96px;height:96px;border-radius:48px;border:2px solid ${RULE}" />` +
      `</td>`
  } else if (withImages) {
    // Company full variant: the lockup (TD mark + "TONY DURANTE", no tagline)
    // beside the block — the only TD logo on the email now that the banner
    // below carries badges alone (Antonio, 2026-08-07).
    avatarCell =
      `<td valign="top" style="padding-right:16px">` +
      `<img src="${signatureLockupUrl(baseUrl)}" width="120" height="84" alt="${COMPANY_NAME}" ` +
      `style="display:block;width:120px;height:84px" />` +
      `</td>`
  } else {
    avatarCell = markCell(40)
  }

  const body = `<table cellpadding="0" cellspacing="0" border="0"><tr>${avatarCell}${details}</tr></table>`

  // The strip under the block rides with the full variants only. Compact
  // ("text") keeps its small mark beside the block but nothing below it - the
  // point of compact is that nothing stacks down a long thread.
  //
  // COMPANY mail carries ONLY the three certification badges, larger and
  // centered — the TD logo lives in the lockup beside the block, so repeating
  // it here is exactly what Luca flagged and Antonio removed (2026-08-07).
  // ANTONIO's mail keeps the original wide banner: his block carries his
  // portrait, so the banner is the only TD logo on it (his 2026-08-05 rule:
  // the TD logo is on every signed email).
  //
  // Fixed px widths, deliberately NOT max-width:100%: inside an auto-layout
  // table a shrinkable image loses the width negotiation to whichever row
  // is narrowest, so the banner rendered 242px on the company block (whose
  // identity row is narrower than Antonio's) while rendering 300px on his.
  // Browser-measured 2026-08-05. Both widths are safe on phone-width clients.
  const logo = !withImages
    ? ""
    : sender === "antonio"
      ? `<tr><td style="padding-top:16px;border-top:1px solid ${RULE}">` +
        `<img src="${signatureLogoUrl(baseUrl)}" width="300" alt="${COMPANY_NAME}" ` +
        `style="display:block;width:300px;height:auto" />` +
        `</td></tr>`
      : `<tr><td align="center" style="padding-top:16px;border-top:1px solid ${RULE}">` +
        `<img src="${signatureBadgesUrl(baseUrl)}" width="260" height="80" alt="IRS Certified Acceptance Agents - Public Notary - Professional Tax Preparer" ` +
        `style="display:block;width:260px;height:80px;margin:0 auto" />` +
        `</td></tr>`

  return (
    `<table cellpadding="0" cellspacing="0" border="0" ` +
    `style="font-family:${FONT};font-size:14px;line-height:1.5;color:${INK};margin-top:24px">` +
    signoff +
    `<tr><td>${body}</td></tr>` +
    logo +
    `</table>`
  )
}

/** Both halves together - what every caller actually wants. */
export function buildSignature(options: SignatureOptions): {
  html: string
  text: string
} {
  return {
    html: buildSignatureHtml(options),
    text: buildSignatureText(options),
  }
}
