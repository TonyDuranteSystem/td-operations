'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { supabasePublic } from '@/lib/supabase/public-client'
import type { Offer } from '@/lib/types/offer'

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

interface TaxReturnContractProps {
  offer: Offer
  token: string
}

export default function TaxReturnContract({ offer, token }: TaxReturnContractProps) {
  const [signing, setSigning] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Enter your name, email, and sign below.')
  const [statusType, setStatusType] = useState<'info' | 'error' | 'success'>('info')
  const [ready, setReady] = useState(false)
  const [name, setName] = useState(offer.client_name || '')
  const [email, setEmail] = useState(offer.client_email || '')
  const nameRef = useRef(name)
  const emailRef = useRef(email)
  useEffect(() => { nameRef.current = name }, [name])
  useEffect(() => { emailRef.current = email }, [email])

  const sigRef = useRef<HTMLCanvasElement>(null)
  const sigPadRef = useRef<any>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Extract service info from offer
  const service = offer.services?.[0]
  const serviceName = service?.name || 'Tax Return'
  const serviceDesc = service?.description || ''
  const fee = service?.price || ''
  const includes = service?.includes || []

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

      // Freeze form fields
      const formEl = document.getElementById('tax-client-form')
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

      // Hide action bar
      const actionBar = document.getElementById('tax-action-bar')
      if (actionBar) actionBar.style.display = 'none'
      document.querySelectorAll('.contract-clear-btn').forEach(b => (b as HTMLElement).style.display = 'none')

      // Generate PDF
      const opt = {
        margin: [0.5, 0.6, 0.7, 0.6] as [number, number, number, number],
        filename: `Tony_Durante_Tax_Agreement_${token}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfBlob = await (html2pdf() as any).set(opt).from(bodyRef.current).outputPdf('blob')

      // Upload PDF
      setStatusMsg('Uploading signed agreement...')
      const pdfPath = `${token}/tax-agreement-signed-${Date.now()}.pdf`
      await fetch(`${SB_URL}/storage/v1/object/signed-contracts/${pdfPath}`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': 'application/pdf' },
        body: pdfBlob
      })

      // Save contract record
      await supabasePublic.from('contracts').insert({
        offer_token: token,
        client_name: name,
        client_email: email,
        signed_at: new Date().toISOString(),
        pdf_path: pdfPath,
        status: 'signed',
      })

      // Update offer status
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { error: pErr } = await supabasePublic.from('offers').update({ status: 'signed' }).eq('token', token)
          if (!pErr) break
        } catch { /* retry */ }
      }

      // Notify webhook
      try {
        await fetch('/api/webhooks/offer-signed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offer_token: token })
        })
      } catch (e) {
        console.warn('[tax-agreement] Failed to notify offer-signed webhook:', e)
      }

      // Show payment options
      const hasCard = offer.payment_links && offer.payment_links.length > 0
      const hasBank = !!offer.bank_details
      const successEl = document.getElementById('tax-success-state')

      if ((hasCard || hasBank) && successEl && bodyRef.current) {
        bodyRef.current.style.display = 'none'
        let sh = '<div class="contract-success-panel"><div class="contract-success-icon">&#10004;</div>'
        sh += '<h2 style="color:var(--c-green);font-size:18pt;margin-bottom:8px">Agreement Signed!</h2>'
        sh += '<p style="font-size:12pt;margin-bottom:28px;color:var(--c-muted)">Choose how you want to pay:</p>'

        sh += '<div id="payment-choice">'
        if (hasCard) {
          const pl = offer.payment_links![0]
          sh += `<a href="${esc(pl.url)}" class="ps-choice-btn ps-choice-card" target="_blank" rel="noopener noreferrer">`
          sh += '<span class="ps-choice-icon">&#128179;</span>'
          sh += '<span class="ps-choice-label">Pay by Card</span>'
          sh += `<span class="ps-choice-price">${esc(pl.amount)}</span>`
          if (hasBank) sh += '<span class="ps-choice-badge">+5%</span>'
          sh += '</a>'
        }
        if (hasCard && hasBank) {
          sh += '<div class="post-sign-divider"><span>OR</span></div>'
        }
        if (hasBank) {
          sh += '<button id="choose-bank" class="ps-choice-btn ps-choice-bank" type="button">'
          sh += '<span class="ps-choice-icon">&#127974;</span>'
          sh += '<span class="ps-choice-label">Bank Transfer</span>'
          sh += `<span class="ps-choice-price">${esc(offer.bank_details!.amount || '')}</span>`
          sh += '</button>'
        }
        sh += '</div>'

        if (hasBank) {
          const b = offer.bank_details!
          sh += '<div id="bank-panel" style="display:none;">'
          sh += '<div class="post-sign-option">'
          sh += '<div class="post-sign-option-label">&#127974; Bank Transfer</div>'
          if (b.amount) sh += `<div class="post-sign-bank-amount">${esc(b.amount)}</div>`
          sh += '<div class="contract-bank-details-box"><h3>Bank Transfer Details</h3>'
          if (b.beneficiary) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Beneficiary</span><span class="contract-bank-value">${esc(b.beneficiary)}</span></div>`
          if (b.account_number) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Account Number</span><span class="contract-bank-value">${esc(b.account_number)}</span></div>`
          if (b.routing_number) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Routing Number</span><span class="contract-bank-value">${esc(b.routing_number)}</span></div>`
          if (b.iban) sh += `<div class="contract-bank-row"><span class="contract-bank-label">IBAN</span><span class="contract-bank-value">${esc(b.iban)}</span></div>`
          if (b.bic) sh += `<div class="contract-bank-row"><span class="contract-bank-label">BIC / SWIFT</span><span class="contract-bank-value">${esc(b.bic)}</span></div>`
          if (b.bank_name) sh += `<div class="contract-bank-row"><span class="contract-bank-label">Bank</span><span class="contract-bank-value">${esc(b.bank_name)}</span></div>`
          if (b.reference) sh += `<div class="contract-bank-ref">Reference: ${esc(b.reference)}</div>`
          sh += '</div>'
          sh += '<div class="contract-receipt-upload">'
          sh += '<h3 style="font-size:11pt;margin-bottom:8px;">Upload Wire Transfer Receipt</h3>'
          sh += '<p style="font-size:9.5pt;color:var(--c-muted);margin-bottom:12px;">Once you complete the transfer, upload the receipt to start your services immediately.</p>'
          sh += '<div class="contract-receipt-drop" id="receipt-drop" onclick="document.getElementById(\'receipt-input\').click()">'
          sh += '<input type="file" id="receipt-input" accept="image/*,.pdf" style="display:none" />'
          sh += '<p id="receipt-label">Click to upload receipt (PDF or image)</p>'
          sh += '</div>'
          sh += '<button id="receipt-submit" class="contract-receipt-btn" disabled>Upload Receipt</button>'
          sh += '<div id="receipt-status" style="font-size:9pt;margin-top:8px;"></div>'
          sh += '</div></div></div>'
        }

        sh += '<p style="font-size:9.5pt;color:var(--c-muted);margin-top:24px;">Once payment is received, we will begin working on your tax return immediately.</p>'
        sh += `<a href="/offer/${encodeURIComponent(token)}" class="contract-success-link">&larr; Back to Offer</a>`
        sh += '</div>'
        successEl.innerHTML = sh
        successEl.style.display = 'block'

        // Bank choice handler
        if (hasBank) {
          document.getElementById('choose-bank')?.addEventListener('click', () => {
            const choiceEl = document.getElementById('payment-choice')
            const bankEl = document.getElementById('bank-panel')
            if (choiceEl) choiceEl.style.display = 'none'
            if (bankEl) bankEl.style.display = 'block'
          })

          // Receipt upload handler
          const receiptInput = document.getElementById('receipt-input') as HTMLInputElement
          const receiptBtn = document.getElementById('receipt-submit') as HTMLButtonElement
          const receiptLabel = document.getElementById('receipt-label')!
          const receiptStatus = document.getElementById('receipt-status')!
          let receiptFile: File | null = null

          receiptInput?.addEventListener('change', () => {
            if (receiptInput.files?.[0]) {
              receiptFile = receiptInput.files[0]
              receiptLabel.textContent = receiptFile.name
              receiptLabel.style.color = 'var(--c-green)'
              receiptBtn.disabled = false
            }
          })

          receiptBtn?.addEventListener('click', async () => {
            if (!receiptFile) return
            receiptBtn.disabled = true
            receiptBtn.textContent = 'Uploading...'
            receiptStatus.textContent = ''
            try {
              const ext = receiptFile.name.split('.').pop() || 'pdf'
              const path = `${token}/wire-receipt-${Date.now()}.${ext}`
              const uploadRes = await fetch(`${SB_URL}/storage/v1/object/wire-receipts/${path}`, {
                method: 'POST',
                headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': receiptFile.type },
                body: receiptFile
              })
              if (!uploadRes.ok) throw new Error('Upload failed')
              await supabasePublic.from('contracts').update({ wire_receipt_path: path }).eq('offer_token', token)
              receiptStatus.innerHTML = '<span style="color:var(--c-green);font-weight:600">Receipt uploaded successfully! We will verify your payment shortly.</span>'
              receiptBtn.textContent = 'Uploaded'
              const dropEl = document.getElementById('receipt-drop')
              if (dropEl) dropEl.style.borderColor = 'var(--c-green)'
            } catch (e: any) {
              receiptStatus.innerHTML = `<span style="color:var(--c-red)">Upload failed: ${e.message}</span>`
              receiptBtn.disabled = false
              receiptBtn.textContent = 'Upload Receipt'
            }
          })
        }
      } else {
        setStatusMsg('Agreement signed and submitted!')
        setStatusType('success')
      }
    } catch (e: any) {
      setSigning(false)
      setStatusMsg('Error: ' + e.message + '. Please try again.')
      setStatusType('error')
      const actionBar = document.getElementById('tax-action-bar')
      if (actionBar) actionBar.style.display = 'block'
    }
  }

  return (
    <>
      <div id="tax-success-state" style={{ display: 'none' }} />

      <div id="tax-contract-body" ref={bodyRef}>
        {/* HEADER */}
        <div className="contract-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo.jpg" alt="Tony Durante LLC" />
          <h1>Tax Return Filing Agreement</h1>
        </div>

        {/* PARTIES */}
        <p>This Tax Return Filing Agreement (&ldquo;<strong>Agreement</strong>&rdquo;) is entered into as of <strong>{today()}</strong>, by and between:</p>
        <p style={{ margin: '14px 0' }}><strong>Tony Durante LLC</strong>, a Florida limited liability company (&ldquo;<strong>Service Provider</strong>&rdquo;), and</p>
        <p style={{ margin: '14px 0' }}><strong>{name || '[Client Name]'}</strong> (&ldquo;<strong>Client</strong>&rdquo;).</p>

        {/* SERVICE SUMMARY */}
        <table className="contract-key-terms">
          <caption>Service Summary</caption>
          <tbody>
            <tr><th>Service</th><td>{serviceName}</td></tr>
            {serviceDesc && <tr><th>Description</th><td>{serviceDesc}</td></tr>}
            <tr><th>Fee</th><td>{fee} (one-time)</td></tr>
            {includes.length > 0 && (
              <tr><th>Includes</th><td>{(includes as string[]).map((item, i) => <span key={i}>{item}{i < includes.length - 1 ? ', ' : ''}</span>)}</td></tr>
            )}
          </tbody>
        </table>

        {/* SECTION 1 — SCOPE */}
        <div className="contract-section">
          <h3>1. Scope of Service</h3>
          <p>The Service Provider agrees to prepare and file the Client&rsquo;s LLC federal tax return for the tax year specified above. This includes:</p>
          <ul>
            <li>Preparation of the applicable IRS form(s) based on the LLC type;</li>
            <li>Electronic filing (e-filing) of the tax return with the IRS;</li>
            <li>Filing of a tax extension (Form 7004) if the return cannot be completed before the original deadline;</li>
            <li>Signature by a Certified Tax Preparer (PTIN holder).</li>
          </ul>
          <p>This Agreement covers <strong>one (1) tax return filing</strong> for the specified tax year only. Any additional tax years or services require a separate agreement.</p>
        </div>

        {/* SECTION 2 — CLIENT RESPONSIBILITIES */}
        <div className="contract-section">
          <h3>2. Client Responsibilities</h3>
          <p>The Client agrees to:</p>
          <ol type="a">
            <li><strong>Provide accurate and complete financial data</strong> for the LLC, including but not limited to: income, expenses, bank statements, and any other records required for the tax return;</li>
            <li><strong>Respond to requests for information</strong> within five (5) business days of receiving the request;</li>
            <li><strong>Certify the accuracy</strong> of all information provided. The Service Provider relies on the Client&rsquo;s data and is not responsible for errors resulting from incomplete or inaccurate information;</li>
            <li><strong>Notify the Service Provider promptly</strong> of any changes to the LLC structure, ownership, or financial activity that may affect the tax return.</li>
          </ol>
        </div>

        {/* SECTION 3 — PROCEDURE */}
        <div className="contract-section">
          <h3>3. Tax Filing Procedure</h3>
          <p>The tax return preparation follows this process:</p>
          <ol>
            <li><strong>Data Collection</strong> &mdash; The Service Provider sends the Client a tax intake form to gather all necessary LLC information and financial data.</li>
            <li><strong>Extension Filing</strong> &mdash; If the original filing deadline (typically March 15 for partnerships, April 15 for corporations) has passed or insufficient time remains, the Service Provider files an automatic extension (Form 7004), extending the deadline to September 15 or October 15 respectively.</li>
            <li><strong>Preparation</strong> &mdash; The Service Provider prepares the tax return based on the data provided by the Client.</li>
            <li><strong>Review &amp; Approval</strong> &mdash; The completed return is sent to the Client for review before filing.</li>
            <li><strong>Filing</strong> &mdash; Upon Client approval, the return is electronically filed with the IRS. The Client receives confirmation of acceptance.</li>
          </ol>
        </div>

        {/* SECTION 4 — SERVICE PROVIDER COMMITMENTS */}
        <div className="contract-section">
          <h3>4. Service Provider Commitments</h3>
          <p>The Service Provider agrees to:</p>
          <ol type="a">
            <li>Prepare the tax return in compliance with applicable IRS rules and regulations;</li>
            <li>File a tax extension on behalf of the Client if the return cannot be completed before the original deadline, ensuring no late-filing penalties;</li>
            <li>Complete and file the tax return within a reasonable timeframe after receiving all required data from the Client;</li>
            <li>Provide the Client with a copy of the filed return and IRS acceptance confirmation.</li>
          </ol>
        </div>

        {/* SECTION 5 — PAYMENT */}
        <div className="contract-section">
          <h3>5. Payment</h3>
          <p>The total fee for this service is <strong>{fee}</strong>, payable in full before the tax return preparation begins. Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.</p>
          <p><strong>All fees are non-refundable</strong> once the tax return preparation has commenced.</p>
        </div>

        {/* SECTION 6 — LIMITATION OF LIABILITY */}
        <div className="contract-section">
          <h3>6. Limitation of Liability</h3>
          <p>The Service Provider&rsquo;s total liability under this Agreement shall not exceed the fee paid by the Client. The Service Provider is not liable for penalties, interest, or additional taxes resulting from inaccurate, incomplete, or late information provided by the Client.</p>
        </div>

        {/* SECTION 7 — GOVERNING LAW */}
        <div className="contract-section">
          <h3>7. Governing Law</h3>
          <p>This Agreement is governed by the laws of the State of Florida. Any disputes shall be resolved through binding arbitration in Pinellas County, Florida, under AAA rules.</p>
        </div>

        {/* SECTION 8 — ELECTRONIC SIGNATURES */}
        <div className="contract-section">
          <h3>8. Electronic Signatures</h3>
          <p>Electronic signatures on this Agreement are valid and binding under the ESIGN Act (15 U.S.C. &sect; 7001) and UETA (Fla. Stat. &sect; 668.50).</p>
        </div>

        {/* CLIENT INFORMATION */}
        <table className="contract-client-form" id="tax-client-form">
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
            By signing below, I confirm that I have read and agree to the terms of this Tax Return Filing Agreement.
            I acknowledge my responsibility to provide accurate and complete financial data for the tax return preparation.
          </p>
          <div className="contract-sig-grid">
            <div className="contract-sig-block">
              <div className="contract-sig-label">Service Provider</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="contract-sig-static"><img src="/images/logo.jpg" alt="Tony Durante" style={{ maxHeight: 40, opacity: 0.8 }} /></div>
              <div className="contract-sig-field">Name: Tony Durante</div>
              <div className="contract-sig-field">Title: Managing Member</div>
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

      {/* ACTION BAR */}
      <div className="contract-action-bar" id="tax-action-bar">
        <button className="contract-btn contract-btn-sign" onClick={signAgreement} disabled={!ready || signing}>
          {signing ? 'Generating PDF...' : 'Sign & Accept Agreement'}
        </button>
        <div className={`contract-status-msg ${statusType === 'error' ? 'contract-error-msg' : statusType === 'success' ? 'contract-success-msg' : ''}`}>
          {statusMsg}
        </div>
      </div>
    </>
  )
}
