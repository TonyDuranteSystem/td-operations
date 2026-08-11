'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { supabasePublic } from '@/lib/supabase/public-client'
import { SigningFailure, isClientFacingError, signingLang, storageWriteFailed } from '@/lib/public-forms/signing-failures'
import type { Offer } from '@/lib/types/offer'
import { ensureBankDetails, type BankDetails } from './bank-defaults'
import { internalWebhookHeaders } from '@/lib/internal-webhook-client'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

function today() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

function esc(v: string) {
  const d = document.createElement('div')
  d.textContent = v
  return d.innerHTML
}


interface RenewalAgreementProps {
  offer: Offer
  token: string
}

export default function RenewalAgreement({ offer, token }: RenewalAgreementProps) {
  const [signing, setSigning] = useState(false)
  // Blocking on a failed write makes RETRY a real path. The PDF-capture step
  // DESTRUCTIVELY rewrites the DOM (inputs -> spans, canvases -> imgs), so a
  // second attempt found `canvas.parentElement` null and threw a raw TypeError
  // onto a legal-signing screen. Freeze once; a retry reuses the frozen DOM.
  const frozenForPdfRef = useRef(false)
  const [signed, setSigned] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Enter your name, email, and sign below.')
  const [statusType, setStatusType] = useState<'info' | 'error' | 'success'>('info')
  const [ready, setReady] = useState(false)
  const [name, setName] = useState(offer.client_name || '')
  const [email, setEmail] = useState(offer.client_email || '')
  const [paymentState, setPaymentState] = useState<{
    invoiceNumber: string
    bankDetails: BankDetails
    stripeUrl: string | null
    stripeLabel: string | null
  } | null>(null)
  const nameRef = useRef(name)
  const emailRef = useRef(email)
  useEffect(() => { nameRef.current = name }, [name])
  useEffect(() => { emailRef.current = email }, [email])

  const sigRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<any>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pdfBlobRef = useRef<Blob | null>(null)

  // Extract installment data from cost_summary
  // Use installment_currency to format amounts correctly (fallback to raw strings for pre-fix offers)
  const instCurrency = offer.installment_currency || offer.currency
  const instSymbol = instCurrency === 'USD' ? '$' : instCurrency === 'EUR' ? '€' : null
  const formatAmt = (raw: string) => instSymbol ? `${instSymbol}${raw.replace(/[^0-9.,]/g, '')}` : raw

  const costSummary = (offer.cost_summary || []) as Array<{ label?: string; total?: string; total_label?: string; items?: Array<{ name: string; price: string }> }>
  const firstSection = costSummary[0]
  const items = firstSection?.items || []
  const inst1 = items[0] ? { name: items[0].name, price: formatAmt(items[0].price) } : null
  const inst2 = items[1] ? { name: items[1].name, price: formatAmt(items[1].price) } : null
  const rawTotal = firstSection?.total || firstSection?.total_label || ''
  const totalLabel = rawTotal ? formatAmt(rawTotal) : ''

  // Extract company name from services or offer
  const companyName = (offer.services as Array<{ name?: string }> | undefined)?.[0]?.name || offer.client_name || '[Company Name]'

  // Contract year — derive from effective_date or current year
  // Use string split to avoid timezone issues (new Date('2026-01-01') in EST = Dec 31 2025)
  const contractYear = offer.effective_date
    ? parseInt(offer.effective_date.split('-')[0], 10)
    : new Date().getFullYear()

  // Init signature pad
  useEffect(() => {
    const timer = setTimeout(async () => {
      const SignaturePad = (await import('signature_pad')).default
      const canvas = sigRef.current
      if (!canvas) return
      const ratio = Math.max(window.devicePixelRatio || 1, 1)
      canvas.width = canvas.offsetWidth * ratio
      canvas.height = canvas.offsetHeight * ratio
      canvas.getContext('2d')!.scale(ratio, ratio)
      const pad = new SignaturePad(canvas, { backgroundColor: 'rgba(255,255,255,0)', penColor: '#1a1a2e', minWidth: 1, maxWidth: 2.5 })
      pad.addEventListener('endStroke', () => checkReady())
      sigPadRef.current = pad
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const checkReady = useCallback(() => {
    const hasSig = sigPadRef.current && !sigPadRef.current.isEmpty()
    const ok = !!nameRef.current && !!emailRef.current && hasSig
    setReady(ok)
    if (!ok) {
      const m: string[] = []
      if (!nameRef.current) m.push('name')
      if (!emailRef.current) m.push('email')
      if (!hasSig) m.push('signature')
      setStatusMsg('Missing: ' + m.join(', '))
      setStatusType('info')
    } else {
      setStatusMsg('Ready to sign. Click the button below.')
      setStatusType('info')
    }
  }, [])

  useEffect(() => { checkReady() }, [name, email, checkReady])

  function clearSig() {
    if (sigPadRef.current) sigPadRef.current.clear()
    checkReady()
  }

  async function signAgreement() {
    if (signing) return
    setSigning(true)
    setStatusMsg('Generating PDF...')
    setStatusType('info')

    try {
      const html2pdf = (await import('html2pdf.js')).default

      if (!frozenForPdfRef.current) {
        frozenForPdfRef.current = true
      // Freeze form fields
      const formEl = document.getElementById('renewal-client-form')
      if (formEl) {
        formEl.querySelectorAll('input').forEach(inp => {
          const td = inp.parentElement!
          td.innerHTML = `<span style="font-weight:500">${esc(inp.value)}</span>`
        })
      }

      // Replace canvas with image
      const canvas = sigRef.current
      if (canvas && sigPadRef.current) {
        const wrap = canvas.parentElement!
        const dataUrl = sigPadRef.current.toDataURL('image/png')
        wrap.innerHTML = `<img src="${dataUrl}" style="height:120px;display:block">`
      }

      }

      // Generate PDF
      const opt = {
        margin: [0.5, 0.6, 0.7, 0.6] as [number, number, number, number],
        filename: `Tony_Durante_Annual_Agreement_${contractYear}_${token}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfBlob = await (html2pdf() as any).set(opt).from(bodyRef.current).outputPdf('blob')
      pdfBlobRef.current = pdfBlob

      // Upload PDF
      setStatusMsg('Uploading signed agreement...')
      const pdfPath = `${token}/annual-agreement-signed-${Date.now()}.pdf`
      const pdfRes = await fetch(`${SB_URL}/storage/v1/object/signed-contracts/${pdfPath}`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': 'application/pdf' },
        body: pdfBlob
      })
      if (storageWriteFailed(pdfRes)) {
        console.error('[renewal-agreement] signed PDF upload failed:', pdfRes?.status, await pdfRes.text().catch(() => ''))
        throw new SigningFailure('document_upload', signingLang(offer.language))
      }

      // Save contract record
      const { error: contractErr } = await supabasePublic.from('contracts').insert({
        offer_token: token,
        client_name: name,
        client_email: email,
        signed_at: new Date().toISOString(),
        pdf_path: pdfPath,
        status: 'signed',
      })
      if (contractErr) {
        console.error('[renewal-agreement] contract row insert failed:', contractErr.message)
        throw new SigningFailure('record', signingLang(offer.language))
      }

      // Update annual agreement status
      let statusUpdated = false
      let lastStatusErr: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { error: pErr } = await supabasePublic
            .from('annual_agreements')
            .update({ status: 'signed', signed_at: new Date().toISOString() })
            .eq('token', token)
          if (!pErr) { statusUpdated = true; break }
          lastStatusErr = pErr.message
        } catch (e) { lastStatusErr = e instanceof Error ? e.message : String(e) }
      }
      if (!statusUpdated) {
        console.error('[renewal-agreement] status update failed after 3 attempts:', lastStatusErr)
        throw new SigningFailure('status', signingLang(offer.language))
      }

      // Notify webhook — read response to get invoice number
      setStatusMsg('Processing...')
      let invoiceNumber = ''
      try {
        const webhookRes = await fetch('/api/webhooks/agreement-signed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...internalWebhookHeaders() },
          body: JSON.stringify({ agreement_token: token })
        })
        if (webhookRes.ok) {
          const wData = await webhookRes.json()
          invoiceNumber = wData.invoice_number || ''
        }
      } catch (e) {
        console.warn('[renewal-agreement] Failed to notify offer-signed webhook:', e)
      }

      // Build bank details — renewals are USD → Relay
      const bankDetails = ensureBankDetails(undefined, offer.cost_summary as unknown[])
      const amountStr = (offer.cost_summary as Array<{ total?: string }>)?.[0]?.total || ''
      if (amountStr) bankDetails.amount = amountStr
      if (invoiceNumber) bankDetails.reference = `${invoiceNumber} - ${name}`

      // Try Stripe checkout
      let stripeUrl: string | null = null
      let stripeLabel: string | null = null
      try {
        const checkoutRes = await fetch('/api/offers/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        })
        if (checkoutRes.ok) {
          const cd = await checkoutRes.json()
          stripeUrl = cd.checkoutUrl || null
          stripeLabel = cd.label || null
        }
      } catch (e) {
        console.warn('[renewal-agreement] Stripe checkout unavailable:', e)
      }

      // Send postMessage for portal iframe embedding
      if (typeof window !== 'undefined' && window.parent !== window) {
        window.parent.postMessage({ type: 'contract-signed', token }, '*')
      }

      setSigned(true)
      setPaymentState({ invoiceNumber, bankDetails, stripeUrl, stripeLabel })

    } catch (e: any) {
      setSigning(false)
      setStatusMsg(isClientFacingError(e) ? e.message : 'Error: ' + e.message + '. Please try again.')
      setStatusType('error')
    }
  }

  return (
    <>
      <div id="renewal-contract-body" ref={bodyRef} style={signed ? { display: 'none' } : undefined}>
        {/* HEADER */}
        <div className="contract-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo.jpg" alt="Tony Durante LLC" />
          <h1>Annual Service Agreement</h1>
          <div className="contract-subtitle">{contractYear}</div>
        </div>

        {/* PARTIES */}
        <p>This Annual Service Agreement (&ldquo;<strong>Agreement</strong>&rdquo;) is entered into as of <strong>{today()}</strong>, by and between:</p>
        <p style={{ margin: '14px 0' }}><strong>Tony Durante LLC</strong>, a Florida limited liability company (&ldquo;<strong>Service Provider</strong>&rdquo;), and</p>
        <p style={{ margin: '14px 0' }}><strong>{companyName}</strong>, represented by <strong>{name || '[Client Name]'}</strong> (&ldquo;<strong>Client</strong>&rdquo;).</p>

        {/* SERVICE PERIOD & PAYMENT SCHEDULE */}
        <table className="contract-key-terms">
          <caption>Service Period &amp; Payment Schedule</caption>
          <tbody>
            <tr><th>Service Period</th><td>January 1, {contractYear} &mdash; December 31, {contractYear}</td></tr>
            {inst1 && <tr><th>{inst1.name}</th><td><strong>{inst1.price}</strong></td></tr>}
            {inst2 && <tr><th>{inst2.name}</th><td><strong>{inst2.price}</strong></td></tr>}
            {totalLabel && <tr><th>Total Annual Fee</th><td><strong>{totalLabel}</strong></td></tr>}
            <tr><th>Payment Method</th><td>Wire transfer or credit card (+5% surcharge)</td></tr>
          </tbody>
        </table>

        {/* FULL LEGAL SECTIONS — Same terms as formation MSA, adapted for renewal */}
        <RenewalLegalSections contractYear={contractYear} />

        {/* CLIENT INFORMATION */}
        <table className="contract-client-form" id="renewal-client-form">
          <caption style={{ fontFamily: "'Inter',sans-serif", fontWeight: 700, fontSize: '11pt', textAlign: 'left', paddingBottom: 6, color: 'var(--c-primary)' }}>Client Information</caption>
          <tbody>
            <tr>
              <th>Full Name</th>
              <td><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your full legal name" /></td>
            </tr>
            <tr>
              <th>Email Address</th>
              <td><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" /></td>
            </tr>
          </tbody>
        </table>

        {/* SIGNATURE */}
        <div className="contract-sig-section">
          <h3 style={{ textAlign: 'center' }}>Acceptance &amp; Signature</h3>
          <p className="contract-text-center contract-text-muted" style={{ marginBottom: 16, fontSize: '9.5pt' }}>
            By signing below, I confirm that I have read and agree to the terms of this Annual Service Agreement for {contractYear}. I acknowledge the payment schedule and my responsibilities as outlined above.
          </p>
          <div className="contract-sig-grid">
            <div className="contract-sig-block">
              <div className="contract-sig-label">Service Provider</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="contract-sig-static"><img src="/images/logo.jpg" alt="Tony Durante" style={{ maxHeight: 40, opacity: 0.8 }} /></div>
              <div className="contract-sig-field">Name: Antonio Noel Durante</div>
              <div className="contract-sig-field">Title: Executive Director</div>
              <div className="contract-sig-date">Date: {today()}</div>
            </div>
            <div className="contract-sig-block">
              <div className="contract-sig-label">Client</div>
              <div className="contract-sig-canvas-wrap">
                <canvas ref={sigRef} style={{ width: '100%', height: 120, display: 'block', borderRadius: 6 }} />
                <button className="contract-clear-btn" onClick={clearSig}>Clear</button>
              </div>
              <div className="contract-sig-field">Name: {name}</div>
              <div className="contract-sig-date">Date: {today()}</div>
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <div className="contract-text-center" style={{ marginTop: 36, paddingTop: 20, borderTop: '1px solid var(--c-border)' }}>
          <p className="contract-text-muted contract-text-small">Tony Durante LLC &bull; 10225 Ulmerton Road, Suite 3D &bull; Largo, FL 33771</p>
          <p className="contract-text-muted contract-text-small">support@tonydurante.us &bull; www.tonydurante.us</p>
        </div>
      </div>

      {/* ACTION BAR — hidden after signing */}
      {!signed && (
        <div className="contract-action-bar" id="renewal-action-bar">
          <button className="contract-btn contract-btn-sign" onClick={signAgreement} disabled={!ready || signing}>
            {signing ? 'Processing...' : 'Sign & Accept Agreement'}
          </button>
          <div className={`contract-status-msg ${statusType === 'error' ? 'contract-error-msg' : statusType === 'success' ? 'contract-success-msg' : ''}`}>
            {statusMsg}
          </div>
        </div>
      )}

      {/* PAYMENT PANEL — shown after signing */}
      {signed && paymentState && (
        <RenewalPaymentPanel
          invoiceNumber={paymentState.invoiceNumber}
          bankDetails={paymentState.bankDetails}
          stripeUrl={paymentState.stripeUrl}
          stripeLabel={paymentState.stripeLabel}
          token={token}
          pdfBlob={pdfBlobRef.current}
          offerToken={offer.token}
          accessCode={offer.access_code || ''}
        />
      )}
    </>
  )
}

// ─── Payment Panel shown after renewal is signed ─────────────────────────────
function RenewalPaymentPanel({
  invoiceNumber,
  bankDetails,
  stripeUrl,
  stripeLabel,
  token,
  pdfBlob,
  offerToken,
  accessCode,
}: {
  invoiceNumber: string
  bankDetails: BankDetails
  stripeUrl: string | null
  stripeLabel: string | null
  token: string
  pdfBlob: Blob | null
  offerToken: string
  accessCode: string
}) {
  const [showBank, setShowBank] = useState(false)
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [receiptUploading, setReceiptUploading] = useState(false)
  const [receiptDone, setReceiptDone] = useState(false)
  const [receiptError, setReceiptError] = useState('')

  async function uploadReceipt() {
    if (!receiptFile) return
    setReceiptUploading(true)
    setReceiptError('')
    try {
      const ext = receiptFile.name.split('.').pop() || 'pdf'
      const path = `${token}/wire-receipt-${Date.now()}.${ext}`
      const res = await fetch(`${SB_URL}/storage/v1/object/wire-receipts/${path}`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': receiptFile.type },
        body: receiptFile,
      })
      if (!res.ok) throw new Error('Upload failed')
      await supabasePublic.from('contracts').update({ wire_receipt_path: path }).eq('offer_token', offerToken)
      setReceiptDone(true)
    } catch (e: unknown) {
      setReceiptError(e instanceof Error ? e.message : 'Upload failed')
      setReceiptUploading(false)
    }
  }

  async function downloadPdf() {
    try {
      let blob = pdfBlob
      if (!blob) {
        // Server doorway: verifies the offer's access code, signs the EXACT
        // recorded contract path, returns a one-minute link. Replaces the old
        // anon list()+download(newest) so signed-contracts needs no anon read.
        const res = await fetch(`/api/offer/${encodeURIComponent(offerToken)}/contract-pdf?code=${encodeURIComponent(accessCode)}`)
        if (res.ok) {
          const { url: signedUrl } = await res.json().catch(() => ({ url: null }))
          if (signedUrl) {
            const dl = await fetch(signedUrl)
            if (dl.ok) blob = await dl.blob()
          }
        }
      }
      if (!blob) { alert('PDF not available. Please contact support.'); return }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Tony_Durante_Annual_Agreement_${token}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch { alert('Download failed. Please contact support.') }
  }

  return (
    <div className="contract-success-panel">
      <div className="contract-success-icon">&#10004;</div>
      <h2>Agreement Signed!</h2>
      <p style={{ fontSize: '12pt', marginBottom: 28 }}>
        Your annual agreement is confirmed. Choose how you&apos;d like to pay the first installment.
      </p>

      {!showBank && (
        <div id="payment-choice">
          {stripeUrl && (
            <>
              <a href={stripeUrl} className="ps-choice-btn ps-choice-card" target="_blank" rel="noopener noreferrer">
                <span className="ps-choice-icon">&#128179;</span>
                <span className="ps-choice-label">Pay by Card</span>
                <span className="ps-choice-price">{stripeLabel || ''}</span>
                <span className="ps-choice-badge">+5%</span>
              </a>
              <div className="post-sign-divider"><span>or</span></div>
            </>
          )}
          <button className="ps-choice-btn ps-choice-bank" type="button" onClick={() => setShowBank(true)}>
            <span className="ps-choice-icon">&#127974;</span>
            <span className="ps-choice-label">Pay by Wire Transfer</span>
            <span className="ps-choice-price">{bankDetails.amount || ''}</span>
          </button>
        </div>
      )}

      {showBank && (
        <div className="post-sign-option">
          <div className="post-sign-option-label">&#127974; Pay by Wire Transfer</div>
          {bankDetails.amount && <div className="post-sign-bank-amount">{bankDetails.amount}</div>}
          <div className="contract-bank-details-box">
            <h3>Bank Transfer Details</h3>
            {bankDetails.beneficiary && <div className="contract-bank-row"><span className="contract-bank-label">Beneficiary</span><span className="contract-bank-value">{bankDetails.beneficiary}</span></div>}
            {bankDetails.account_number && <div className="contract-bank-row"><span className="contract-bank-label">Account Number</span><span className="contract-bank-value">{bankDetails.account_number}</span></div>}
            {bankDetails.routing_number && <div className="contract-bank-row"><span className="contract-bank-label">Routing Number</span><span className="contract-bank-value">{bankDetails.routing_number}</span></div>}
            {bankDetails.iban && <div className="contract-bank-row"><span className="contract-bank-label">IBAN</span><span className="contract-bank-value">{bankDetails.iban}</span></div>}
            {bankDetails.bic && <div className="contract-bank-row"><span className="contract-bank-label">BIC/SWIFT</span><span className="contract-bank-value">{bankDetails.bic}</span></div>}
            {bankDetails.bank_name && <div className="contract-bank-row"><span className="contract-bank-label">Bank</span><span className="contract-bank-value">{bankDetails.bank_name}</span></div>}
            {bankDetails.reference && <div className="contract-bank-ref">Reference: {bankDetails.reference}</div>}
          </div>

          <div className="contract-receipt-upload">
            <h3 style={{ fontSize: '11pt', marginBottom: 8 }}>Upload Wire Receipt</h3>
            <p style={{ fontSize: '9.5pt', color: 'var(--c-muted)', marginBottom: 12 }}>
              Upload your wire transfer receipt so we can confirm your payment.
            </p>
            {!receiptDone ? (
              <>
                <div
                  className="contract-receipt-drop"
                  onClick={() => document.getElementById('renewal-receipt-input')?.click()}
                >
                  <input
                    id="renewal-receipt-input"
                    type="file"
                    accept="image/*,.pdf"
                    style={{ display: 'none' }}
                    onChange={e => setReceiptFile(e.target.files?.[0] || null)}
                  />
                  <p style={{ color: receiptFile ? 'var(--c-green)' : undefined }}>
                    {receiptFile ? receiptFile.name : 'Click to upload receipt (image or PDF)'}
                  </p>
                </div>
                <button
                  className="contract-receipt-btn"
                  disabled={!receiptFile || receiptUploading}
                  onClick={uploadReceipt}
                >
                  {receiptUploading ? 'Uploading...' : 'Submit Receipt'}
                </button>
                {receiptError && (
                  <div style={{ fontSize: '9pt', color: 'var(--c-red)', marginTop: 8 }}>{receiptError}</div>
                )}
              </>
            ) : (
              <div style={{ fontSize: '9pt', color: 'var(--c-green)', fontWeight: 600, marginTop: 8 }}>
                Receipt uploaded! We&apos;ll confirm your payment shortly.
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #d4e8d4' }}>
        <button
          style={{ padding: '10px 32px', fontSize: 14, fontWeight: 600, background: '#0A3161', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'Georgia,serif' }}
          onClick={downloadPdf}
        >
          Download Signed PDF
        </button>
      </div>
      <p style={{ fontSize: '9.5pt', color: 'var(--c-muted)', marginTop: 24 }}>
        After payment is confirmed, your services will be activated for {invoiceNumber ? `invoice ${invoiceNumber}` : 'this year'}.
      </p>
    </div>
  )
}

// ─── Full Legal Terms (adapted from formation MSA sections 1-24) ───────────
function RenewalLegalSections({ contractYear }: { contractYear: number }) {
  return (
    <div id="renewal-legal-sections">
      <div className="contract-section"><h3>1. Purpose &amp; Structure</h3>
        <p>The Service Provider provides professional consulting services related to the management and ongoing compliance of U.S. Limited Liability Companies (&ldquo;LLCs&rdquo;) for international entrepreneurs and foreign nationals.</p>
        <p>This Agreement governs the general terms and conditions of the annual service relationship between the Parties for the {contractYear} Contract Year. It replaces and supersedes any prior annual service agreement for the same period.</p></div>

      <div className="contract-section"><h3>2. Scope of Services</h3>
        <p>The Service Provider shall provide the following annual management services during the Contract Year:</p>

        <div className="contract-subsection"><h4>2.1 Client Portal</h4>
        <p>The Client receives access to a <strong>Dedicated Client Portal</strong> (<strong>portal.tonydurante.us</strong>), a secure online platform available 24/7 that serves as the central hub for managing the Client&apos;s LLC. The Portal includes:</p>
        <p><strong>Business Tools for the Client&apos;s operations:</strong></p>
        <ul>
          <li><strong>Invoicing System</strong> &mdash; Create, send, and track professional invoices to the Client&apos;s own customers. Manage invoice status (draft, sent, paid, overdue), view total invoiced and collected amounts, and customize invoices with the company logo;</li>
          <li><strong>Customer Management</strong> &mdash; Build and manage a customer database. Add customer details (name, email, company), view invoice history per customer, and maintain a centralized contact list for the Client&apos;s business;</li>
          <li><strong>Company Profile &amp; Branding</strong> &mdash; Upload a company logo for use on invoices, manage bank account details and payment gateway links for receiving payments from customers.</li>
        </ul>
        <p><strong>LLC Management &amp; Compliance:</strong></p>
        <ul>
          <li><strong>Electronic Document Signing</strong> &mdash; Sign contracts digitally (Annual Agreement, Operating Agreement, Office Lease, EIN Application) with legally binding electronic signatures;</li>
          <li><strong>Document Archive</strong> &mdash; View and download all company documents (Articles of Organization, EIN Letter, Passport copy, Tax Returns, signed contracts) from a secure, organized repository;</li>
          <li><strong>Service Tracking</strong> &mdash; Monitor the status and progress of all active services (Tax Return, Registered Agent renewal, Annual Report filing) with real-time updates and stage indicators;</li>
          <li><strong>Compliance Deadlines</strong> &mdash; Visual calendar showing all upcoming compliance deadlines (annual reports, tax filings, RA renewals) with color-coded alerts;</li>
          <li><strong>Billing &amp; Payments</strong> &mdash; View invoices from Tony Durante LLC, track payment history, and monitor outstanding balances;</li>
          <li><strong>Direct Messaging</strong> &mdash; Communicate with the Tony Durante team in real-time through integrated chat, with full conversation history;</li>
          <li><strong>Tax Document Upload</strong> &mdash; Upload financial records and tax documents directly through the portal for tax return preparation;</li>
          <li><strong>Activity Feed</strong> &mdash; Timeline of all account activity including document uploads, service updates, notifications, and communications;</li>
          <li><strong>Multi-Company Dashboard</strong> &mdash; Clients managing multiple LLCs can switch between companies from a single login;</li>
          <li><strong>Service Guide &amp; Requests</strong> &mdash; Browse available services, read guides, and request additional services directly from the portal.</li>
        </ul></div>

        <div className="contract-subsection"><h4>2.2 LLC Compliance &amp; Administration</h4>
        <ul>
          <li><strong>Registered Agent</strong> &mdash; Official representation in the state of formation, maintaining a registered office address for service of process and state correspondence;</li>
          <li><strong>State Annual Report &amp; Compliance</strong> &mdash; Preparation and filing of all required state annual reports, monitoring of compliance deadlines, and proactive notification of upcoming obligations;</li>
          <li><strong>U.S. Business Address &amp; Mail Handling (CMRA)</strong> &mdash; A U.S. commercial mail receiving address for the LLC, with mail scanning, digital delivery, and physical forwarding services;</li>
          <li><strong>Federal Tax Return</strong> &mdash; Preparation and filing of the LLC&apos;s annual U.S. federal tax return (Form 5472/1120 for SMLLCs, Form 1065 for MMLLCs) through a qualified third-party tax professional;</li>
          <li><strong>EIN Maintenance</strong> &mdash; Ongoing management of the Employer Identification Number, including IRS correspondence handling and address updates;</li>
          <li><strong>Document Management</strong> &mdash; Secure cloud storage and organization of all company documents, accessible through the Client Portal at any time;</li>
          <li><strong>Ongoing Administrative Support</strong> &mdash; Dedicated assistance for any questions, requests, or issues related to the Client&apos;s LLC operations.</li>
        </ul></div>

        <p>Any services not explicitly listed above are outside the scope of this Agreement and may be subject to additional fees.</p></div>

      <div className="contract-section"><h3>3. Client Responsibilities</h3>
        <p>The Client agrees to:</p>
        <ol type="a"><li>Provide accurate, complete, and truthful information as required for compliance filings and tax preparation;</li><li>Respond to requests for information or documentation within five (5) business days;</li><li>Comply with all applicable U.S. federal, state, and local laws, as well as any laws of the Client&apos;s country of residence;</li><li>Maintain valid identification documents (passport) throughout the duration of this Agreement;</li><li>Notify the Service Provider promptly of any material changes in personal information, contact details, or business structure;</li><li>Not use the LLC or any services provided for illegal, fraudulent, or unethical purposes.</li></ol>
        <p>Failure to meet these responsibilities may result in delays, additional fees, or termination of this Agreement.</p></div>

      <div className="contract-section"><h3>4. Communication &amp; Business Hours</h3>
        <div className="contract-subsection"><h4>4.1 Business Hours</h4><p>The Service Provider operates <strong>Monday through Friday, 8:00 AM to 3:00 PM Eastern Time (ET)</strong>, excluding U.S. federal holidays. Communications received outside of Business Hours will be addressed on the next business day.</p></div>
        <div className="contract-subsection"><h4>4.2 Client Portal</h4><p>The Client Portal (<strong>portal.tonydurante.us</strong>) is the Client&apos;s primary hub for managing their LLC. Through the portal, the Client can:</p>
          <ul>
            <li>Sign documents electronically (Annual Agreement, Operating Agreement, Lease, SS-4);</li>
            <li>View and download all company documents (Articles, EIN Letter, Passport, Tax Returns);</li>
            <li>Track the status and progress of all active services;</li>
            <li>View invoices and payment history;</li>
            <li>Communicate with the team via integrated messaging;</li>
            <li>Update account settings and preferences.</li>
          </ul>
          <p>The Client receives login credentials via email. Access is secured with email-based authentication and password protection.</p></div>
        <div className="contract-subsection"><h4>4.3 Communication Channels</h4><p>Official communications shall be conducted via:</p><ul><li><strong>Client Portal:</strong> Primary channel for document signing, service tracking, and account management</li><li><strong>Email:</strong> For business correspondence and formal notifications</li><li><strong>WhatsApp / Telegram:</strong> For quick operational questions and updates</li></ul><p>The Service Provider shall use reasonable efforts to respond within <strong>two (2) business days</strong>.</p></div>
        <div className="contract-subsection"><h4>4.4 Scheduled Calls</h4><p>Scheduled video or phone calls are available <strong>only when strictly necessary</strong>. A fee of <strong>$197.00 per call</strong> may apply for non-essential calls.</p></div></div>

      <div className="contract-section"><h3>5. Fees &amp; Payment</h3>
        <div className="contract-subsection"><h4>5.1 Annual Service Fee</h4><p>The Client shall pay the Annual Service Fee as specified in the Service Period &amp; Payment Schedule above.</p></div>
        <div className="contract-subsection"><h4>5.2 Payment Methods</h4><p>Payments may be made via:</p><ul><li><strong>Credit or debit card</strong> through the secure online checkout system (+5% surcharge);</li><li><strong>Bank wire transfer</strong> to the designated bank account (no surcharge).</li></ul></div>
        <div className="contract-subsection"><h4>5.3 Payment Schedule</h4><p>The annual fee is payable in two installments as specified in the Payment Schedule above. Invoices are issued at the beginning of each installment period.</p></div>
        <div className="contract-subsection"><h4>5.4 Late Payment</h4><p>A late fee of <strong>1.5% per month</strong> shall accrue on unpaid balances. Services may be <strong>suspended after thirty (30) days</strong> past due.</p></div>
        <div className="contract-subsection"><h4>5.5 Refund Policy</h4><p><strong>All fees paid under this Agreement are non-refundable.</strong></p></div>
        <div className="contract-subsection"><h4>5.6 Additional Fees</h4><p>Services not included in this Agreement may incur additional charges with advance notification.</p></div></div>

      <div className="contract-section"><h3>6. Third-Party Providers</h3><p>The Service Provider may engage third-party service providers (including but not limited to registered agent companies, tax preparers, and mail service providers). The Service Provider shall not be liable for the acts, omissions, or failures of any third-party provider.</p></div>

      <div className="contract-section"><h3>7. Mail Handling &amp; Forwarding</h3><p>The Service Provider shall receive, scan, and forward mail addressed to the Client&apos;s LLC at the U.S. registered business address within two (2) business days. Physical mail forwarding is subject to shipping costs at the Client&apos;s expense.</p></div>

      <div className="contract-section"><h3>8. Confidentiality</h3><p>Each Party agrees to maintain confidentiality of all proprietary, financial, and personal information disclosed during the course of this Agreement. This obligation survives termination for three (3) years.</p></div>

      <div className="contract-section"><h3>9. Data Protection &amp; Privacy</h3>
        <div className="contract-subsection"><h4>9.1 Data Processing</h4><p>Personal data shall be processed solely for the purpose of performing the Services under this Agreement. The Service Provider collects and processes only the data necessary for LLC management, compliance, and communication. For EU/EEA residents, processing is based on Article 6(1)(b) GDPR (performance of a contract).</p></div>
        <div className="contract-subsection"><h4>9.2 Privacy Policy</h4><p>The Service Provider&apos;s complete Privacy Policy is available at <strong>www.iubenda.com/privacy-policy/51522422</strong>. This policy describes in detail what data is collected, how it is used, stored, and protected, and the Client&apos;s rights regarding their personal data. By signing this Agreement, the Client acknowledges having read and accepted the Privacy Policy.</p></div>
        <div className="contract-subsection"><h4>9.3 Cookie Policy</h4><p>The Service Provider&apos;s Cookie Policy is available at <strong>www.iubenda.com/privacy-policy/51522422/cookie-policy</strong>. The Client Portal uses cookies strictly necessary for authentication and session management.</p></div>
        <div className="contract-subsection"><h4>9.4 Data Security</h4><p>The Service Provider implements industry-standard security measures including encrypted data transmission (TLS/SSL), secure authentication, role-based access control, and encrypted storage for sensitive documents. The Client Portal uses Supabase Auth for secure user management with email-based authentication.</p></div>
        <div className="contract-subsection"><h4>9.5 Data Retention</h4><p>Client data is retained for the duration of the business relationship and for a period of seven (7) years thereafter, as required by U.S. tax regulations. Upon termination, the Client may request a copy of all their data before it is archived.</p></div></div>

      <div className="contract-section"><h3>10. Tax Return Preparation</h3><p>The Service Provider shall arrange for preparation and filing of the LLC&apos;s annual U.S. tax return through a qualified third-party professional. The Client is solely responsible for providing accurate financial records and information necessary for the tax return. The Service Provider does not provide tax advice.</p></div>

      <div className="contract-section"><h3>11. Contract Year &amp; Renewal</h3><p>The Contract Year runs <strong>January 1 through December 31</strong>. This Agreement shall <strong>automatically renew</strong> each year under the same terms unless:</p>
        <ul><li>Either Party provides written notice of non-renewal by <strong>November 1</strong> of the current Contract Year;</li><li>The Service Provider issues a new Annual Service Agreement with updated terms.</li></ul>
        <p>If the Service Provider issues a new Annual Service Agreement, the Client must sign it to continue receiving services for the new Contract Year.</p></div>

      <div className="contract-section"><h3>12. Termination</h3>
        <div className="contract-subsection"><h4>12.1 By Client</h4><p>Written notice, effective thirty (30) days after receipt. No refund of fees already paid.</p></div>
        <div className="contract-subsection"><h4>12.2 By Service Provider</h4><p>Immediate termination for material breach, non-payment (30+ days), illegal conduct, or violation of Section 13.</p></div>
        <div className="contract-subsection"><h4>12.3 Effect of Termination</h4><p>Client remains liable for accrued fees. Sections 5.5, 8, 9, 15, 16, 17, and 20 survive termination.</p></div></div>

      <div className="contract-section"><h3>13. Client Conduct</h3><p>The Client shall conduct all interactions professionally and respectfully. Immediate termination without refund may result from abusive behavior, unreasonable demands, provision of false information, or illegal use of services.</p></div>

      <div className="contract-section"><h3>14. Intellectual Property</h3><p>All templates, processes, systems, and methodologies used by the Service Provider remain the exclusive intellectual property of Tony Durante LLC.</p></div>

      <div className="contract-section"><h3>15. Limitation of Liability</h3><p style={{ textTransform: 'uppercase', fontSize: '9.5pt' }}>Total liability shall not exceed fees paid in the preceding twelve (12) months. In no event shall the Service Provider be liable for indirect, incidental, special, consequential, or punitive damages.</p></div>

      <div className="contract-section"><h3>16. Force Majeure</h3><p>Neither Party shall be liable for delays or failures in performance resulting from causes beyond their reasonable control, including acts of God, pandemics, government actions, natural disasters, or systemic failures.</p></div>

      <div className="contract-section"><h3>17. Indemnification</h3><p>The Client shall indemnify and hold harmless the Service Provider against any claims, damages, or expenses arising from the Client&apos;s breach of this Agreement, violation of applicable laws, provision of inaccurate information, illegal use of services, or third-party claims related to the Client&apos;s business activities.</p></div>

      <div className="contract-section"><h3>18. Assignment</h3><p>The Client may not assign this Agreement without written consent. The Service Provider may assign to successors or affiliates.</p></div>

      <div className="contract-section"><h3>19. Independent Contractor</h3><p>The Service Provider is an independent contractor. Nothing in this Agreement creates an employment, partnership, joint venture, or agency relationship between the Parties.</p></div>

      <div className="contract-section"><h3>20. Governing Law &amp; Dispute Resolution</h3>
        <div className="contract-subsection"><h4>20.1</h4><p>This Agreement is governed by the laws of the <strong>State of Florida</strong>.</p></div>
        <div className="contract-subsection"><h4>20.2</h4><p>Disputes shall be resolved by: (a) good-faith mediation in <strong>Pinellas County, FL</strong>, then (b) binding arbitration under <strong>AAA Commercial Arbitration Rules</strong>. The prevailing party shall be entitled to recover reasonable attorneys&apos; fees and costs.</p></div></div>

      <div className="contract-section"><h3>21. Electronic Signatures</h3><p>Electronic signatures on this Agreement are valid and binding under the <strong>ESIGN Act</strong> (15 U.S.C. &sect; 7001) and <strong>UETA</strong> (Fla. Stat. &sect; 668.50).</p></div>

      <div className="contract-section"><h3>22. Entire Agreement</h3><p>This Agreement, together with the Service Provider&apos;s Privacy Policy (<strong>www.iubenda.com/privacy-policy/51522422</strong>) and Terms and Conditions (<strong>www.iubenda.com/terms-and-conditions/51522422</strong>), constitutes the entire agreement between the Parties with respect to the {contractYear} Contract Year and supersedes all prior negotiations, understandings, and agreements. No amendment or modification shall be effective unless in writing and signed by both Parties.</p></div>

      <div className="contract-section"><h3>23. Notices</h3><p>Formal notices shall be sent via email (with delivery confirmation) or certified mail. <strong>WhatsApp and Telegram messages do not constitute formal notice.</strong></p>
        <table className="contract-key-terms" style={{ marginTop: 12 }}>
          <tbody>
            <tr><th>Service Provider</th><td>Tony Durante LLC<br />10225 Ulmerton Road, Suite 3D<br />Largo, FL 33771<br />Email: support@tonydurante.us</td></tr>
          </tbody>
        </table>
      </div>

      <div className="contract-section"><h3>24. Severability</h3><p>If any provision of this Agreement is found to be invalid or unenforceable, it shall be modified to the minimum extent necessary or severed; the remaining provisions shall continue in full force and effect.</p></div>
    </div>
  )
}
