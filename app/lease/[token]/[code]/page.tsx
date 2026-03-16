'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic, LOGO_URL } from '@/lib/supabase/public-client'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// ─── Types ──────────────────────────────────────────────
interface LeaseAgreement {
  id: string
  token: string
  access_code: string
  tenant_company: string
  tenant_ein: string | null
  tenant_state: string | null
  tenant_contact_name: string
  tenant_email: string | null
  landlord_name: string
  landlord_address: string
  landlord_signer: string
  landlord_title: string
  premises_address: string
  suite_number: string
  square_feet: number
  effective_date: string
  term_start_date: string
  term_end_date: string
  term_months: number
  contract_year: number
  monthly_rent: number
  yearly_rent: number
  security_deposit: number
  late_fee: number
  late_fee_per_day: number
  status: string
  language: string
  view_count: number
  signed_at: string | null
}

// ─── Helpers ────────────────────────────────────────────
function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtCurrency(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function today() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// ─── Main Page ──────────────────────────────────────────
export default function LeasePageWithCode() {
  const { token, code } = useParams<{ token: string; code: string }>()
  const searchParams = useSearchParams()

  const [isAdmin, setIsAdmin] = useState(false)
  const [lease, setLease] = useState<LeaseAgreement | null>(null)
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
  const leaseBodyRef = useRef<HTMLDivElement>(null)

  // ─── LOAD LEASE ───
  const loadLease = useCallback(async () => {
    if (!token) return

    // Admin preview bypass
    const adminMode = searchParams.get('preview') === 'td'
    if (adminMode) {
      setIsAdmin(true)
      setVerified(true)
    }

    const { data, error: err } = await supabasePublic
      .from('lease_agreements')
      .select('*')
      .eq('token', token)
      .single()

    if (err || !data) {
      setError('Lease agreement not found.')
      setLoading(false)
      return
    }

    if (!adminMode && data.access_code !== code) {
      setError('Invalid link.')
      setLoading(false)
      return
    }

    setLease(data)
    setSigned(!!data.signed_at)
    setLoading(false)

    if (adminMode) return

    // Check email gate cookie
    if (!data.tenant_email) {
      setVerified(true)
    } else {
      const cookie = document.cookie.split(';').find(c => c.trim().startsWith(`lease_verified_${token}=`))
      if (cookie) setVerified(true)
    }
  }, [token, code, searchParams])

  useEffect(() => { loadLease() }, [loadLease])

  // Track view
  useEffect(() => {
    if (!lease || !verified || signed) return
    supabasePublic
      .from('lease_agreements')
      .update({
        view_count: (lease.view_count || 0) + 1,
        viewed_at: new Date().toISOString(),
        status: ['draft', 'sent'].includes(lease.status) ? 'viewed' : lease.status,
      })
      .eq('id', lease.id)
      .then(() => {})
  }, [lease?.id, verified]) // eslint-disable-line react-hooks/exhaustive-deps

  // Init signature pad
  useEffect(() => {
    if (!verified || !lease || signed) return
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
  }, [verified, lease, signed])

  // ─── EMAIL GATE ───
  function handleEmailVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!lease?.tenant_email) return
    if (emailInput.trim().toLowerCase() === lease.tenant_email.toLowerCase()) {
      document.cookie = `lease_verified_${token}=1; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
      setVerified(true)
      setEmailError('')
    } else {
      setEmailError('The email address does not match. Please try again.')
    }
  }

  // ─── SIGN ───
  async function handleSign() {
    if (!lease || !sigPadRef.current) return
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
      const actionBar = document.getElementById('lease-action-bar')
      if (actionBar) actionBar.style.display = 'none'

      // 4. Generate PDF from HTML
      const html2pdf = (await import('html2pdf.js')).default
      const element = leaseBodyRef.current
      if (!element) throw new Error('Lease body not found')

      const pdfBlob: Blob = await html2pdf()
        .set({
          margin: [0.5, 0.6, 0.7, 0.6],
          filename: `Office_Lease_Agreement_${lease.tenant_company.replace(/\s+/g, '_')}.pdf`,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
        })
        .from(element)
        .outputPdf('blob')

      // 5. Upload to Supabase Storage
      const pdfPath = `${token}/lease-signed-${Date.now()}.pdf`
      const uploadRes = await fetch(`${SB_URL}/storage/v1/object/signed-leases/${pdfPath}`, {
        method: 'POST',
        headers: {
          'apikey': SB_ANON,
          'Authorization': `Bearer ${SB_ANON}`,
          'Content-Type': 'application/pdf',
        },
        body: pdfBlob,
      })
      if (!uploadRes.ok) throw new Error('PDF upload failed')

      // 6. Update lease record
      await supabasePublic
        .from('lease_agreements')
        .update({
          status: 'signed',
          signed_at: new Date().toISOString(),
          pdf_storage_path: pdfPath,
        })
        .eq('id', lease.id)

      // 7. Notify backend (email to support@, SD history, task creation)
      try {
        await fetch('/api/lease-signed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lease_id: lease.id, token: lease.token }),
        })
      } catch {
        // Non-blocking — signing is already saved
      }

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
        <p style={{ color: '#666', fontSize: 18 }}>Loading lease agreement...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'Georgia, serif' }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ color: '#333', marginBottom: 8 }}>Lease Agreement</h2>
          <p style={{ color: '#999' }}>{error}</p>
        </div>
      </div>
    )
  }

  if (!lease) return null

  // Email gate (admin preview bypasses synchronously)
  const isAdminPreview = searchParams.get('preview') === 'td'
  if (!verified && !isAdminPreview) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', fontFamily: 'Georgia, serif', background: '#f8f8f8' }}>
        <div style={{ background: '#fff', padding: 40, borderRadius: 8, boxShadow: '0 2px 20px rgba(0,0,0,0.08)', maxWidth: 420, width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <img src={LOGO_URL} alt="Tony Durante LLC" style={{ height: 50, marginBottom: 16 }} />
            <h2 style={{ fontSize: 20, color: '#222', margin: 0 }}>Verify Your Identity</h2>
            <p style={{ fontSize: 14, color: '#666', marginTop: 8 }}>Enter the email address associated with this lease to view it.</p>
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
              View Lease Agreement
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Full address with suite
  const fullAddress = `${lease.premises_address.replace(/,?\s*(Largo|FL|33771).*/i, '')}, Suite ${lease.suite_number}, Largo, FL 33771`
  const tenantEinDisplay = lease.tenant_ein ? ` (EIN: ${lease.tenant_ein})` : ''
  const tenantStateDisplay = lease.tenant_state ? `a ${lease.tenant_state}` : 'a'

  return (
    <div style={{ background: '#f5f5f0', minHeight: '100vh', padding: '24px 16px', fontFamily: 'Georgia, "Times New Roman", serif' }}>
      <div
        ref={leaseBodyRef}
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
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: 1 }}>OFFICE LEASE AGREEMENT</h1>
          <div style={{ width: 60, height: 2, background: '#0A3161', margin: '12px auto' }} />
        </div>

        {/* Preamble */}
        <p style={{ fontStyle: 'italic' }}>
          This Office Lease Agreement (&ldquo;Agreement&rdquo;) is entered into and made effective as of {fmtDate(lease.effective_date)} (&ldquo;Effective Date&rdquo;), by and between:
        </p>

        {/* Parties */}
        <div style={{ margin: '20px 0', padding: '16px 24px', background: '#fafafa', border: '1px solid #eee', borderRadius: 4 }}>
          <p style={{ margin: '0 0 12px' }}>
            <strong>LANDLORD:</strong><br />
            {lease.landlord_name}, a Florida Limited Liability Company<br />
            {lease.landlord_address}<br />
            <em>(&ldquo;Landlord&rdquo;)</em>
          </p>
          <p style={{ margin: 0 }}>
            <strong>TENANT:</strong><br />
            {lease.tenant_company}, {tenantStateDisplay} Limited Liability Company{tenantEinDisplay}<br />
            Represented by: {lease.tenant_contact_name}, Owner/Member<br />
            <em>(&ldquo;Tenant&rdquo;)</em>
          </p>
        </div>

        <p>The Landlord and Tenant are collectively referred to as the &ldquo;Parties.&rdquo; The Parties hereby agree as follows:</p>

        <hr style={{ border: 'none', borderTop: '1px solid #ddd', margin: '24px 0' }} />

        {/* Article 1 */}
        <h2 style={h2Style}>Article 1 &mdash; Premises</h2>
        <p>Landlord hereby leases to Tenant, and Tenant hereby leases from Landlord, the following described premises:</p>
        <div style={{ marginLeft: 24, marginBottom: 16 }}>
          <p><strong>Address:</strong> {fullAddress}</p>
          <p><strong>Description:</strong> Approximately {lease.square_feet} square feet of furnished office space, including desk, chair, and access to shared common areas (&ldquo;Premises&rdquo;).</p>
        </div>

        {/* Article 2 */}
        <h2 style={h2Style}>Article 2 &mdash; Term</h2>
        <p><strong>2.1</strong> The initial term of this Agreement shall commence on {fmtDate(lease.term_start_date)} and shall expire on {fmtDate(lease.term_end_date)} (&ldquo;Initial Term&rdquo;).</p>
        <p><strong>2.2</strong> Upon expiration of the Initial Term, this Agreement shall automatically renew for successive twelve (12) month periods (&ldquo;Renewal Term&rdquo;), unless either Party provides written notice of non-renewal at least thirty (30) days prior to the expiration of the then-current term.</p>
        <p><strong>2.3</strong> The Initial Term and any Renewal Term are collectively referred to as the &ldquo;Term.&rdquo;</p>

        {/* Article 3 */}
        <h2 style={h2Style}>Article 3 &mdash; Rent</h2>
        <p><strong>3.1</strong> Tenant shall pay Landlord a monthly rent of {fmtCurrency(lease.monthly_rent)} (&ldquo;Monthly Rent&rdquo;), totaling {fmtCurrency(lease.yearly_rent)} per annum.</p>
        <p><strong>3.2</strong> Monthly Rent shall be due and payable on the first (1st) day of each calendar month during the Term.</p>
        <p><strong>3.3</strong> If the Term commences on a date other than the first day of a calendar month, the Monthly Rent for the first partial month shall be prorated on a per diem basis.</p>
        <p><strong>3.4</strong> Rent shall be paid by electronic funds transfer or such other method as agreed upon by the Parties.</p>

        {/* Article 4 */}
        <h2 style={h2Style}>Article 4 &mdash; Security Deposit</h2>
        <p><strong>4.1</strong> Upon execution of this Agreement, Tenant shall pay Landlord a security deposit of {fmtCurrency(lease.security_deposit)} (&ldquo;Security Deposit&rdquo;).</p>
        <p><strong>4.2</strong> The Security Deposit shall be held by Landlord as security for the faithful performance by Tenant of all terms and conditions of this Agreement.</p>
        <p><strong>4.3</strong> Landlord may apply the Security Deposit toward any unpaid rent, damages, or other amounts owed by Tenant. In such event, Tenant shall replenish the Security Deposit to its full amount within ten (10) business days of written notice from Landlord.</p>
        <p><strong>4.4</strong> The Security Deposit, less any lawful deductions, shall be returned to Tenant within thirty (30) days following the termination of this Agreement and Tenant&apos;s complete vacation of the Premises.</p>

        {/* Article 5 */}
        <h2 style={h2Style}>Article 5 &mdash; Permitted Use</h2>
        <p><strong>5.1</strong> The Premises shall be used and occupied by Tenant solely for general office and administrative purposes in connection with Tenant&apos;s lawful business operations.</p>
        <p><strong>5.2</strong> Tenant shall not use the Premises for any unlawful purpose or in any manner that would constitute a nuisance, disturb other tenants, or increase the insurance premiums for the building.</p>

        {/* Article 6 */}
        <h2 style={h2Style}>Article 6 &mdash; Utilities and Services</h2>
        <p><strong>6.1</strong> Landlord shall provide the following utilities and services at no additional cost to Tenant: electricity, heating, ventilation and air conditioning (HVAC), internet connectivity, water and sewage, and common area maintenance and janitorial service.</p>
        <p><strong>6.2</strong> Building common areas, including restrooms, hallways, and reception areas, shall be accessible to Tenant during normal business hours, Monday through Friday, 8:30 AM to 5:00 PM, excluding federal holidays.</p>

        {/* Article 7 */}
        <h2 style={h2Style}>Article 7 &mdash; Maintenance and Repairs</h2>
        <p><strong>7.1</strong> Landlord shall maintain the Premises and all building systems (structural, mechanical, electrical, plumbing) in good working order and condition.</p>
        <p><strong>7.2</strong> Tenant shall maintain the interior of the Premises in a clean and orderly condition and shall promptly notify Landlord of any needed repairs.</p>
        <p><strong>7.3</strong> Tenant shall be responsible for any damage to the Premises caused by the negligence or willful acts of Tenant, its employees, agents, or invitees.</p>

        {/* Article 8 */}
        <h2 style={h2Style}>Article 8 &mdash; Insurance</h2>
        <p><strong>8.1</strong> Tenant shall, at its sole cost, maintain commercial general liability insurance with coverage limits of not less than $1,000,000 per occurrence, naming Landlord as an additional insured. Tenant shall provide Landlord with a certificate of insurance upon request.</p>
        <p><strong>8.2</strong> Landlord shall maintain property insurance covering the building and its common areas.</p>

        {/* Article 9 */}
        <h2 style={h2Style}>Article 9 &mdash; Compliance with Law</h2>
        <p>Tenant shall comply with all applicable federal, state, and local laws, ordinances, codes, rules, and regulations in the use and occupancy of the Premises. Failure to comply may result in termination of this Agreement upon written notice from Landlord.</p>

        {/* Article 10 */}
        <h2 style={h2Style}>Article 10 &mdash; Indemnification</h2>
        <p>Tenant agrees to indemnify, defend, and hold harmless Landlord from and against any and all claims, damages, losses, costs, and expenses (including reasonable attorney&apos;s fees) arising from Tenant&apos;s use and occupancy of the Premises or from any activity, work, or act performed by Tenant, its employees, agents, contractors, or invitees in or about the Premises.</p>

        {/* Article 11 */}
        <h2 style={h2Style}>Article 11 &mdash; Confidentiality</h2>
        <p>Tenant recognizes that it may, in the course of using the Premises, come into possession of confidential and proprietary business information (&ldquo;Confidential Information&rdquo;) about Landlord. Tenant agrees that during the Term and for a period of two (2) years thereafter: (a) Tenant shall exercise reasonable care to avoid disclosure or unauthorized use of Confidential Information; (b) Tenant will use Confidential Information solely for the purposes of this Agreement; and (c) Tenant will not disclose Confidential Information to any third party without the express prior written consent of the Landlord.</p>

        {/* Article 12 */}
        <h2 style={h2Style}>Article 12 &mdash; Late Payments</h2>
        <p><strong>12.1</strong> Any Monthly Rent not received by Landlord within five (5) days after its due date shall incur a late fee of {fmtCurrency(lease.late_fee)}.</p>
        <p><strong>12.2</strong> An additional fee of {fmtCurrency(lease.late_fee_per_day)} per day shall accrue for each day the payment remains outstanding beyond the tenth (10th) day after the due date.</p>
        <p><strong>12.3</strong> Landlord reserves the right to pursue all available legal remedies for collection of unpaid amounts.</p>

        {/* Article 13 */}
        <h2 style={h2Style}>Article 13 &mdash; Default and Remedies</h2>
        <p><strong>13.1</strong> The occurrence of any of the following shall constitute a default by Tenant:</p>
        <div style={{ marginLeft: 24 }}>
          <p>(a) Failure to pay Rent or any other sum due hereunder within fifteen (15) days after written notice of non-payment.</p>
          <p>(b) Failure to perform or comply with any other term or condition of this Agreement within thirty (30) days after written notice specifying the nature of the default.</p>
          <p>(c) The filing of a petition in bankruptcy by or against Tenant, or the appointment of a receiver for Tenant&apos;s assets.</p>
          <p>(d) Abandonment of the Premises.</p>
          <p>(e) Conducting any illegal activity on the Premises.</p>
          <p>(f) Any act or omission that causes material damage to the Premises or building.</p>
          <p>(g) Tenant becomes a nuisance negatively affecting other tenants&apos; ability to conduct business.</p>
        </div>
        <p><strong>13.2</strong> Upon the occurrence of a default, Landlord may, at its option: (a) terminate this Agreement upon written notice to Tenant; (b) re-enter and take possession of the Premises; and/or (c) pursue any and all remedies available at law or in equity.</p>

        {/* Article 14 */}
        <h2 style={h2Style}>Article 14 &mdash; Termination</h2>
        <p><strong>14.1</strong> Either Party may terminate this Agreement by providing the other Party with at least thirty (30) days prior written notice.</p>
        <p><strong>14.2</strong> Upon termination, Tenant shall vacate the Premises, remove all personal property, and return the Premises in the same condition as received, ordinary wear and tear excepted.</p>

        {/* Article 15 */}
        <h2 style={h2Style}>Article 15 &mdash; Notice</h2>
        <p>All notices required or permitted under this Agreement shall be in writing and shall be deemed delivered when sent by email, certified mail, or hand-delivered to the addresses set forth above or to such other address as either Party may designate in writing.</p>

        {/* Article 16 */}
        <h2 style={h2Style}>Article 16 &mdash; Attorney&apos;s Fees</h2>
        <p>In the event of any legal action arising out of or relating to this Agreement, the prevailing party shall be entitled to recover its reasonable attorney&apos;s fees and costs from the non-prevailing party.</p>

        {/* Article 17 */}
        <h2 style={h2Style}>Article 17 &mdash; Governing Law and Jurisdiction</h2>
        <p>This Agreement shall be governed by and construed in accordance with the laws of the State of Florida. Any legal action or proceeding arising under this Agreement shall be brought exclusively in the courts of Pinellas County, Florida.</p>

        {/* Article 18 */}
        <h2 style={h2Style}>Article 18 &mdash; Entire Agreement</h2>
        <p>This Agreement constitutes the entire agreement between the Parties and supersedes all prior negotiations, representations, warranties, commitments, and agreements. This Agreement may not be modified except by a written instrument signed by both Parties.</p>

        {/* Article 19 */}
        <h2 style={h2Style}>Article 19 &mdash; Severability</h2>
        <p>If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.</p>

        <hr style={{ border: 'none', borderTop: '2px solid #0A3161', margin: '32px 0' }} />

        {/* Signature Section */}
        <p style={{ fontWeight: 700, fontSize: 15, marginBottom: 24 }}>
          IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date written above.
        </p>

        <div style={{ display: 'flex', gap: 40, marginBottom: 24 }}>
          {/* Landlord */}
          <div style={{ flex: 1 }}>
            <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, textTransform: 'uppercase', color: '#555' }}>Landlord</p>
            <p style={{ fontWeight: 700, marginBottom: 8 }}>{lease.landlord_name}</p>
            <div style={{ marginBottom: 8 }}>
              <p style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Landlord Signature:</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/antonio-signature.svg" alt="Antonio Durante signature" style={{ height: 50, opacity: 0.9 }} />
            </div>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Print Name: <strong style={{ color: '#222' }}>{lease.landlord_signer}</strong></p>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Title: {lease.landlord_title}</p>
            <p style={{ fontSize: 13, color: '#666' }}>Date: {today()}</p>
          </div>

          {/* Tenant */}
          <div style={{ flex: 1 }}>
            <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, textTransform: 'uppercase', color: '#555' }}>Tenant</p>
            <p style={{ fontWeight: 700, marginBottom: 12 }}>{lease.tenant_company}</p>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Print Name: <strong style={{ color: '#222' }}>{lease.tenant_contact_name}</strong></p>
            <p style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>Title: Owner/Member</p>
            <p style={{ fontSize: 13, color: '#666' }}>Date: {today()}</p>

            {/* Signature canvas */}
            {!signed && (
              <div style={{ marginTop: 16 }}>
                <p style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Tenant Signature:</p>
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
        </div>

        {/* Signed confirmation */}
        {signed && (
          <div style={{ background: '#f0f7f0', border: '1px solid #b8d4b8', borderRadius: 6, padding: 20, textAlign: 'center', marginTop: 24 }}>
            <p style={{ color: '#2d6a2d', fontWeight: 700, fontSize: 16, margin: 0 }}>Lease Agreement Signed Successfully</p>
            <p style={{ color: '#4a8a4a', fontSize: 14, marginTop: 8 }}>
              A copy has been saved. Tony Durante LLC will be in touch shortly.
            </p>
          </div>
        )}
      </div>

      {/* Action bar — outside the PDF capture area for easy hiding */}
      {!signed && (
        <div id="lease-action-bar" style={{ maxWidth: 800, margin: '24px auto', textAlign: 'center' }}>
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
            {signing ? 'Generating PDF...' : 'Sign Lease Agreement'}
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
