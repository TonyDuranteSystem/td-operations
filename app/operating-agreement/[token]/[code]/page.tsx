'use client'

import { Suspense, useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic } from '@/lib/supabase/public-client'
import { generateOASections, type OAData, type OAMember } from '@/lib/types/oa-templates'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// --- Types -----------------------------------------------
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
  entity_type: string | null
  manager_name: string | null
  member_name: string
  member_address: string | null
  member_email: string | null
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
  member_email: string | null
  contact_id: string | null
  access_code: string
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

  // Signing
  const [signing, setSigning] = useState(false)
  const [signed, setSigned] = useState(false)
  const [allSigned, setAllSigned] = useState(false)
  const sigCanvasRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const oaBodyRef = useRef<HTMLDivElement>(null)
  const pdfBlobRef = useRef<Blob | null>(null)

  // Signature images fetched from storage (for already-signed members)
  const [sigImages, setSigImages] = useState<Record<number, string>>({})

  // Derived
  const entityType = oa?.entity_type || 'SMLLC'
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
  const loadOA = useCallback(async () => {
    if (!token) return

    const adminMode = searchParams.get('preview') === 'td'
    const portalMode = searchParams.get('portal') === 'true'
    const signerCode = searchParams.get('signer')

    if (adminMode) {
      setIsAdmin(true)
      setVerified(true)
    }
    if (portalMode) {
      setIsPortal(true)
      setVerified(true)
    }
    // signerCode is used below to resolve the member from oa_signatures

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
    const isFullySigned = data.status === 'signed' && data.signed_at
    setAllSigned(!!isFullySigned)

    // Load signatures for MMLLC
    const isMulti = (data.entity_type === 'MMLLC') && (data.total_signers || 1) > 1
    if (isMulti) {
      const { data: sigs } = await supabasePublic
        .from('oa_signatures')
        .select('*')
        .eq('oa_id', data.id)
        .order('member_index')

      if (sigs) {
        setSignatures(sigs)

        // Determine current signer from ?signer= access code
        if (signerCode) {
          const match = sigs.find(s => s.access_code === signerCode)
          if (match) {
            setCurrentSignerIndex(match.member_index)
            setSigned(match.status === 'signed')
          } else {
            setError('Invalid signing link.')
            setLoading(false)
            return
          }
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
      }
    } else {
      // SMLLC
      setSigned(!!data.signed_at)
    }

    setLoading(false)

    if (adminMode) return

    // Check email gate cookie
    if (isMulti && signerCode) {
      // Per-member email gate for MMLLC
      const matchSig = (await supabasePublic
        .from('oa_signatures')
        .select('member_email, member_index')
        .eq('oa_id', data.id)
        .eq('access_code', signerCode)
        .single()).data

      if (!matchSig?.member_email) {
        setVerified(true)
      } else if (!portalMode) {
        const cookie = document.cookie.split(';').find(c => c.trim().startsWith(`oa_verified_${token}_${matchSig.member_index}=`))
        if (cookie) setVerified(true)
      }
    } else {
      // SMLLC email gate
      if (!data.member_email) {
        setVerified(true)
      } else if (!portalMode) {
        const cookie = document.cookie.split(';').find(c => c.trim().startsWith(`oa_verified_${token}=`))
        if (cookie) setVerified(true)
      }
    }
  }, [token, accessCode, searchParams])

  useEffect(() => { loadOA() }, [loadOA])

  // Track view
  useEffect(() => {
    if (!oa || !verified || allSigned) return

    // Update OA view count
    supabasePublic
      .from('oa_agreements')
      .update({
        view_count: (oa.view_count || 0) + 1,
        viewed_at: new Date().toISOString(),
        status: ['draft', 'sent'].includes(oa.status) ? 'viewed' : oa.status,
      })
      .eq('id', oa.id)
      .then(() => {})

    // Update per-member view for MMLLC
    if (currentSig && currentSig.status !== 'signed') {
      supabasePublic
        .from('oa_signatures')
        .update({
          view_count: (currentSig.view_count || 0) + 1,
          viewed_at: new Date().toISOString(),
          status: ['pending', 'sent'].includes(currentSig.status) ? 'viewed' : currentSig.status,
        })
        .eq('id', currentSig.id)
        .then(() => {})
    }
  }, [oa?.id, verified]) // eslint-disable-line react-hooks/exhaustive-deps

  // Init signature pad
  useEffect(() => {
    if (!verified || !oa || signed || currentSignerAlreadySigned) return
    // For MMLLC without signer param, don't show signature pad
    if (isMultiSigner && currentSignerIndex === null) return

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
  }, [verified, oa, signed, currentSignerAlreadySigned, isMultiSigner, currentSignerIndex])

  // --- EMAIL GATE ---
  function handleEmailVerify(e: React.FormEvent) {
    e.preventDefault()

    const expectedEmail = isMultiSigner && currentSig
      ? currentSig.member_email
      : oa?.member_email

    if (!expectedEmail) return

    if (emailInput.trim().toLowerCase() === expectedEmail.toLowerCase()) {
      const cookieKey = isMultiSigner && currentSignerIndex !== null
        ? `oa_verified_${token}_${currentSignerIndex}`
        : `oa_verified_${token}`
      document.cookie = `${cookieKey}=1; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
      setVerified(true)
      setEmailError('')
    } else {
      setEmailError('The email address does not match. Please try again.')
    }
  }

  // --- SIGN ---
  async function handleSign() {
    if (!oa || !sigPadRef.current) return
    if (sigPadRef.current.isEmpty()) {
      alert('Please sign above before submitting.')
      return
    }

    setSigning(true)
    try {
      const sigDataUrl = sigPadRef.current.toDataURL('image/png')

      if (isMultiSigner && currentSignerIndex !== null && currentSig) {
        // ─── MMLLC: Save signature PNG to storage ───
        const sigPngPath = `${token}/sig-${currentSignerIndex}.png`
        const sigBlob = await (await fetch(sigDataUrl)).blob()

        await fetch(`${SB_URL}/storage/v1/object/signed-oa/${sigPngPath}`, {
          method: 'POST',
          headers: {
            'apikey': SB_ANON,
            'Authorization': `Bearer ${SB_ANON}`,
            'Content-Type': 'image/png',
          },
          body: sigBlob,
        })

        // Update oa_signatures row
        await supabasePublic
          .from('oa_signatures')
          .update({
            status: 'signed',
            signed_at: new Date().toISOString(),
            signature_image_path: sigPngPath,
            updated_at: new Date().toISOString(),
          })
          .eq('id', currentSig.id)

        // Atomic increment signed_count
        const { data: updatedOa } = await supabasePublic.rpc('increment_oa_signed_count', { oa_uuid: oa.id })

        // Check if we're the last signer
        const newSignedCount = updatedOa ?? ((oa.signed_count || 0) + 1)
        const isLastSigner = newSignedCount >= totalSigners

        if (isLastSigner) {
          // ─── Last signer: generate combined PDF ───
          // Replace canvas with image
          const canvas = sigCanvasRef.current
          if (canvas) {
            const img = document.createElement('img')
            img.src = sigDataUrl
            img.style.width = canvas.style.width || `${canvas.offsetWidth}px`
            img.style.height = canvas.style.height || `${canvas.offsetHeight}px`
            canvas.parentNode?.replaceChild(img, canvas)
          }

          // Hide action bar
          const actionBar = document.getElementById('oa-action-bar')
          if (actionBar) actionBar.style.display = 'none'

          // Generate PDF with ALL signatures
          const html2pdf = (await import('html2pdf.js')).default
          const element = oaBodyRef.current
          if (element) {
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

            pdfBlobRef.current = pdfBlob

            // Upload combined PDF
            const pdfPath = `${token}/oa-signed-${Date.now()}.pdf`
            await fetch(`${SB_URL}/storage/v1/object/signed-oa/${pdfPath}`, {
              method: 'POST',
              headers: {
                'apikey': SB_ANON,
                'Authorization': `Bearer ${SB_ANON}`,
                'Content-Type': 'application/pdf',
              },
              body: pdfBlob,
            })

            // Update OA record to fully signed
            await supabasePublic
              .from('oa_agreements')
              .update({
                status: 'signed',
                signed_at: new Date().toISOString(),
                pdf_storage_path: pdfPath,
                signature_data: {
                  members: members.map(m => m.name),
                  signed_date: today(),
                  multi_signer: true,
                },
              })
              .eq('id', oa.id)
          }

          setAllSigned(true)
        } else {
          // Not last signer — update OA to partially_signed
          await supabasePublic
            .from('oa_agreements')
            .update({
              status: 'partially_signed',
            })
            .eq('id', oa.id)
        }

        // Notify backend
        try {
          await fetch('/api/oa-signed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oa_id: oa.id, token, member_index: currentSignerIndex }),
          })
        } catch {
          // Non-blocking
        }

        setSigned(true)

        if (isPortal && window.parent !== window) {
          window.parent.postMessage({ type: 'oa-signed', token, member_index: currentSignerIndex }, '*')
        }
      } else {
        // ─── SMLLC: existing flow ───
        const canvas = sigCanvasRef.current
        if (canvas) {
          const img = document.createElement('img')
          img.src = sigDataUrl
          img.style.width = canvas.style.width || `${canvas.offsetWidth}px`
          img.style.height = canvas.style.height || `${canvas.offsetHeight}px`
          canvas.parentNode?.replaceChild(img, canvas)
        }

        const actionBar = document.getElementById('oa-action-bar')
        if (actionBar) actionBar.style.display = 'none'

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

        pdfBlobRef.current = pdfBlob

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

        const sigData: Record<string, unknown> = {
          manager_name: managerName,
          signed_date: today(),
        }
        if (isMMLLC) {
          sigData.members = members.map(m => m.name)
        } else {
          sigData.member_name = oa.member_name
        }

        await supabasePublic
          .from('oa_agreements')
          .update({
            status: 'signed',
            signed_at: new Date().toISOString(),
            signature_data: sigData,
            pdf_storage_path: pdfPath,
            signed_count: 1,
          })
          .eq('id', oa.id)

        try {
          await fetch('/api/oa-signed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oa_id: oa.id, token }),
          })
        } catch {
          // Non-blocking
        }

        setSigned(true)

        if (isPortal && window.parent !== window) {
          window.parent.postMessage({ type: 'oa-signed', token }, '*')
        }
      }
    } catch (err) {
      console.error('Signing failed:', err)
      alert('An error occurred while signing. Please try again.')
    } finally {
      setSigning(false)
    }
  }

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

  if (!oa) return null

  // Email gate
  const isAdminPreview = searchParams.get('preview') === 'td'
  if (!verified && !isAdminPreview && !isPortal) {
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
            <button type="submit" style={{ width: '100%', padding: '12px', fontSize: 16, background: '#0A3161', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
              View Operating Agreement
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Can this user sign? (MMLLC: only if they have a signer param and haven't signed yet)
  const canSign = isMultiSigner
    ? (currentSignerIndex !== null && !currentSignerAlreadySigned && !signed)
    : (!signed && !allSigned)

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
          and effective as of {today()}, by {preambleSigners}.
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

                  {/* Current signer — active signature pad */}
                  {isCurrent && !isSigned && !signed && (
                    <div style={{ marginTop: 12 }}>
                      <p style={{ fontSize: 12, color: '#0A3161', fontWeight: 600, marginBottom: 6 }}>Your Signature:</p>
                      <canvas
                        ref={sigCanvasRef}
                        style={{ width: '100%', height: 100, border: '2px solid #0A3161', borderRadius: 4, background: '#fff', cursor: 'crosshair' }}
                      />
                      <button
                        onClick={() => sigPadRef.current?.clear()}
                        style={{ marginTop: 4, fontSize: 12, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        Clear signature
                      </button>
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
                <canvas
                  ref={sigCanvasRef}
                  style={{ width: '100%', maxWidth: 400, height: 100, border: '1px solid #ccc', borderRadius: 4, background: '#fff', cursor: 'crosshair' }}
                />
                <button
                  onClick={() => sigPadRef.current?.clear()}
                  style={{ marginTop: 4, fontSize: 12, color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Clear signature
                </button>
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
                    const { data } = await supabasePublic.storage.from('signed-oa').list(token)
                    const pdfFile = data?.filter(f => f.name.endsWith('.pdf')).sort((a, b) => b.name.localeCompare(a.name))[0]
                    if (pdfFile) {
                      const { data: downloaded } = await supabasePublic.storage.from('signed-oa').download(`${token}/${pdfFile.name}`)
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
            {signing ? 'Generating...' : 'Sign Operating Agreement'}
          </button>
          <p style={{ fontSize: 13, color: '#888', marginTop: 8 }}>
            By clicking, you confirm that you have read and agree to the terms above.
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
