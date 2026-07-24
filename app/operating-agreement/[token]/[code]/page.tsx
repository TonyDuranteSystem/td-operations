'use client'

import { Suspense, useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic } from '@/lib/supabase/public-client'
import { generateOASections, type OAData, type OAMember } from '@/lib/types/oa-templates'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { resolveSignedPdfPath } from '@/lib/oa/signed-pdf-path'


// --- Types -----------------------------------------------
interface OAAgreement {
  // NOTE: no `access_code`, no `member_email`, no `account_id` / `contact_id`.
  // The server strips them — adding one back here means someone re-opened the
  // leak this change closed. See lib/oa/public-view.ts.
  id: string
  token: string
  company_name: string
  state_of_formation: string
  formation_date: string
  ein_number: string | null
  entity_type: string | null
  manager_name: string | null
  member_name: string
  member_address: string | null
  member_ownership_pct: number
  members: OAMember[] | null
  effective_date: string
  business_purpose: string
  initial_contribution: string
  fiscal_year_end: string
  accounting_method: string
  duration: string
  registered_agent_name: string | null
  registered_agent_address: string | null
  principal_address: string
  status: string
  language: string
  view_count: number
  viewed_at: string | null
  signed_at: string | null
  signature_data: Record<string, unknown> | null
  pdf_storage_path: string | null
  total_signers: number
  signed_count: number
}

interface OASignature {
  id: string
  oa_id: string
  member_index: number
  member_name: string
  // No `access_code` — a co-signer's code is the credential that authorises
  // signing AS that member, and it used to be handed to every visitor.
  status: string
  signed_at: string | null
  signature_image_path: string | null
  signed_by_name: string | null
  view_count: number
}

// --- Helpers ---------------------------------------------
function today() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// Parse YYYY-MM-DD without timezone shift and format as "April 28, 2026"
function formatEffectiveDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// --- Main Page -------------------------------------------
export default function OperatingAgreementCodePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" /></div>}>
      <OperatingAgreementCodeContent />
    </Suspense>
  )
}

function OperatingAgreementCodeContent() {
  const { token, code } = useParams<{ token: string; code: string }>()
  const searchParams = useSearchParams()
  const accessCode = code || ''

  const [isAdmin, setIsAdmin] = useState(false)
  const [isPortal, setIsPortal] = useState(false)
  const [oa, setOa] = useState<OAAgreement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Multi-signer state
  const [signatures, setSignatures] = useState<OASignature[]>([])
  const [currentSignerIndex, setCurrentSignerIndex] = useState<number | null>(null) // null = SMLLC or no signer param

  // Email gate
  const [verified, setVerified] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState('')
  const [checkingEmail, setCheckingEmail] = useState(false)

  // Signing
  const [signing, setSigning] = useState(false)
  const [signed, setSigned] = useState(false)
  const [allSigned, setAllSigned] = useState(false)

  // How the signer makes their mark. All three modes produce one PNG data URL the
  // server places on the agreement — draw with a mouse/finger, type a name (printed
  // in a signature script), or upload a photo of a real wet signature. Upload is
  // the closest match to a handwritten signature; type is the convenient default.
  const [signMode, setSignMode] = useState<'draw' | 'type' | 'upload'>('draw')
  const [typedName, setTypedName] = useState('')
  const [uploadedSig, setUploadedSig] = useState<string | null>(null)
  // ESIGN/UETA consent — the server refuses to sign without it.
  const [consent, setConsent] = useState(false)

  // "I signed by hand" — the client printed the draft, signed on paper, and is
  // telling us so. `handMode` reveals the confirm panel; the file is optional.
  const [handMode, setHandMode] = useState(false)
  const [handFile, setHandFile] = useState<File | null>(null)
  const [handSubmitting, setHandSubmitting] = useState(false)
  const [handError, setHandError] = useState('')
  const [handDone, setHandDone] = useState<'with-scan' | 'no-scan' | null>(null)
  const sigCanvasRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const oaBodyRef = useRef<HTMLDivElement>(null)
  const pdfBlobRef = useRef<Blob | null>(null)

  // Signature images fetched from storage (for already-signed members)
  const [sigImages, setSigImages] = useState<Record<number, string>>({})

  // Derived — normalize: legacy rows can store "Multi Member LLC" (long form)
  const entityType = normalizeEntityType(oa?.entity_type) || 'SMLLC'
  const isMMLLC = entityType === 'MMLLC'
  const members: OAMember[] = (isMMLLC && oa?.members) ? oa.members : []
  const managerName = oa?.manager_name || oa?.member_name || ''
  const totalSigners = oa?.total_signers || 1
  const isMultiSigner = isMMLLC && totalSigners > 1

  // Current signer's signature record
  const currentSig = isMultiSigner && currentSignerIndex !== null
    ? signatures.find(s => s.member_index === currentSignerIndex)
    : null
  const currentSignerAlreadySigned = currentSig?.status === 'signed'

  // --- LOAD OA ---
  // Everything comes from the server route, which verifies the access code
  // BEFORE returning anything, resolves the current signer from their per-member
  // code WITHOUT sending anyone's code to the browser, evaluates the email gate
  // server-side, and records the view.
  //
  // What this replaces: a browser-side select('*') on both tables with the anon
  // key, and a client-side `data.access_code !== accessCode` comparison that ran
  // after the row had already been delivered. That handed every caller the
  // agreement's access code, the tax ID, member addresses — and, from the
  // signatures table, EVERY co-signer's personal signing code, which is the
  // credential that authorises signing as that member. See lib/oa/public-view.ts.
  // Returns the outcome so the email gate can report a mismatch without issuing
  // a second request (see handleEmailVerify).
  const loadOA = useCallback(async (emailOverride?: string): Promise<'ok' | 'requires-email' | 'error'> => {
    if (!token) return 'error'

    const adminMode = searchParams.get('preview') === 'td'
    const portalMode = searchParams.get('portal') === 'true'
    const signerCode = searchParams.get('signer')

    if (adminMode) setIsAdmin(true)
    if (portalMode) setIsPortal(true)

    const cookieKey = signerCode ? `oa_email_${token}_s` : `oa_email_${token}`
    const cookieEmail = document.cookie
      .split(';')
      .find(c => c.trim().startsWith(`${cookieKey}=`))
      ?.split('=')[1]
    const email = emailOverride ?? (cookieEmail ? decodeURIComponent(cookieEmail) : '')

    const qs = new URLSearchParams({ code: accessCode })
    if (signerCode) qs.set('signer', signerCode)
    if (adminMode) qs.set('preview', 'td')
    if (portalMode) qs.set('portal', 'true')

    let res: Response
    try {
      // The address goes in a header, never the query string — a query param
      // would land the client's email in every access log.
      res = await fetch(`/api/operating-agreement/${token}/fetch?${qs.toString()}`,
        email ? { headers: { 'x-oa-email': email } } : undefined)
    } catch {
      setError('Could not load the Operating Agreement. Please check your connection and try again.')
      setLoading(false)
      return 'error'
    }

    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(body?.error || 'Operating Agreement not found.')
      setLoading(false)
      return 'error'
    }

    if (body.requiresEmail) {
      setVerified(false)
      setLoading(false)
      return 'requires-email'
    }

    const data = body.agreement as OAAgreement
    setOa(data)
    setAllSigned(!!(data.status === 'signed' && data.signed_at))
    setVerified(true)

    const isMulti = (normalizeEntityType(data.entity_type) === 'MMLLC') && (data.total_signers || 1) > 1
    if (isMulti) {
      const sigs = (body.signatures ?? []) as OASignature[]
      setSignatures(sigs)

      if (body.currentSignerIndex !== null && body.currentSignerIndex !== undefined) {
        setCurrentSignerIndex(body.currentSignerIndex)
        setSigned(sigs.find(s => s.member_index === body.currentSignerIndex)?.status === 'signed')
      }

      // Fetch signature images for already-signed members
      const signedSigs = sigs.filter(s => s.status === 'signed' && s.signature_image_path)
      const images: Record<number, string> = {}
      for (const s of signedSigs) {
        try {
          const { data: blob } = await supabasePublic.storage
            .from('signed-oa')
            .download(s.signature_image_path!)
          if (blob) {
            images[s.member_index] = URL.createObjectURL(blob)
          }
        } catch {
          // Skip failed image loads
        }
      }
      setSigImages(images)
    } else {
      // SMLLC
      setSigned(!!data.signed_at)
    }

    setLoading(false)
    return 'ok'
  }, [token, accessCode, searchParams])

  useEffect(() => { loadOA() }, [loadOA])

  // Init signature pad. Only in Draw mode — the canvas is display:none in the other
  // modes, so re-running when signMode returns to 'draw' re-measures and re-binds it.
  useEffect(() => {
    if (!verified || !oa || signed || currentSignerAlreadySigned) return
    if (signMode !== 'draw') return
    // For MMLLC without signer param, don't show signature pad
    if (isMultiSigner && currentSignerIndex === null) return

    const initSig = async () => {
      const SignaturePad = (await import('signature_pad')).default
      const canvas = sigCanvasRef.current
      if (!canvas || canvas.offsetWidth === 0) return
      canvas.width = canvas.offsetWidth * 2
      canvas.height = canvas.offsetHeight * 2
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.scale(2, 2)
      sigPadRef.current = new SignaturePad(canvas, { backgroundColor: 'rgb(255,255,255)' })
    }
    setTimeout(initSig, 300)
  }, [verified, oa, signed, currentSignerAlreadySigned, isMultiSigner, currentSignerIndex, signMode])

  // --- EMAIL GATE ---
  // Compared on the server. The address is no longer sent to the browser, so
  // there is nothing here to compare against — and nothing to read out of the
  // page source. A successful check is what returns the document.
  async function handleEmailVerify(e: React.FormEvent) {
    e.preventDefault()
    const candidate = emailInput.trim()
    if (!candidate) return

    setCheckingEmail(true)
    setEmailError('')
    try {
      // ONE fetch, not two. Verifying used to call the route and then call
      // loadOA, which called it again — so a single gate pass counted two views
      // on the agreement and on the member's signature row.
      const signerCode = searchParams.get('signer')
      const outcome = await loadOA(candidate)
      if (outcome === 'requires-email') {
        setEmailError('The email address does not match. Please try again.')
        return
      }
      if (outcome === 'error') return
      const cookieKey = signerCode ? `oa_email_${token}_s` : `oa_email_${token}`
      document.cookie = `${cookieKey}=${encodeURIComponent(candidate)}; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
    } catch {
      setEmailError('Could not verify that address. Please check your connection and try again.')
    } finally {
      setCheckingEmail(false)
    }
  }

  // --- SIGN ---
  async function handleHandSigned() {
    if (!oa) return
    setHandError('')
    setHandSubmitting(true)
    try {
      const fd = new FormData()
      fd.set('code', accessCode)
      const signerCode = searchParams.get('signer')
      if (signerCode) fd.set('signer', signerCode)
      if (handFile) fd.set('file', handFile)

      const res = await fetch(`/api/operating-agreement/${token}/hand-signed`, { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Surface the server's real reason (file too big, wrong type, voided),
        // not a generic failure — the client needs to know what to fix.
        throw new Error(data?.error || 'Could not record your confirmation. Please try again.')
      }
      setHandDone(handFile ? 'with-scan' : 'no-scan')
      setHandMode(false)
      // Deliberately do NOT set `signed`/`allSigned` here. Those drive the
      // electronic-signature confirmation panel, which announces "All Members
      // Have Signed" and offers a Download button — and a paper-signed agreement
      // never gets a system-generated PDF, so that button always failed with
      // "PDF not available yet. It will be ready once all members sign." The
      // hand-signed panel below says the right thing instead.
      // Tell the portal shell so its banner/checklist refresh instead of still
      // reading "Awaiting Your Signature" behind the iframe.
      if (isPortal && window.parent !== window) {
        // A paper declaration completes the whole agreement (the client's own
        // document, their responsibility — Antonio 2026-07-24), so this one is
        // genuinely complete.
        window.parent.postMessage(
          { type: 'oa-signed', token, member_index: currentSignerIndex ?? undefined, allSigned: true },
          'https://portal.tonydurante.us',
        )
      }
    } catch (err) {
      setHandError(err instanceof Error && err.message ? err.message : 'Could not record your confirmation. Please try again.')
    } finally {
      setHandSubmitting(false)
    }
  }

  /** Render a typed name in a signature script onto a canvas and return a PNG. */
  function renderTypedSignature(name: string): string | null {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 200
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#0a1a3a'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Shrink to fit long names within the canvas width.
    let size = 72
    ctx.font = `italic ${size}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`
    while (size > 28 && ctx.measureText(name).width > canvas.width - 40) {
      size -= 4
      ctx.font = `italic ${size}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`
    }
    ctx.fillText(name, canvas.width / 2, canvas.height / 2)
    return canvas.toDataURL('image/png')
  }

  /** Read an uploaded image file, draw it onto a canvas, and return a PNG data URL.
   *  This normalises any format (JPEG/HEIC/PNG) to the PNG the server expects, and
   *  keeps a transparent background so a scan drops onto the line cleanly. */
  async function handleUploadSignature(file: File): Promise<void> {
    // Drop any earlier upload first — otherwise a failed decode below leaves the
    // previous image in place and the signer submits the wrong one.
    setUploadedSig(null)
    if (file.size > 8 * 1024 * 1024) {
      alert('That image is too large. Please use a photo under 8 MB.')
      return
    }
    try {
      const bitmap = await createImageBitmap(file)
      const maxW = 600
      const scale = Math.min(1, maxW / bitmap.width)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale)
      canvas.height = Math.round(bitmap.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      setUploadedSig(canvas.toDataURL('image/png'))
    } catch {
      alert('That image could not be read. Please try a JPG or PNG photo of your signature.')
    }
  }

  /** The signature PNG for the active mode, or null if nothing has been provided. */
  function getSignaturePng(): string | null {
    if (signMode === 'draw') {
      if (!sigPadRef.current || sigPadRef.current.isEmpty()) return null
      return sigPadRef.current.toDataURL('image/png')
    }
    if (signMode === 'type') {
      const name = typedName.trim()
      return name ? renderTypedSignature(name) : null
    }
    return uploadedSig
  }

  // Signing is now entirely server-side: the browser sends the signature image and
  // the server verifies the code, records IP/device/consent, writes with the service
  // key, and (on the last signer) renders the executed agreement + legal certificate
  // and files it. The old browser-side html2pdf screenshot + anon-key writes are gone.
  async function handleSign() {
    if (!oa) return
    if (!consent) {
      alert('Please confirm you agree to sign electronically before signing.')
      return
    }
    const sigPng = getSignaturePng()
    if (!sigPng) {
      alert('Please provide your signature above before submitting.')
      return
    }

    setSigning(true)
    try {
      const signerCode = searchParams.get('signer')
      const res = await fetch(`/api/operating-agreement/${token}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: accessCode,
          signer: signerCode,
          consent: true,
          signature_png: sigPng,
          signature_method: signMode === 'draw' ? 'drawn' : signMode === 'type' ? 'typed' : 'uploaded',
          signed_by_name: signMode === 'type' ? typedName.trim() : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      // 202 = recorded, still finalizing (last-signer render is being retried) — not
      // an error to the signer, their signature is in.
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || 'Something went wrong while signing. Please try again.')
      }

      setSigned(true)
      if (data.allSigned) setAllSigned(true)

      // Refresh the agreement so the confirmation panel's "Download Signed PDF"
      // has the freshly-filed path. Without this, `oa` still holds the pre-sign
      // snapshot (pdf_storage_path = null) and the download wrongly reports the
      // PDF "not available yet." Only matters once the doc is fully signed+filed.
      if (data.allSigned) {
        await loadOA().catch(() => {})
      }

      if (isPortal && window.parent !== window) {
        // allSigned tells the portal shell whether the agreement is COMPLETE. A
        // multi-owner agreement with one owner signed is not — without this the
        // portal announced "signed and saved" to a partial signer.
        window.parent.postMessage(
          { type: 'oa-signed', token, member_index: currentSignerIndex ?? undefined, allSigned: !!data.allSigned },
          'https://portal.tonydurante.us',
        )
      }
    } catch (err) {
      console.error('Signing failed:', err)
      alert(err instanceof Error && err.message ? err.message : 'An error occurred while signing. Please try again.')
    } finally {
      setSigning(false)
    }
  }

  // The signature capture control — Draw / Type / Upload. Rendered inside whichever
  // signature block is active (MMLLC current signer or SMLLC). The draw canvas stays
  // mounted (toggled with display) so the signature pad keeps its binding.
  const signatureCapture = (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {(['draw', 'type', 'upload'] as const).map(mode => (
          <button
            key={mode}
            type="button"
            onClick={() => setSignMode(mode)}
            style={{
              padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
              border: signMode === mode ? '2px solid #0A3161' : '1px solid #ccc',
              background: signMode === mode ? '#eef2fb' : '#fff',
              color: '#0A3161', fontWeight: signMode === mode ? 600 : 400,
            }}
          >
            {mode === 'draw' ? 'Draw' : mode === 'type' ? 'Type' : 'Upload'}
          </button>
        ))}
      </div>

      {/* Draw — canvas stays mounted so the pad binding survives mode switches. */}
      <div style={{ display: signMode === 'draw' ? 'block' : 'none' }}>
        <canvas
          ref={sigCanvasRef}
          style={{ width: '100%', maxWidth: 400, height: 100, border: '1px solid #0A3161', borderRadius: 4, background: '#fff', cursor: 'crosshair' }}
        />
        <button
          type="button"
          onClick={() => sigPadRef.current?.clear()}
          style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
        >
          Clear signature
        </button>
      </div>

      {/* Type — printed in a signature script, with a live preview. */}
      {signMode === 'type' && (
        <div>
          <input
            value={typedName}
            onChange={e => setTypedName(e.target.value)}
            placeholder="Type your full name"
            style={{ width: '100%', maxWidth: 400, padding: '10px 12px', fontSize: 14, border: '1px solid #0A3161', borderRadius: 4, boxSizing: 'border-box' }}
          />
          {typedName.trim() && (
            <div style={{ marginTop: 8, height: 70, display: 'flex', alignItems: 'center', maxWidth: 400, border: '1px dashed #ccc', borderRadius: 4, background: '#fff' }}>
              <span style={{ fontFamily: '"Segoe Script","Brush Script MT","Snell Roundhand",cursive', fontStyle: 'italic', fontSize: 36, color: '#0a1a3a', paddingLeft: 16 }}>
                {typedName.trim()}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Upload — a photo of a real signature, normalised to PNG on selection. */}
      {signMode === 'upload' && (
        <div>
          <input
            type="file"
            accept="image/*"
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleUploadSignature(f) }}
            style={{ fontSize: 13 }}
          />
          {uploadedSig && (
            // eslint-disable-next-line @next/next/no-img-element -- local data URL, not optimizable
            <img src={uploadedSig} alt="Your signature" style={{ display: 'block', marginTop: 8, maxWidth: 400, maxHeight: 100, objectFit: 'contain', border: '1px solid #eee', borderRadius: 4 }} />
          )}
        </div>
      )}
    </div>
  )

  // --- RENDER ---

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'Georgia, serif' }}>
        <p style={{ color: '#666', fontSize: 18 }}>Loading Operating Agreement...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'Georgia, serif' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ color: '#333', marginBottom: 8 }}>Operating Agreement</h2>
          <p style={{ color: '#999' }}>{error}</p>
        </div>
      </div>
    )
  }

  // Email gate — BEFORE the `!oa` bail-out. An unverified caller now holds no
  // agreement data at all (the server withholds it until the address matches),
  // so bailing out first would show them a blank page instead of the gate.
  if (!verified) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'Georgia, serif', background: '#f8f8f8' }}>
        <div style={{ background: '#fff', padding: 40, borderRadius: 8, boxShadow: '0 2px 20px rgba(0,0,0,0.08)', maxWidth: 420, width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <h2 style={{ fontSize: 20, color: '#222', margin: 0 }}>Verify Your Identity</h2>
            <p style={{ fontSize: 14, color: '#666', marginTop: 8 }}>Enter the email address associated with this agreement to view it.</p>
          </div>
          <form onSubmit={handleEmailVerify}>
            <input
              type="email"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              placeholder="your@email.com"
              required
              style={{ width: '100%', padding: '12px 16px', fontSize: 16, border: '1px solid #ddd', borderRadius: 6, marginBottom: 12, boxSizing: 'border-box' }}
            />
            {emailError && <p style={{ color: '#c00', fontSize: 13, margin: '0 0 12px' }}>{emailError}</p>}
            <button type="submit" disabled={checkingEmail} style={{ width: '100%', padding: '12px', fontSize: 16, background: checkingEmail ? '#999' : '#0A3161', color: '#fff', border: 'none', borderRadius: 6, cursor: checkingEmail ? 'default' : 'pointer', fontWeight: 600 }}>
              {checkingEmail ? 'Verifying…' : 'View Operating Agreement'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (!oa) return null

  // Can this user sign? (MMLLC: only if they have a signer param and haven't signed yet)
  //
  // `!isAdmin` is load-bearing: admin preview must be able to READ the agreement
  // and never to EXECUTE it. Until this change a preview link could affix a real
  // signature attributed to a member — a signature TD applied, on a document TD
  // drafted, indistinguishable in the record from the member's own. Deriving the
  // restriction from the query flag is safe because it only ever REMOVES the
  // ability to sign; faking the flag costs you the button.
  const canSign = !isAdmin && (isMultiSigner
    ? (currentSignerIndex !== null && !currentSignerAlreadySigned && !signed)
    : (!signed && !allSigned))

  // Generate OA sections from template
  const oaData: OAData = {
    company_name: oa.company_name,
    state_of_formation: oa.state_of_formation,
    formation_date: oa.formation_date,
    ein_number: oa.ein_number || undefined,
    entity_type: isMMLLC ? 'MMLLC' : 'SMLLC',
    member_name: oa.member_name,
    member_address: oa.member_address || undefined,
    members: isMMLLC ? members : undefined,
    manager_name: managerName,
    effective_date: oa.effective_date,
    business_purpose: oa.business_purpose,
    initial_contribution: oa.initial_contribution,
    fiscal_year_end: oa.fiscal_year_end,
    accounting_method: oa.accounting_method,
    duration: oa.duration,
    registered_agent_name: oa.registered_agent_name || undefined,
    registered_agent_address: oa.registered_agent_address || undefined,
    principal_address: oa.principal_address,
  }
  const sections = generateOASections(oaData)

  const entityLabel = isMMLLC ? 'Multi-Member' : 'Single Member'
  const preambleSigners = isMMLLC
    ? `the Members listed herein`
    : `${oa.member_name} (the "Member")`

  return (
    <div style={{ background: isPortal ? '#fff' : '#f5f5f0', minHeight: '100vh', padding: isPortal ? '8px 0' : '24px 16px', fontFamily: 'Georgia, "Times New Roman", serif' }}>

      {/* Multi-signer progress banner */}
      {isMultiSigner && verified && !allSigned && (
        <div style={{ maxWidth: 800, margin: '0 auto 16px', background: '#f0f4ff', border: '1px solid #c7d4f0', borderRadius: 8, padding: '12px 20px', textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 14, color: '#1a3b6d' }}>
            <strong>Signatures: {signatures.filter(s => s.status === 'signed').length} of {totalSigners}</strong>
            {' — '}All members must sign for the agreement to be effective.
          </p>
        </div>
      )}

      <div
        ref={oaBodyRef}
        style={{ maxWidth: 800, margin: '0 auto', background: '#fff', padding: isPortal ? '32px 40px' : '48px 56px', boxShadow: isPortal ? 'none' : '0 1px 12px rgba(0,0,0,0.08)', lineHeight: 1.7, fontSize: 14, color: '#222' }}
      >
        {/* Admin Preview Badge */}
        {isAdmin && (
          <div style={{ textAlign: 'center', marginBottom: -8 }}>
            <span style={{ display: 'inline-block', background: '#f59e0b', color: '#fff', padding: '3px 12px', borderRadius: 12, fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>
              ADMIN PREVIEW
            </span>
          </div>
        )}

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: 1 }}>OPERATING AGREEMENT</h1>
          <p style={{ fontSize: 15, color: '#555', marginTop: 4 }}>{oa.company_name}</p>
          <p style={{ fontSize: 13, color: '#888', marginTop: 2 }}>
            A {oa.state_of_formation} {entityLabel} Limited Liability Company
          </p>
          <p style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>
            Manager-Managed
          </p>
          <div style={{ width: 60, height: 2, background: '#0A3161', margin: '12px auto' }} />
        </div>

        {/* Preamble */}
        <p style={{ fontStyle: 'italic' }}>
          This Operating Agreement (&ldquo;Agreement&rdquo;) of {oa.company_name} (the &ldquo;Company&rdquo;) is entered into
          and effective as of {formatEffectiveDate(oa.effective_date)}, by {preambleSigners}.
        </p>

        <hr style={{ border: 'none', borderTop: '1px solid #ddd', margin: '24px 0' }} />

        {/* Dynamic Sections from Template */}
        {sections.map((section, idx) => (
          <div key={idx} style={{ marginBottom: 24 }}>
            <h2 style={h2Style}>{section.title}</h2>
            <div style={{ whiteSpace: 'pre-wrap' }}>{section.content}</div>
          </div>
        ))}

        <hr style={{ border: 'none', borderTop: '2px solid #0A3161', margin: '32px 0' }} />

        {/* Signature Section */}
        <p style={{ fontWeight: 700, fontSize: 15, marginBottom: 24 }}>
          IN WITNESS WHEREOF, the {isMMLLC ? 'Members have' : 'Member has'} executed this Operating Agreement as of the date first written above.
        </p>

        {/* Manager Signature Block */}
        <div style={{ maxWidth: 400, marginBottom: 32 }}>
          <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, textTransform: 'uppercase', color: '#555' }}>MANAGER</p>
          <p style={{ fontWeight: 700, marginBottom: 12 }}>{oa.company_name}</p>
          <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Print Name: <strong style={{ color: '#222' }}>{managerName}</strong></p>
          <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Title: Manager</p>
          <p style={{ fontSize: 13, color: '#666' }}>Date: {today()}</p>
        </div>

        {/* MMLLC: Per-Member Signature Blocks */}
        {isMMLLC && members.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 12, textTransform: 'uppercase', color: '#555' }}>MEMBERS</p>
            {members.map((m, idx) => {
              const sig = signatures.find(s => s.member_index === idx)
              const isCurrent = currentSignerIndex === idx
              const isSigned = sig?.status === 'signed'
              const hasImage = sigImages[idx]

              return (
                <div key={idx} style={{ marginBottom: 24, paddingLeft: 16, borderLeft: `3px solid ${isSigned ? '#22c55e' : isCurrent ? '#0A3161' : '#eee'}` }}>
                  <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Print Name: <strong style={{ color: '#222' }}>{m.name}</strong></p>
                  <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Ownership: {m.ownership_pct}%</p>
                  <p style={{ fontSize: 13, color: '#666' }}>Date: {today()}</p>

                  {/* Already signed — show signature image */}
                  {isSigned && hasImage && (
                    <div style={{ marginTop: 8 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- signature blob URL, not optimizable */}
                      <img src={hasImage} alt={`Signature of ${m.name}`} style={{ maxWidth: '100%', height: 60, objectFit: 'contain' }} />
                      <p style={{ fontSize: 11, color: '#22c55e', marginTop: 4 }}>Signed{sig?.signed_at ? ` on ${new Date(sig.signed_at).toLocaleDateString()}` : ''}</p>
                    </div>
                  )}

                  {/* Already signed but no image loaded */}
                  {isSigned && !hasImage && (
                    <p style={{ fontSize: 12, color: '#22c55e', marginTop: 8, fontStyle: 'italic' }}>Signed{sig?.signed_at ? ` on ${new Date(sig.signed_at).toLocaleDateString()}` : ''}</p>
                  )}

                  {/* Current signer — active signature capture (draw/type/upload) */}
                  {isCurrent && !isSigned && !signed && (
                    <div style={{ marginTop: 12 }}>
                      <p style={{ fontSize: 12, color: '#0A3161', fontWeight: 600, marginBottom: 6 }}>Your Signature:</p>
                      {signatureCapture}
                    </div>
                  )}

                  {/* Current signer just signed */}
                  {isCurrent && signed && (
                    <p style={{ fontSize: 12, color: '#22c55e', marginTop: 8, fontStyle: 'italic' }}>Signed just now</p>
                  )}

                  {/* Other unsigned member — awaiting */}
                  {!isCurrent && !isSigned && (
                    <p style={{ fontSize: 12, color: '#999', marginTop: 8, fontStyle: 'italic' }}>Awaiting signature</p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* SMLLC: Single signature block */}
        {!isMMLLC && (
          <>
            {!signed && (
              <div style={{ marginTop: 16 }}>
                <p style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Member / Manager Signature:</p>
                {signatureCapture}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 13, color: '#555', fontStyle: 'italic' }}>Sole Member / Manager</p>
            </div>
          </>
        )}

        {/* Signed confirmation */}
        {(allSigned || (!isMultiSigner && signed)) && (
          <div style={{ background: '#f0f7f0', border: '1px solid #b8d4b8', borderRadius: 6, padding: 20, textAlign: 'center', marginTop: 24 }}>
            <p style={{ color: '#2d6a2d', fontWeight: 700, fontSize: 16, margin: 0 }}>
              {allSigned ? 'Operating Agreement — All Members Have Signed' : 'Operating Agreement Signed Successfully'}
            </p>
            <p style={{ color: '#4a8a4a', fontSize: 14, marginTop: 8 }}>
              A copy has been saved. Tony Durante LLC will be in touch shortly.
            </p>
            <button
              onClick={async () => {
                try {
                  let blob = pdfBlobRef.current
                  if (!blob && (oa.signed_at || allSigned)) {
                    // Download the document the SERVER recorded — never "the
                    // newest .pdf in the folder", which is what this used to do.
                    // Anyone can upload into that folder (its only storage policy
                    // is INSERT for role `public`), so listing-and-sorting served
                    // the CLIENT whatever an attacker dropped in. Same flaw the
                    // publish step had, pointed at the client instead of Drive.
                    // See lib/oa/signed-pdf-path.ts.
                    const target = resolveSignedPdfPath(token, oa.pdf_storage_path)
                    if (target.ok && target.path) {
                      const { data: downloaded } = await supabasePublic.storage.from('signed-oa').download(target.path)
                      if (downloaded) blob = downloaded
                    }
                  }
                  if (!blob) { alert('PDF not available yet. It will be ready once all members sign.'); return }
                  const dlUrl = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = dlUrl
                  a.download = `Operating_Agreement_${oa.company_name.replace(/\s+/g, '_')}.pdf`
                  a.click()
                  URL.revokeObjectURL(dlUrl)
                } catch { alert('Download failed. Please contact support.') }
              }}
              style={{ marginTop: 16, padding: '10px 32px', fontSize: 14, fontWeight: 600, background: '#0A3161', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'Georgia, serif' }}
            >
              Download Signed PDF
            </button>
          </div>
        )}

        {/* Partial sign confirmation (MMLLC, current member just signed but not all done) */}
        {isMultiSigner && signed && !allSigned && (
          <div style={{ background: '#f0f4ff', border: '1px solid #c7d4f0', borderRadius: 6, padding: 20, textAlign: 'center', marginTop: 24 }}>
            <p style={{ color: '#1a3b6d', fontWeight: 700, fontSize: 16, margin: 0 }}>
              Thank You — Your Signature Has Been Recorded
            </p>
            <p style={{ color: '#4a6da0', fontSize: 14, marginTop: 8 }}>
              {signatures.filter(s => s.status === 'signed').length + 1} of {totalSigners} members have signed.
              The Operating Agreement will be finalized once all members have signed.
            </p>
          </div>
        )}
      </div>

      {/* Action bar — outside the PDF capture area */}
      {canSign && (
        <div id="oa-action-bar" style={{ maxWidth: 800, margin: '24px auto', textAlign: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, maxWidth: 520, margin: '0 auto 14px', textAlign: 'left', fontSize: 13, color: '#444', cursor: 'pointer', lineHeight: 1.5 }}>
            <input
              type="checkbox"
              checked={consent}
              onChange={e => setConsent(e.target.checked)}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <span>
              {oa.language === 'it'
                ? 'Accetto di firmare questo Operating Agreement elettronicamente e che la mia firma elettronica ha lo stesso valore legale della firma autografa.'
                : 'I agree to sign this Operating Agreement electronically, and that my electronic signature is the legal equivalent of my handwritten signature.'}
            </span>
          </label>
          <button
            onClick={handleSign}
            disabled={signing || !consent}
            style={{
              padding: '14px 48px',
              fontSize: 16,
              fontWeight: 700,
              background: signing || !consent ? '#999' : '#0A3161',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: signing || !consent ? 'default' : 'pointer',
              fontFamily: 'Georgia, serif',
            }}
          >
            {signing ? 'Signing…' : 'Sign Operating Agreement'}
          </button>
        </div>
      )}

      {/* Other ways to complete — download a DRAFT to read or print, or declare
          you signed on paper.

          Shown in the portal too (this used to be hidden whenever the agreement
          was opened inside the portal iframe, i.e. on every route a client
          actually uses — so the feature reached nobody). Placed OUTSIDE the PDF
          capture area. The download is a DRAFT: it is stamped and its recital is
          in the unexecuted form, so it can never be passed off as signed. */}
      {verified && oa.status !== 'voided' && oa.status !== 'signed' && !allSigned && !handDone && (
        <div style={{ maxWidth: 800, margin: '0 auto 24px', padding: '16px 20px', background: '#faf9f5', border: '1px solid #e6e2d6', borderRadius: 8 }}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#666', textAlign: 'center' }}>
            {oa.language === 'it'
              ? 'Preferisci firmare a mano? Scarica una bozza da leggere o stampare.'
              : 'Prefer to sign on paper? Download a draft to read or print.'}
          </p>
          <div style={{ textAlign: 'center', marginBottom: canSign ? 16 : 0 }}>
            <a
              href={`/api/operating-agreement/${token}/pdf?code=${encodeURIComponent(accessCode)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 14, color: '#0A3161', textDecoration: 'underline', fontFamily: 'Georgia, serif' }}
            >
              {oa.language === 'it' ? 'Scarica la bozza (non firmata)' : 'Download the draft (unsigned)'}
            </a>
          </div>

          {canSign && !handMode && (
            <div style={{ textAlign: 'center' }}>
              <button
                onClick={() => { setHandError(''); setHandMode(true) }}
                style={{ padding: '10px 24px', fontSize: 14, fontWeight: 600, background: '#fff', color: '#0A3161', border: '1px solid #0A3161', borderRadius: 6, cursor: 'pointer', fontFamily: 'Georgia, serif' }}
              >
                {oa.language === 'it' ? 'Ho firmato a mano' : 'I signed it by hand'}
              </button>
            </div>
          )}

          {canSign && handMode && (
            <div style={{ marginTop: 8, padding: '16px', background: '#fff', border: '1px solid #e6e2d6', borderRadius: 6 }}>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: '#444', lineHeight: 1.6 }}>
                {oa.language === 'it'
                  ? 'Confermi di aver stampato e firmato a mano questo Operating Agreement. Se puoi, carica una copia firmata — è il documento che conserveremo per te.'
                  : 'You are confirming you have printed and signed this Operating Agreement by hand. If you can, upload a copy of the signed document — that is the copy we keep on file for you.'}
              </p>
              <input
                type="file"
                accept="application/pdf,image/*"
                onChange={e => setHandFile(e.target.files?.[0] ?? null)}
                style={{ display: 'block', marginBottom: 12, fontSize: 13 }}
              />
              {!handFile && (
                <p style={{ margin: '0 0 12px', fontSize: 12, color: '#a06a00' }}>
                  {oa.language === 'it'
                    ? 'Nessun file selezionato — puoi confermare comunque e inviarci la copia firmata più tardi.'
                    : 'No file chosen — you can still confirm and send us the signed copy later.'}
                </p>
              )}
              {handError && <p style={{ margin: '0 0 12px', fontSize: 13, color: '#c00' }}>{handError}</p>}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={handleHandSigned}
                  disabled={handSubmitting}
                  style={{ padding: '10px 24px', fontSize: 14, fontWeight: 700, background: handSubmitting ? '#999' : '#0A3161', color: '#fff', border: 'none', borderRadius: 6, cursor: handSubmitting ? 'default' : 'pointer', fontFamily: 'Georgia, serif' }}
                >
                  {handSubmitting
                    ? (oa.language === 'it' ? 'Invio…' : 'Submitting…')
                    : handFile
                      ? (oa.language === 'it' ? 'Conferma e carica' : 'Confirm & upload')
                      : (oa.language === 'it' ? 'Conferma senza copia' : 'Confirm without a copy')}
                </button>
                <button
                  onClick={() => { setHandMode(false); setHandFile(null); setHandError('') }}
                  disabled={handSubmitting}
                  style={{ padding: '10px 24px', fontSize: 14, background: 'transparent', color: '#666', border: '1px solid #ccc', borderRadius: 6, cursor: handSubmitting ? 'default' : 'pointer', fontFamily: 'Georgia, serif' }}
                >
                  {oa.language === 'it' ? 'Annulla' : 'Cancel'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Hand-signed confirmation */}
      {handDone && (
        <div style={{ maxWidth: 800, margin: '0 auto 24px', background: '#f0f7f0', border: '1px solid #cfe6cf', borderRadius: 8, padding: 20, textAlign: 'center' }}>
          <p style={{ color: '#2f6b2f', fontWeight: 700, fontSize: 16, margin: 0 }}>
            {oa.language === 'it' ? 'Grazie — registrato' : 'Thank you — recorded'}
          </p>
          <p style={{ color: '#4a8a4a', fontSize: 14, marginTop: 8 }}>
            {handDone === 'with-scan'
              ? (oa.language === 'it'
                  ? 'Abbiamo ricevuto la tua copia firmata ed è salvata nel tuo portale.'
                  : 'We received your signed copy and it is saved in your portal.')
              : (oa.language === 'it'
                  ? 'Abbiamo registrato la tua conferma. Se vuoi conservarne una copia, puoi caricare il documento firmato nella sezione Documenti del tuo portale.'
                  : 'We recorded your confirmation. If you would like a copy kept for you, you can upload the signed document in the Documents section of your portal.')}
          </p>
        </div>
      )}

      {/* MMLLC: read-only view without signer param */}
      {isMultiSigner && currentSignerIndex === null && !allSigned && verified && (
        <div style={{ maxWidth: 800, margin: '24px auto', textAlign: 'center' }}>
          <p style={{ color: '#666', fontSize: 14 }}>
            This is a read-only view. Each member must use their personal signing link to sign.
          </p>
        </div>
      )}
    </div>
  )
}

// --- Shared Styles ---------------------------------------
const h2Style: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0A3161',
  marginTop: 28,
  marginBottom: 12,
  borderBottom: '1px solid #eee',
  paddingBottom: 6,
}
