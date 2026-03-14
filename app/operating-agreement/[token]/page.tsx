'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic, LOGO_URL } from '@/lib/supabase/public-client'
import { generateOASections, type OAData } from '@/lib/types/oa-templates'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// ─── Types ──────────────────────────────────────────────
interface OAAgreement {
  id: string
  token: string
  access_code: string
  account_id: string
  contact_id: string
  company_name: string
  state_of_formation: string
  formation_date: string
  ein_number: string | null
  member_name: string
  member_address: string | null
  member_email: string | null
  member_ownership_pct: number
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
}

// ─── Helpers ────────────────────────────────────────────
function today() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// ─── Main Page ──────────────────────────────────────────
export default function OperatingAgreementPage() {
  const { token } = useParams<{ token: string }>()
  const searchParams = useSearchParams()
  const accessCode = searchParams.get('c') || ''

  const [isAdmin, setIsAdmin] = useState(false)
  const [oa, setOa] = useState<OAAgreement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Email gate
  const [verified, setVerified] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState('')

  // Signing
  const [signing, setSigning] = useState(false)
  const [signed, setSigned] = useState(false)
  const sigCanvasRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<any>(null)
  const oaBodyRef = useRef<HTMLDivElement>(null)

  // ─── LOAD OA ───
  const loadOA = useCallback(async () => {
    if (!token) return

    const adminMode = searchParams.get('preview') === 'td'
    if (adminMode) {
      setIsAdmin(true)
      setVerified(true)
    }

    const { data, error: err } = await supabasePublic
      .from('oa_agreements')
      .select('*')
      .eq('token', token)
      .single()

    if (err || !data) {
      setError('Operating Agreement not found.')
      setLoading(false)
      return
    }

    if (!adminMode && data.access_code !== accessCode) {
      setError('Invalid link.')
      setLoading(false)
      return
    }

    setOa(data)
    setSigned(!!data.signed_at)
    setLoading(false)

    if (adminMode) return

    // Check email gate cookie
    if (!data.member_email) {
      setVerified(true)
    } else {
      const cookie = document.cookie.split(';').find(c => c.trim().startsWith(`oa_verified_${token}=`))
      if (cookie) setVerified(true)
    }
  }, [token, accessCode, searchParams])

  useEffect(() => { loadOA() }, [loadOA])

  // Track view
  useEffect(() => {
    if (!oa || !verified || signed) return
    supabasePublic
      .from('oa_agreements')
      .update({
        view_count: (oa.view_count || 0) + 1,
        viewed_at: new Date().toISOString(),
        status: ['draft', 'sent'].includes(oa.status) ? 'viewed' : oa.status,
      })
      .eq('id', oa.id)
      .then(() => {})
  }, [oa?.id, verified]) // eslint-disable-line react-hooks/exhaustive-deps

  // Init signature pad
  useEffect(() => {
    if (!verified || !oa || signed) return
    const initSig = async () => {
      const SignaturePad = (await import('signature_pad')).default
      const canvas = sigCanvasRef.current
      if (!canvas) return
      canvas.width = canvas.offsetWidth * 2
      canvas.height = canvas.offsetHeight * 2
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.scale(2, 2)
      sigPadRef.current = new SignaturePad(canvas, { backgroundColor: 'rgb(255,255,255)' })
    }
    setTimeout(initSig, 300)
  }, [verified, oa, signed])

  // ─── EMAIL GATE ───
  function handleEmailVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!oa?.member_email) return
    if (emailInput.trim().toLowerCase() === oa.member_email.toLowerCase()) {
      document.cookie = `oa_verified_${token}=1; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
      setVerified(true)
      setEmailError('')
    } else {
      setEmailError('The email address does not match. Please try again.')
    }
  }

  // ─── SIGN ───
  async function handleSign() {
    if (!oa || !sigPadRef.current) return
    if (sigPadRef.current.isEmpty()) {
      alert('Please sign above before submitting.')
      return
    }

    setSigning(true)
    try {
      // 1. Get signature as image
      const sigDataUrl = sigPadRef.current.toDataURL('image/png')

      // 2. Freeze signature canvas → image
      const canvas = sigCanvasRef.current
      if (canvas) {
        const img = document.createElement('img')
        img.src = sigDataUrl
        img.style.width = canvas.style.width || `${canvas.offsetWidth}px`
        img.style.height = canvas.style.height || `${canvas.offsetHeight}px`
        canvas.parentNode?.replaceChild(img, canvas)
      }

      // 3. Hide action bar
      const actionBar = document.getElementById('oa-action-bar')
      if (actionBar) actionBar.style.display = 'none'

      // 4. Generate PDF from HTML
      const html2pdf = (await import('html2pdf.js')).default
      const element = oaBodyRef.current
      if (!element) throw new Error('OA body not found')

      const pdfBlob: Blob = await html2pdf()
        .set({
          margin: [0.5, 0.6, 0.7, 0.6],
          filename: `Operating_Agreement_${oa.company_name.replace(/\s+/g, '_')}.pdf`,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
        })
        .from(element)
        .outputPdf('blob')

      // 5. Upload to Supabase Storage
      const pdfPath = `${token}/oa-signed-${Date.now()}.pdf`
      const uploadRes = await fetch(`${SB_URL}/storage/v1/object/signed-oa/${pdfPath}`, {
        method: 'POST',
        headers: {
          'apikey': SB_ANON,
          'Authorization': `Bearer ${SB_ANON}`,
          'Content-Type': 'application/pdf',
        },
        body: pdfBlob,
      })
      if (!uploadRes.ok) throw new Error('PDF upload failed')

      // 6. Update OA record
      await supabasePublic
        .from('oa_agreements')
        .update({
          status: 'signed',
          signed_at: new Date().toISOString(),
          signature_data: { member_name: oa.member_name, signed_date: today() },
          pdf_storage_path: pdfPath,
        })
        .eq('id', oa.id)

      setSigned(true)
    } catch (err) {
      console.error('Signing failed:', err)
      alert('An error occurred while signing. Please try again.')
    } finally {
      setSigning(false)
    }
  }

  // ─── RENDER ───

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

  if (!oa) return null

  // Email gate
  const isAdminPreview = searchParams.get('preview') === 'td'
  if (!verified && !isAdminPreview) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'Georgia, serif', background: '#f8f8f8' }}>
        <div style={{ background: '#fff', padding: 40, borderRadius: 8, boxShadow: '0 2px 20px rgba(0,0,0,0.08)', maxWidth: 420, width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <img src={LOGO_URL} alt="Tony Durante LLC" style={{ height: 50, marginBottom: 16 }} />
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
            <button type="submit" style={{ width: '100%', padding: '12px', fontSize: 16, background: '#0A3161', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
              View Operating Agreement
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Generate OA sections from template
  const oaData: OAData = {
    company_name: oa.company_name,
    state_of_formation: oa.state_of_formation,
    formation_date: oa.formation_date,
    ein_number: oa.ein_number || undefined,
    member_name: oa.member_name,
    member_address: oa.member_address || undefined,
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

  return (
    <div style={{ background: '#f5f5f0', minHeight: '100vh', padding: '24px 16px', fontFamily: 'Georgia, "Times New Roman", serif' }}>
      <div
        ref={oaBodyRef}
        style={{ maxWidth: 800, margin: '0 auto', background: '#fff', padding: '48px 56px', boxShadow: '0 1px 12px rgba(0,0,0,0.08)', lineHeight: 1.7, fontSize: 14, color: '#222' }}
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
          <img src={LOGO_URL} alt="Tony Durante LLC" style={{ height: 48, marginBottom: 16 }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: 1 }}>OPERATING AGREEMENT</h1>
          <p style={{ fontSize: 15, color: '#555', marginTop: 4 }}>{oa.company_name}</p>
          <p style={{ fontSize: 13, color: '#888', marginTop: 2 }}>
            A {oa.state_of_formation} Single Member Limited Liability Company
          </p>
          <div style={{ width: 60, height: 2, background: '#0A3161', margin: '12px auto' }} />
        </div>

        {/* Preamble */}
        <p style={{ fontStyle: 'italic' }}>
          This Operating Agreement (&ldquo;Agreement&rdquo;) of {oa.company_name} (the &ldquo;Company&rdquo;) is entered into
          and effective as of {today()}, by {oa.member_name} (the &ldquo;Member&rdquo;).
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
          IN WITNESS WHEREOF, the Member has executed this Operating Agreement as of the date first written above.
        </p>

        <div style={{ maxWidth: 400 }}>
          <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, textTransform: 'uppercase', color: '#555' }}>SOLE MEMBER</p>
          <p style={{ fontWeight: 700, marginBottom: 12 }}>{oa.company_name}</p>
          <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Print Name: <strong style={{ color: '#222' }}>{oa.member_name}</strong></p>
          <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Title: Sole Member / Manager</p>
          <p style={{ fontSize: 13, color: '#666' }}>Date: {today()}</p>

          {/* Signature canvas */}
          {!signed && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Member Signature:</p>
              <canvas
                ref={sigCanvasRef}
                style={{ width: '100%', height: 100, border: '1px solid #ccc', borderRadius: 4, background: '#fff', cursor: 'crosshair' }}
              />
              <button
                onClick={() => sigPadRef.current?.clear()}
                style={{ marginTop: 4, fontSize: 12, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Clear signature
              </button>
            </div>
          )}
        </div>

        {/* Signed confirmation */}
        {signed && (
          <div style={{ background: '#f0f7f0', border: '1px solid #b8d4b8', borderRadius: 6, padding: 20, textAlign: 'center', marginTop: 24 }}>
            <p style={{ color: '#2d6a2d', fontWeight: 700, fontSize: 16, margin: 0 }}>Operating Agreement Signed Successfully</p>
            <p style={{ color: '#4a8a4a', fontSize: 14, marginTop: 8 }}>
              A copy has been saved. Tony Durante LLC will be in touch shortly.
            </p>
          </div>
        )}
      </div>

      {/* Action bar — outside the PDF capture area */}
      {!signed && (
        <div id="oa-action-bar" style={{ maxWidth: 800, margin: '24px auto', textAlign: 'center' }}>
          <button
            onClick={handleSign}
            disabled={signing}
            style={{
              padding: '14px 48px',
              fontSize: 16,
              fontWeight: 700,
              background: signing ? '#999' : '#0A3161',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: signing ? 'default' : 'pointer',
              fontFamily: 'Georgia, serif',
            }}
          >
            {signing ? 'Generating PDF...' : 'Sign Operating Agreement'}
          </button>
          <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>
            By clicking, you confirm that you have read and agree to the terms above.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Shared Styles ──────────────────────────────────────
const h2Style: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#0A3161',
  marginTop: 28,
  marginBottom: 12,
  borderBottom: '1px solid #eee',
  paddingBottom: 6,
}
