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

/**
 * IRS EIN (SS-4) fax number for DOMESTIC filings — (855) 641-6935. Pre-fills the
 * Company Formation SS-4 fax panel (Antonio, 2026-07-09). Distinct from
 * DEFAULT_IRS_FAX_NUMBER (855-215-1627, the international EIN number). Staff
 * confirm/edit the number before sending, so this is a starting value only.
 */
export const IRS_EIN_FAX_DOMESTIC = '8556416935'

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

/* ------------------------------------------------------------------ *
 * Status operation — poll delivery status of previously-sent faxes.
 *
 * Faxage returns one tab-separated record per job, newline-separated.
 * We always POST a FIXED set of optional flags so the appended columns
 * land in known positions (the doc appends optional fields in the order
 * pagecount, csid, login, xmitpages, number-of-tries — but only those
 * whose flag was posted). By posting all five, parsing is deterministic.
 * ------------------------------------------------------------------ */

/** Normalized, human-facing delivery status derived from Faxage `shortstatus`. */
export type FaxDeliveryStatus = 'delivered' | 'pending' | 'failed' | 'unknown'

export interface FaxStatusRecord {
  jobId: string
  commId: string
  destName: string
  destNum: string
  /** Raw Faxage shortstatus: 'pending' | 'success' | 'failure'. */
  shortStatus: string
  /** Normalized status for display. */
  status: FaxDeliveryStatus
  /** Human-readable longstatus (do NOT parse programmatically). */
  longStatus: string
  /** Submitted time, "YYYY-MM-DD HH:MM:SS". */
  sendTime: string
  /** Completed time, "YYYY-MM-DD HH:MM:SS" (all zeros while pending). */
  completeTime: string
  /** Transmit time, "HH:MM:SS". */
  xmitTime: string
  /** Pages in the job (from pagecount flag). */
  pageCount: string
  /** Remote station identifier (from csid flag). */
  csid: string
  /** Login that sent the fax (from showlogin flag). */
  login: string
  /** Pages actually transmitted (from xmitpages flag). */
  xmitPages: string
  /** Number of send tries (from showtries flag). */
  tries: string
}

export interface FaxStatusResult {
  ok: boolean
  /** Error token/message when Faxage rejected the request. */
  error: string | null
  records: FaxStatusRecord[]
  /** Raw response text (trimmed) for logging. */
  raw: string
}

/** Map Faxage `shortstatus` to a normalized, display-friendly status. */
export function normalizeStatus(shortStatus: string): FaxDeliveryStatus {
  const s = (shortStatus || '').trim().toLowerCase()
  if (s === 'success') return 'delivered'
  if (s === 'pending') return 'pending'
  if (s === 'failure') return 'failed'
  return 'unknown'
}

/** Build the form body for a `status` request (optionally scoped to one job). */
export function buildStatusParams(
  credentials: FaxageCredentials,
  opts: { jobId?: string } = {},
): URLSearchParams {
  const params = new URLSearchParams()
  params.set('operation', 'status')
  params.set('username', credentials.username)
  params.set('company', credentials.company || credentials.username)
  params.set('password', credentials.password)
  if (opts.jobId && opts.jobId.trim()) params.set('jobid', opts.jobId.trim())
  // Fixed optional flags → deterministic appended-column order.
  params.set('pagecount', '1')
  params.set('csid', '1')
  params.set('showlogin', '1')
  params.set('xmitpages', '1')
  params.set('showtries', '1')
  return params
}

/**
 * Parse a Faxage `status` response into structured records. Best-effort and
 * defensive: an `ERRxx` token (or non-2xx HTTP) is treated as an error and no
 * records are returned. ERR06 ("no jobs") is surfaced as an empty, non-error
 * result so callers can distinguish "nothing yet" from a real failure.
 */
export function parseStatusResponse(text: string, httpOk: boolean): FaxStatusResult {
  const raw = (text || '').trim()
  const lower = raw.toLowerCase()

  // ERR06 = no jobs / job not found → empty, not an error.
  if (lower.startsWith('err06')) {
    return { ok: true, error: null, records: [], raw }
  }
  if (!httpOk || lower.startsWith('err')) {
    return { ok: false, error: raw || 'Faxage request failed', records: [], raw }
  }

  const records: FaxStatusRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const f = trimmed.split('\t')
    const at = (i: number) => (f[i] ?? '').trim()
    const shortStatus = at(4)
    records.push({
      jobId: at(0),
      commId: at(1),
      destName: at(2),
      destNum: at(3),
      shortStatus,
      status: normalizeStatus(shortStatus),
      longStatus: at(5),
      sendTime: at(6),
      completeTime: at(7),
      xmitTime: at(8),
      pageCount: at(9),
      csid: at(10),
      login: at(11),
      xmitPages: at(12),
      tries: at(13),
    })
  }
  return { ok: true, error: null, records, raw }
}

/** Fetch delivery status for one job (or all jobs if `jobId` omitted). */
export async function getFaxStatus(
  credentials: FaxageCredentials,
  opts: { jobId?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FaxStatusResult> {
  const params = buildStatusParams(credentials, opts)
  const res = await fetchImpl(FAXAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const text = await res.text()
  return parseStatusResponse(text, res.ok)
}

/* ------------------------------------------------------------------ *
 * Dltrans operation — download the transmittal page (the PDF "receipt"
 * a fax machine would print) for a completed sent fax.
 * ------------------------------------------------------------------ */

export interface FaxTransmittalResult {
  ok: boolean
  /** PDF bytes on success. */
  pdf: Buffer | null
  /** Error token/message on failure. */
  error: string | null
}

/**
 * Faxage timezone codes for `jobtz` (dltrans transmittal page). Default to
 * Eastern (4) so the receipt date/time matches the firm's timezone.
 */
export const FAXAGE_TZ_EASTERN = '4'

/** Build the form body for a `dltrans` request. */
export function buildDltransParams(
  credentials: FaxageCredentials,
  jobId: string,
  opts: { tz?: string } = {},
): URLSearchParams {
  const params = new URLSearchParams()
  params.set('operation', 'dltrans')
  params.set('username', credentials.username)
  params.set('company', credentials.company || credentials.username)
  params.set('password', credentials.password)
  params.set('jobid', jobId)
  params.set('jobtz', opts.tz || FAXAGE_TZ_EASTERN)
  return params
}

/**
 * Detect whether a dltrans response body is a PDF or an `ERRxx` text error.
 * The success case is a binary PDF (starts with the `%PDF` magic bytes); any
 * `ERRxx` string means failure.
 */
export function interpretTransmittalBytes(bytes: Uint8Array): FaxTransmittalResult {
  const head = Buffer.from(bytes.slice(0, 8)).toString('latin1')
  if (head.startsWith('%PDF')) {
    return { ok: true, pdf: Buffer.from(bytes), error: null }
  }
  // Not a PDF → treat the (short) body as an error message.
  const msg = Buffer.from(bytes).toString('utf8').trim().slice(0, 300)
  return { ok: false, pdf: null, error: msg || 'No transmittal page available' }
}

/** Download the transmittal-page PDF for a completed sent fax. */
export async function getFaxTransmittal(
  credentials: FaxageCredentials,
  jobId: string,
  opts: { tz?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<FaxTransmittalResult> {
  const params = buildDltransParams(credentials, jobId, opts)
  const res = await fetchImpl(FAXAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    return { ok: false, pdf: null, error: txt.trim().slice(0, 300) || `HTTP ${res.status}` }
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  return interpretTransmittalBytes(buf)
}
