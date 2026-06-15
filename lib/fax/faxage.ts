/**
 * Faxage HTTPS API client + pure helpers.
 *
 * Faxage exposes a single endpoint (httpsfax.php) that accepts
 * application/x-www-form-urlencoded fields and returns a plain-text status
 * string. We keep the request-shaping and response-parsing as pure functions so
 * they are unit-testable without hitting the network (R086).
 *
 * Field names follow the documented sendfax operation:
 *   operation=sendfax, username, company, password, faxno,
 *   faxfilenames[0]=<name>, faxfiledata[0]=<base64>, recipname (optional).
 *
 * Credentials NEVER come from the client — only from env, read by the caller.
 */

export const FAXAGE_URL = 'https://www.faxage.com/httpsfax.php'

/** Default IRS e-file fax number; overridable via FAXAGE_IRS_NUMBER. */
export const DEFAULT_IRS_FAX_NUMBER = '8552151627'

export interface FaxageCredentials {
  username: string
  /** Faxage account "company" — usually the same as username. */
  company: string
  password: string
}

export interface SendFaxInput {
  credentials: FaxageCredentials
  /** Recipient fax number — may be raw (formatting is stripped). */
  faxno: string
  fileName: string
  /** Base64 file content. A `data:` URI prefix is tolerated and stripped. */
  fileBase64: string
  recipName?: string
}

export interface FaxageResult {
  ok: boolean
  /** Faxage job id when one can be parsed from the response. */
  jobId: string | null
  /** Raw response text (trimmed) for logging / surfacing. */
  raw: string
}

/** Keep only digits — Faxage wants a bare number (e.g. 18005551234). */
export function normalizeFaxNo(raw: string): string {
  return (raw || '').replace(/[^\d]/g, '')
}

/** US/NANP fax numbers are 10 digits; allow up to 15 for a leading country code. */
export function isValidFaxNo(raw: string): boolean {
  const n = normalizeFaxNo(raw)
  return n.length >= 10 && n.length <= 15
}

/** Strip a `data:<mime>;base64,` prefix if present, leaving raw base64. */
export function stripBase64Prefix(b64: string): string {
  if (!b64) return ''
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',')
    if (comma !== -1) return b64.slice(comma + 1)
  }
  return b64
}

/** Build the application/x-www-form-urlencoded body for a sendfax request. */
export function buildFaxageParams(input: SendFaxInput): URLSearchParams {
  const params = new URLSearchParams()
  params.set('operation', 'sendfax')
  params.set('username', input.credentials.username)
  params.set('company', input.credentials.company || input.credentials.username)
  params.set('password', input.credentials.password)
  params.set('faxno', normalizeFaxNo(input.faxno))
  if (input.recipName && input.recipName.trim()) {
    params.set('recipname', input.recipName.trim())
  }
  params.set('faxfilenames[0]', input.fileName || 'document.pdf')
  params.set('faxfiledata[0]', stripBase64Prefix(input.fileBase64))
  return params
}

/**
 * Parse Faxage's plain-text response. Best-effort: Faxage returns a short status
 * string. We treat an explicit error token (or a non-2xx HTTP status) as failure
 * and otherwise try to pull a job id out of the text.
 */
export function parseFaxageResponse(text: string, httpOk: boolean): FaxageResult {
  const raw = (text || '').trim()
  const lower = raw.toLowerCase()
  const isError =
    !httpOk ||
    lower.startsWith('err') ||
    lower.includes('error') ||
    lower.includes('invalid') ||
    lower.includes('fail') ||
    lower.includes('denied')

  let jobId: string | null = null
  // Prefer a labelled job id ("JobNum: 123", "Job ID 123", "jobid=123").
  const labelled = raw.match(/job\s*(?:num(?:ber)?|id)?\s*[:#=]?\s*(\d+)/i)
  if (labelled) {
    jobId = labelled[1]
  } else if (!isError) {
    // Fall back to a standalone long number only on a non-error response.
    const bare = raw.match(/\b(\d{4,})\b/)
    if (bare) jobId = bare[1]
  }

  return { ok: !isError, jobId, raw }
}

/**
 * Send a fax via Faxage. The fetch implementation is injectable for tests; the
 * default uses the global fetch. Network/parse errors throw.
 */
export async function sendFax(
  input: SendFaxInput,
  fetchImpl: typeof fetch = fetch,
): Promise<FaxageResult> {
  const params = buildFaxageParams(input)
  const res = await fetchImpl(FAXAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const text = await res.text()
  return parseFaxageResponse(text, res.ok)
}
