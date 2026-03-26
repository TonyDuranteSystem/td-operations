'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { supabasePublic } from '@/lib/supabase/public-client'
import type { Offer } from '@/lib/types/offer'
import StandaloneServiceAgreement from './standalone-service-agreement'
import RenewalAgreement from './renewal-agreement'
import ServiceAgreement from './service-agreement'
import { ensureBankDetails, type BankDetails } from './bank-defaults'

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

const CL = {
  en: {
    signing: 'Generating PDF...',
    redirecting: 'Contract signed! Redirecting to payment...',
    successTitle: 'Contract Signed Successfully!',
    successActivate: 'To activate your services, please complete the bank transfer below.',
    choosePayment: 'Choose how you want to pay:',
    payByCard: 'Pay by Card',
    payByTransfer: 'Bank Transfer',
    cardSurcharge: 'A 5% processing fee applies to card payments.',
    orSeparator: 'OR',
    bankTitle: 'Bank Transfer Details',
    beneficiary: 'Beneficiary', iban: 'IBAN', bic: 'BIC / SWIFT', bank: 'Bank', reference: 'Reference',
    accountNumber: 'Account Number', routingNumber: 'Routing Number',
    receiptTitle: 'Upload Wire Transfer Receipt',
    receiptDesc: 'Once you complete the transfer, upload the receipt to start your services immediately.',
    receiptLabel: 'Click to upload receipt (PDF or image)',
    receiptBtn: 'Upload Receipt',
    receiptUploading: 'Uploading...',
    receiptDone: 'Receipt uploaded successfully! We will verify your payment shortly.',
    receiptFail: 'Upload failed',
    afterPayment: 'Once payment is received and verified, we will begin working on your LLC immediately.',
    backToOffer: '&larr; Back to Offer',
    signed: 'Contract signed and submitted! Tony Durante will contact you shortly via WhatsApp.',
    uploaded: 'Uploaded',
  },
  it: {
    signing: 'Generazione PDF...',
    redirecting: 'Contratto firmato! Reindirizzamento al pagamento...',
    successTitle: 'Contratto Firmato con Successo!',
    successActivate: 'Per attivare i servizi, completa il bonifico bancario qui sotto.',
    choosePayment: 'Scegli come pagare:',
    payByCard: 'Paga con Carta',
    payByTransfer: 'Bonifico Bancario',
    cardSurcharge: 'Il pagamento con carta prevede una maggiorazione del 5%.',
    orSeparator: 'OPPURE',
    bankTitle: 'Coordinate Bancarie',
    beneficiary: 'Beneficiario', iban: 'IBAN', bic: 'BIC / SWIFT', bank: 'Banca', reference: 'Causale',
    accountNumber: 'Numero Conto', routingNumber: 'Routing Number',
    receiptTitle: 'Carica Ricevuta Bonifico',
    receiptDesc: 'Una volta completato il bonifico, carica la ricevuta per avviare i servizi immediatamente.',
    receiptLabel: 'Clicca per caricare la ricevuta (PDF o immagine)',
    receiptBtn: 'Carica Ricevuta',
    receiptUploading: 'Caricamento...',
    receiptDone: 'Ricevuta caricata con successo! Verificheremo il pagamento a breve.',
    receiptFail: 'Caricamento fallito',
    afterPayment: 'Una volta ricevuto e verificato il pagamento, inizieremo subito a lavorare sulla tua LLC.',
    backToOffer: '&larr; Torna all&#39;Offerta',
    signed: 'Contratto firmato e inviato! Tony Durante ti contatterà a breve via WhatsApp.',
    uploaded: 'Caricata',
  },
}

interface FormData {
  name: string; email: string; phone: string; address: string; city: string
  state: string; zip: string; country: string; nationality: string; passport: string
  passport_exp: string
}

function CheckoutPreview({ offer: rawOffer, cl, hasCard, hasBank, token }: { offer: Offer; cl: typeof CL['en']; hasCard: boolean; hasBank: boolean; token: string }) {
  // Ensure real bank details (replace placeholders with EUR/USD defaults)
  const offer = useMemo(() => {
    if (!rawOffer.bank_details) return rawOffer
    const fixed = ensureBankDetails(rawOffer.bank_details as BankDetails, rawOffer.cost_summary as unknown[])
    return { ...rawOffer, bank_details: fixed }
  }, [rawOffer])
  const [showBank, setShowBank] = useState(false)
  const receiptInputRef = useRef<HTMLInputElement>(null)
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [uploadStatus, setUploadStatus] = useState<string>('')
  const [uploading, setUploading] = useState(false)

  async function handleUpload() {
    if (!receiptFile) return
    setUploading(true)
    setUploadStatus('')
    try {
      const ext = receiptFile.name.split('.').pop() || 'pdf'
      const path = `${token}/wire-receipt-${Date.now()}.${ext}`
      const res = await fetch(`${SB_URL}/storage/v1/object/wire-receipts/${path}`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': receiptFile.type },
        body: receiptFile
      })
      if (!res.ok) throw new Error(cl.receiptFail)
      await supabasePublic.from('contracts').update({ wire_receipt_path: path }).eq('offer_token', token)
      setUploadStatus('success')
    } catch {
      setUploadStatus('error')
      setUploading(false)
    }
  }

  return (
    <div style={{ maxWidth: 540, margin: '40px auto', padding: '0 20px', fontFamily: "'Inter','Helvetica Neue',sans-serif" }}>
      <div className="contract-success-panel">
        <div className="contract-success-icon">&#10004;</div>
        <h2 style={{ color: 'var(--c-green)', fontSize: '18pt', marginBottom: 8 }}>{cl.successTitle}</h2>
        <p style={{ fontSize: '12pt', marginBottom: 28, color: 'var(--c-muted)' }}>{cl.choosePayment}</p>

        {!showBank && (
          <div>
            {hasCard && (
              <a href={offer.payment_links![0].url} className="ps-choice-btn ps-choice-card" target="_blank" rel="noopener noreferrer" style={{ marginBottom: hasBank ? 0 : 16 }}>
                <span className="ps-choice-icon">&#128179;</span>
                <span className="ps-choice-label">{cl.payByCard}</span>
                <span className="ps-choice-price">{offer.payment_links![0].amount}</span>
                {hasBank && <span className="ps-choice-badge">+5%</span>}
              </a>
            )}
            {hasCard && hasBank && (
              <div className="post-sign-divider"><span>{cl.orSeparator}</span></div>
            )}
            {hasBank && (
              <button onClick={() => setShowBank(true)} className="ps-choice-btn ps-choice-bank" type="button">
                <span className="ps-choice-icon">&#127974;</span>
                <span className="ps-choice-label">{cl.payByTransfer}</span>
                <span className="ps-choice-price">{offer.bank_details!.amount || ''}</span>
              </button>
            )}
          </div>
        )}

        {showBank && hasBank && (
          <div className="post-sign-option">
            <div className="post-sign-option-label">&#127974; {cl.payByTransfer}</div>
            {offer.bank_details!.amount && <div className="post-sign-bank-amount">{offer.bank_details!.amount}</div>}
            <div className="contract-bank-details-box">
              <h3>{cl.bankTitle}</h3>
              {offer.bank_details!.beneficiary && <div className="contract-bank-row"><span className="contract-bank-label">{cl.beneficiary}</span><span className="contract-bank-value">{offer.bank_details!.beneficiary}</span></div>}
              {offer.bank_details!.account_number && <div className="contract-bank-row"><span className="contract-bank-label">{cl.accountNumber}</span><span className="contract-bank-value">{offer.bank_details!.account_number}</span></div>}
              {offer.bank_details!.routing_number && <div className="contract-bank-row"><span className="contract-bank-label">{cl.routingNumber}</span><span className="contract-bank-value">{offer.bank_details!.routing_number}</span></div>}
              {offer.bank_details!.iban && <div className="contract-bank-row"><span className="contract-bank-label">{cl.iban}</span><span className="contract-bank-value">{offer.bank_details!.iban}</span></div>}
              {offer.bank_details!.bic && <div className="contract-bank-row"><span className="contract-bank-label">{cl.bic}</span><span className="contract-bank-value">{offer.bank_details!.bic}</span></div>}
              {offer.bank_details!.bank_name && <div className="contract-bank-row"><span className="contract-bank-label">{cl.bank}</span><span className="contract-bank-value">{offer.bank_details!.bank_name}</span></div>}
              {offer.bank_details!.reference && <div className="contract-bank-ref">{cl.reference}: {offer.bank_details!.reference}</div>}
            </div>
            <div className="contract-receipt-upload">
              <h3 style={{ fontSize: '11pt', marginBottom: 8 }}>{cl.receiptTitle}</h3>
              <p style={{ fontSize: '9.5pt', color: 'var(--c-muted)', marginBottom: 12 }}>{cl.receiptDesc}</p>
              <div className="contract-receipt-drop" onClick={() => receiptInputRef.current?.click()} style={{ cursor: 'pointer' }}>
                <input ref={receiptInputRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) setReceiptFile(e.target.files[0]) }} />
                <p style={{ color: receiptFile ? 'var(--c-green)' : 'var(--c-muted)' }}>{receiptFile ? receiptFile.name : cl.receiptLabel}</p>
              </div>
              <button className="contract-receipt-btn" disabled={!receiptFile || uploading} onClick={handleUpload}>
                {uploading ? cl.receiptUploading : uploadStatus === 'success' ? cl.uploaded : cl.receiptBtn}
              </button>
              {uploadStatus === 'success' && <p style={{ fontSize: '9pt', color: 'var(--c-green)', fontWeight: 600, marginTop: 8 }}>{cl.receiptDone}</p>}
              {uploadStatus === 'error' && <p style={{ fontSize: '9pt', color: 'var(--c-red)', marginTop: 8 }}>{cl.receiptFail}</p>}
            </div>
          </div>
        )}

        <p style={{ fontSize: '9.5pt', color: 'var(--c-muted)', marginTop: 24 }}>{cl.afterPayment}</p>
        <a href={`/offer/${encodeURIComponent(token)}`} className="contract-success-link" dangerouslySetInnerHTML={{ __html: cl.backToOffer }} />
      </div>
    </div>
  )
}

export default function ContractPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = params.token as string
  const isCheckoutPreview = searchParams.get('checkout') === '1'
  const [offer, setOffer] = useState<Offer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [signing, setSigning] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Complete all required fields and sign both sections above.')
  const [statusType, setStatusType] = useState<'info' | 'error' | 'success'>('info')
  const [ready, setReady] = useState(false)
  const [form, setForm] = useState<FormData>({ name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', nationality: '', passport: '', passport_exp: '' })
  const formRef = useRef<FormData>(form)
  useEffect(() => { formRef.current = form }, [form])
  const [passportFile, setPassportFile] = useState<File | null>(null)

  const sigMsaRef = useRef<HTMLCanvasElement>(null)
  const sigSowRef = useRef<HTMLCanvasElement>(null)
  const sigPadsRef = useRef<Record<string, any>>({})
  const contractBodyRef = useRef<HTMLDivElement>(null)
  const pdfBlobRef = useRef<Blob | null>(null)

  // Load offer
  useEffect(() => {
    if (!token) { setError('No contract token provided.'); setLoading(false); return }
    loadOffer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function loadOffer() {
    try {
      const { data, error: err } = await supabasePublic.from('offers').select('*').eq('token', token).single()
      if (err || !data) { setError('Offer not found.'); setLoading(false); return }
      const o = data as Offer
      // Safeguard: parse JSONB fields that may be stored as strings
      const jsonFields = ['issues', 'immediate_actions', 'strategy', 'services', 'additional_services', 'cost_summary', 'recurring_costs', 'future_developments', 'next_steps', 'payment_links'] as const
      for (const f of jsonFields) {
        const val = (o as any)[f]
        if (typeof val === 'string') {
          try { (o as any)[f] = JSON.parse(val) } catch { (o as any)[f] = [] }
        }
      }
      setOffer(o)
      setForm(f => ({ ...f, name: o.client_name || '' }))
      setLoading(false)
    } catch (e: any) { setError('Error loading contract: ' + e.message); setLoading(false) }
  }

  // Init signature pads after render
  useEffect(() => {
    if (!offer || loading) return
    const timer = setTimeout(() => {
      initSigPads()
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer, loading])

  async function initSigPads() {
    const SignaturePad = (await import('signature_pad')).default
    const canvases = { msa: sigMsaRef.current, sow: sigSowRef.current }
    Object.entries(canvases).forEach(([id, canvas]) => {
      if (!canvas) return
      const ratio = Math.max(window.devicePixelRatio || 1, 1)
      canvas.width = canvas.offsetWidth * ratio
      canvas.height = canvas.offsetHeight * ratio
      canvas.getContext('2d')!.scale(ratio, ratio)
      const pad = new SignaturePad(canvas, { backgroundColor: 'rgba(255,255,255,0)', penColor: '#1a1a2e', minWidth: 1, maxWidth: 2.5 })
      pad.addEventListener('endStroke', () => checkReady())
      sigPadsRef.current[id] = pad
    })
  }

  function clearSig(id: string) {
    if (sigPadsRef.current[id]) sigPadsRef.current[id].clear()
    checkReady()
  }

  // Validation
  const isValidPhone = (v: string) => /^\+\d[\d\s\-()]{6,20}$/.test(v)
  const isValidZip = (v: string) => /^\d{3,10}$/.test(v.replace(/\s/g, ''))

  const checkReady = useCallback(() => {
    const f = formRef.current
    const hasMSA = sigPadsRef.current.msa && !sigPadsRef.current.msa.isEmpty()
    const hasSOW = sigPadsRef.current.sow && !sigPadsRef.current.sow.isEmpty()
    const phoneOk = !f.phone || isValidPhone(f.phone)
    const zipOk = !f.zip || isValidZip(f.zip)
    const isReady = !!f.name && !!f.email && !!f.phone && !!f.address && !!f.zip && !!f.country && !!f.passport && hasMSA && hasSOW && phoneOk && zipOk
    setReady(isReady)

    if (!isReady) {
      const missing: string[] = []
      if (!f.name) missing.push('name')
      if (!f.email) missing.push('email')
      if (!f.phone) missing.push('phone')
      else if (!phoneOk) missing.push('valid phone (+country code)')
      if (!f.address) missing.push('address')
      if (!f.zip) missing.push('ZIP code')
      else if (!zipOk) missing.push('valid ZIP (numbers only)')
      if (!f.country) missing.push('country')
      if (!f.passport) missing.push('passport')
      if (!hasMSA) missing.push('MSA signature')
      if (!hasSOW) missing.push('SOW signature')
      setStatusMsg('Missing: ' + missing.join(', '))
      setStatusType('info')
    } else {
      setStatusMsg('Ready to sign. Click the button below.')
      setStatusType('info')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-validate whenever form data changes
  useEffect(() => { if (offer) checkReady() }, [form, offer, checkReady])

  function updateForm(field: keyof FormData, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  // Extract offer data for contract
  function getContractData() {
    if (!offer) return { fee: '', llcType: '', installments: '', year: new Date().getFullYear() }
    const o = offer
    const year = new Date().getFullYear()
    let fee = '', llcType = '', installments = ''

    // Pick the recommended service first, fallback to last
    if (o.services && Array.isArray(o.services) && o.services.length > 0) {
      const rec = o.services.find(x => x.recommended) || o.services[o.services.length - 1]
      fee = rec.price || ''
    }
    // Override with matching cost_summary if available (prefer "recommended" label)
    if (o.cost_summary && Array.isArray(o.cost_summary) && o.cost_summary.length > 0) {
      const rc = o.cost_summary.find(x => /recommended/i.test(x.label || '')) || o.cost_summary[o.cost_summary.length - 1]
      if (rc.total) fee = rc.total
    }
    // Derive installments from recurring_costs — always English labels
    if (o.recurring_costs && Array.isArray(o.recurring_costs) && o.recurring_costs.length >= 2) {
      const parts: string[] = []
      for (let idx = 0; idx < o.recurring_costs.length; idx++) {
        const item = o.recurring_costs[idx]
        const amt = (item as any).amount || (item as any).price || ''
        const rawLabel = (item.label || '').toLowerCase()
        let engLabel: string
        if (rawLabel.includes('jan') || rawLabel.includes('genn')) engLabel = 'First Installment (January)'
        else if (rawLabel.includes('jun') || rawLabel.includes('giugno')) engLabel = 'Second Installment (June)'
        else engLabel = idx === 0 ? 'First Installment' : 'Second Installment'
        parts.push(`${engLabel}: ${amt}`)
      }
      installments = parts.join(' — ')
    }
    if (!installments && fee) {
      installments = `Single payment of ${fee}`
    }
    if (o.services && Array.isArray(o.services)) {
      const svc = o.services.find(x => (x.name || '').toLowerCase().includes('llc'))
      if (svc) llcType = svc.name || ''
    }
    if (!llcType) llcType = 'Single-Member LLC (Florida)'
    if (!fee) fee = 'As specified in the offer'
    // Normalize fee text to English (e.g., "/anno" → "/year")
    fee = fee.replace(/\/anno/gi, '/year').replace(/\/mese/gi, '/month')
    if (!installments) installments = 'As specified in the offer'
    return { fee, llcType, installments, year }
  }

  // Sign contract
  async function signContract() {
    if (!offer || signing) return
    setSigning(true)
    const cl = CL[offer.language || 'en']
    setStatusMsg(cl.signing)
    setStatusType('info')

    try {
      // Dynamic import html2pdf
      const html2pdf = (await import('html2pdf.js')).default

      // Freeze form fields for PDF
      const formEl = document.getElementById('client-form')
      if (formEl) {
        formEl.querySelectorAll('input').forEach(inp => {
          const td = inp.parentElement!
          const val = inp.value
          td.innerHTML = `<span style="font-weight:500">${esc(val)}</span>`
        })
      }

      // Replace canvases with images
      ;['msa', 'sow'].forEach(id => {
        const canvas = id === 'msa' ? sigMsaRef.current : sigSowRef.current
        if (!canvas || !sigPadsRef.current[id]) return
        const wrap = canvas.parentElement!
        const dataUrl = sigPadsRef.current[id].toDataURL('image/png')
        wrap.innerHTML = `<img src="${dataUrl}" style="height:120px;display:block">`
      })

      // Hide action bar
      const actionBar = document.getElementById('action-bar')
      if (actionBar) actionBar.style.display = 'none'
      document.querySelectorAll('.contract-clear-btn').forEach(b => (b as HTMLElement).style.display = 'none')

      // Generate PDF
      const element = contractBodyRef.current
      const opt = {
        margin: [0.5, 0.6, 0.7, 0.6] as [number, number, number, number],
        filename: `Tony_Durante_Contract_${offer.token}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfBlob = await (html2pdf() as any).set(opt).from(element).outputPdf('blob')

      // Save blob for client download
      pdfBlobRef.current = pdfBlob

      // Upload PDF
      setStatusMsg('Uploading signed contract...')
      const pdfPath = `${offer.token}/contract-signed-${Date.now()}.pdf`
      await fetch(`${SB_URL}/storage/v1/object/signed-contracts/${pdfPath}`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': 'application/pdf' },
        body: pdfBlob
      })

      // Save contract record — include business fields from offer
      // Derive LLC type from services
      const servicesArr = Array.isArray(offer.services)
        ? offer.services
        : (typeof offer.services === 'string' ? JSON.parse(offer.services) : [])
      const allServiceNames = servicesArr.map((s: any) => (s.name || '').toLowerCase()).join(' ')
      const llcType = allServiceNames.includes('multi-member') ? 'MMLLC'
        : allServiceNames.includes('single-member') ? 'SMLLC'
        : null

      // Derive installments + annual_fee from recurring_costs
      const rc = Array.isArray(offer.recurring_costs) ? offer.recurring_costs : []
      let installmentJan = 0
      let installmentJun = 0
      for (const item of rc) {
        const rawAmt = (item as any).amount || item.price || '0'
        const amt = parseFloat(String(rawAmt).replace(/[^0-9.]/g, ''))
        const lbl = (item.label || '').toLowerCase()
        if (lbl.includes('gennaio') || lbl.includes('january') || lbl.includes('jan')) installmentJan = amt
        else if (lbl.includes('giugno') || lbl.includes('june') || lbl.includes('jun')) installmentJun = amt
        else if (amt > 0 && installmentJan === 0) installmentJan = amt
        else if (amt > 0 && installmentJun === 0) installmentJun = amt
      }
      const annualFee = installmentJan + installmentJun
      const contractYear = offer.offer_date
        ? new Date(offer.offer_date).getFullYear().toString()
        : new Date().getFullYear().toString()

      const contractData: Record<string, any> = {
        offer_token: offer.token,
        client_name: form.name,
        client_email: form.email,
        client_phone: form.phone,
        client_address: form.address,
        client_city: form.city,
        client_state: form.state,
        client_zip: form.zip,
        client_country: form.country,
        client_nationality: form.nationality,
        client_passport: form.passport,
        client_passport_exp: form.passport_exp,
        signed_at: new Date().toISOString(),
        pdf_path: pdfPath,
        status: 'signed',
        llc_type: llcType,
        annual_fee: annualFee > 0 ? annualFee.toString() : null,
        contract_year: contractYear,
        installments: annualFee > 0 ? JSON.stringify({ jan: installmentJan, jun: installmentJun }) : null,
      }
      await supabasePublic.from('contracts').insert(contractData)

      // Update offer status (retry)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { error: pErr } = await supabasePublic.from('offers').update({ status: 'signed' }).eq('token', offer.token)
          if (!pErr) break
        } catch { /* retry */ }
      }

      // Notify backend that contract was signed → creates pending_activation
      try {
        await fetch('/api/webhooks/offer-signed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offer_token: offer.token })
        })
      } catch (e) {
        console.warn('[contract] Failed to notify offer-signed webhook:', e)
      }

      // Post-sign behavior — show payment choice buttons
      const hasCard = offer.payment_links && offer.payment_links.length > 0
      const hasBank = !!offer.bank_details
      const successEl = document.getElementById('success-state')

      if ((hasCard || hasBank) && successEl && contractBodyRef.current) {
        contractBodyRef.current.style.display = 'none'
        let sh = '<div class="contract-success-panel"><div class="contract-success-icon">&#10004;</div>'
        sh += `<h2>${cl.successTitle}</h2>`
        sh += `<p style="font-size:12pt;margin-bottom:28px;">${cl.choosePayment}</p>`

        // ── Choice buttons ──
        sh += '<div id="payment-choice">'
        if (hasCard) {
          const pl = offer.payment_links![0]
          sh += `<a href="${esc(pl.url)}" class="ps-choice-btn ps-choice-card" target="_blank" rel="noopener noreferrer">`
          sh += `<span class="ps-choice-icon">&#128179;</span>`
          sh += `<span class="ps-choice-label">${cl.payByCard}</span>`
          sh += `<span class="ps-choice-price">${esc(pl.amount)}</span>`
          if (hasBank) sh += `<span class="ps-choice-badge">+5%</span>`
          sh += '</a>'
        }

        if (hasCard && hasBank) {
          sh += `<div class="post-sign-divider"><span>${cl.orSeparator}</span></div>`
        }

        if (hasBank) {
          sh += `<button id="choose-bank" class="ps-choice-btn ps-choice-bank" type="button">`
          sh += `<span class="ps-choice-icon">&#127974;</span>`
          sh += `<span class="ps-choice-label">${cl.payByTransfer}</span>`
          sh += `<span class="ps-choice-price">${esc(offer.bank_details!.amount || '')}</span>`
          sh += '</button>'
        }
        sh += '</div>'

        // ── Bank details panel (hidden until chosen) ──
        if (hasBank) {
          const b = offer.bank_details!
          sh += '<div id="bank-panel" style="display:none;">'
          sh += `<div class="post-sign-option">`
          sh += `<div class="post-sign-option-label">&#127974; ${cl.payByTransfer}</div>`
          if (b.amount) sh += `<div class="post-sign-bank-amount">${esc(b.amount)}</div>`
          sh += `<div class="contract-bank-details-box"><h3>${cl.bankTitle}</h3>`
          if (b.beneficiary) sh += `<div class="contract-bank-row"><span class="contract-bank-label">${cl.beneficiary}</span><span class="contract-bank-value">${esc(b.beneficiary)}</span></div>`
          if (b.account_number) sh += `<div class="contract-bank-row"><span class="contract-bank-label">${cl.accountNumber}</span><span class="contract-bank-value">${esc(b.account_number)}</span></div>`
          if (b.routing_number) sh += `<div class="contract-bank-row"><span class="contract-bank-label">${cl.routingNumber}</span><span class="contract-bank-value">${esc(b.routing_number)}</span></div>`
          if (b.iban) sh += `<div class="contract-bank-row"><span class="contract-bank-label">${cl.iban}</span><span class="contract-bank-value">${esc(b.iban)}</span></div>`
          if (b.bic) sh += `<div class="contract-bank-row"><span class="contract-bank-label">${cl.bic}</span><span class="contract-bank-value">${esc(b.bic)}</span></div>`
          if (b.bank_name) sh += `<div class="contract-bank-row"><span class="contract-bank-label">${cl.bank}</span><span class="contract-bank-value">${esc(b.bank_name)}</span></div>`
          if (b.reference) sh += `<div class="contract-bank-ref">${cl.reference}: ${esc(b.reference)}</div>`
          sh += '</div>'
          // Wire receipt upload
          sh += '<div class="contract-receipt-upload">'
          sh += `<h3 style="font-size:11pt;margin-bottom:8px;">${cl.receiptTitle}</h3>`
          sh += `<p style="font-size:9.5pt;color:var(--c-muted);margin-bottom:12px;">${cl.receiptDesc}</p>`
          sh += '<div class="contract-receipt-drop" id="receipt-drop" onclick="document.getElementById(\'receipt-input\').click()">'
          sh += '<input type="file" id="receipt-input" accept="image/*,.pdf" style="display:none" />'
          sh += `<p id="receipt-label">${cl.receiptLabel}</p>`
          sh += '</div>'
          sh += `<button id="receipt-submit" class="contract-receipt-btn" disabled>${cl.receiptBtn}</button>`
          sh += '<div id="receipt-status" style="font-size:9pt;margin-top:8px;"></div>'
          sh += '</div>'
          sh += '</div>'
          sh += '</div>'
        }

        sh += '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #d4e8d4;">'
        sh += '<button id="download-pdf-btn" style="padding:10px 32px;font-size:14px;font-weight:600;background:#0A3161;color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:Georgia,serif;">Download Signed PDF</button>'
        sh += '</div>'
        sh += `<p style="font-size:9.5pt;color:var(--c-muted);margin-top:24px;">${cl.afterPayment}</p>`
        sh += `<a href="/offer/${encodeURIComponent(offer.token)}" class="contract-success-link">${cl.backToOffer}</a>`
        sh += '</div>'
        successEl.innerHTML = sh
        successEl.style.display = 'block'

        // Download PDF handler
        document.getElementById('download-pdf-btn')?.addEventListener('click', async () => {
          try {
            let blob = pdfBlobRef.current
            if (!blob) {
              const { data } = await supabasePublic.storage.from('signed-contracts').list(offer.token)
              const pdfFile = data?.sort((a, b) => b.name.localeCompare(a.name))[0]
              if (pdfFile) {
                const { data: downloaded } = await supabasePublic.storage.from('signed-contracts').download(`${offer.token}/${pdfFile.name}`)
                if (downloaded) blob = downloaded
              }
            }
            if (!blob) { alert('PDF not available. Please contact support.'); return }
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `Tony_Durante_Contract_${offer.token}.pdf`
            a.click()
            URL.revokeObjectURL(url)
          } catch { alert('Download failed. Please contact support.') }
        })

        // Bank choice click handler — show bank panel, hide choice buttons
        if (hasBank) {
          document.getElementById('choose-bank')?.addEventListener('click', () => {
            const choiceEl = document.getElementById('payment-choice')
            const bankEl = document.getElementById('bank-panel')
            if (choiceEl) choiceEl.style.display = 'none'
            if (bankEl) bankEl.style.display = 'block'
          })

          // Wire receipt upload handler
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
            receiptBtn.textContent = cl.receiptUploading
            receiptStatus.textContent = ''
            try {
              const ext = receiptFile.name.split('.').pop() || 'pdf'
              const path = `${offer.token}/wire-receipt-${Date.now()}.${ext}`
              const uploadRes = await fetch(`${SB_URL}/storage/v1/object/wire-receipts/${path}`, {
                method: 'POST',
                headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': receiptFile.type },
                body: receiptFile
              })
              if (!uploadRes.ok) throw new Error(cl.receiptFail)
              await supabasePublic.from('contracts').update({ wire_receipt_path: path }).eq('offer_token', offer.token)
              receiptStatus.innerHTML = `<span style="color:var(--c-green);font-weight:600">${cl.receiptDone}</span>`
              receiptBtn.textContent = cl.uploaded
              const dropEl = document.getElementById('receipt-drop')
              if (dropEl) dropEl.style.borderColor = 'var(--c-green)'
            } catch (e: any) {
              receiptStatus.innerHTML = `<span style="color:var(--c-red)">${cl.receiptFail}: ${e.message}</span>`
              receiptBtn.disabled = false
              receiptBtn.textContent = cl.receiptBtn
            }
          })
        }
      } else {
        setStatusMsg(cl.signed)
        setStatusType('success')
      }
    } catch (e: any) {
      setSigning(false)
      setStatusMsg('Error: ' + e.message + '. Please try again.')
      setStatusType('error')
      // Re-show action bar
      const actionBar = document.getElementById('action-bar')
      if (actionBar) actionBar.style.display = 'block'
    }
  }

  if (loading) return <><ContractStyles /><div className="contract-loading"><div className="contract-spinner" /><p>Loading contract...</p></div></>
  if (error) return <><ContractStyles /><div className="contract-error-box"><h2>Error</h2><p>{error}</p></div></>
  if (!offer) return null

  // Checkout preview mode — show payment choice directly
  if (isCheckoutPreview && offer) {
    const cl = CL[offer.language === 'it' ? 'it' : 'en']
    const hasCard = offer.payment_links && offer.payment_links.length > 0
    const hasBank = !!offer.bank_details
    return (
      <>
        <ContractStyles />
        <CheckoutPreview offer={offer} cl={cl} hasCard={!!hasCard} hasBank={hasBank} token={token} />
      </>
    )
  }

  // Annual Renewal agreement — installment-based contract for existing clients
  if ((offer as any).contract_type === 'renewal') {
    return (
      <>
        <ContractStyles />
        <RenewalAgreement offer={offer} token={token} />
      </>
    )
  }

  // Tax Return agreement — lightweight contract
  if ((offer as any).contract_type === 'tax_return') {
    return (
      <>
        <ContractStyles />
        <StandaloneServiceAgreement offer={offer} token={token} contractType="tax_return" />
      </>
    )
  }

  // ITIN agreement — standalone ITIN application
  if ((offer as any).contract_type === 'itin') {
    return (
      <>
        <ContractStyles />
        <StandaloneServiceAgreement offer={offer} token={token} contractType="itin" />
      </>
    )
  }

  // Onboarding agreement — MSA+SOW for existing LLC clients (no formation timeline)
  if ((offer as any).contract_type === 'onboarding') {
    return (
      <>
        <ContractStyles />
        <ServiceAgreement offer={offer} token={token} />
      </>
    )
  }

  const { fee, llcType, installments, year } = getContractData()
  const effDate = today()
  const phoneInvalid = form.phone && !isValidPhone(form.phone)
  const zipInvalid = form.zip && !isValidZip(form.zip)

  // Build notice address
  const clientNotice = [
    form.name,
    form.address,
    [form.city, form.state, form.zip].filter(Boolean).join(', '),
    form.email
  ].filter(Boolean).join('\n')

  // Services list
  const servicesList = offer.services && Array.isArray(offer.services)
    ? offer.services.map(svc => ({ name: svc.name || '', desc: svc.description || '' }))
    : [
        { name: 'LLC Formation & State Registration', desc: '' },
        { name: 'EIN Application', desc: '' },
        { name: 'Registered Agent', desc: '' },
        { name: 'U.S. Business Address & Mail Handling', desc: '' },
        { name: 'Banking Assistance', desc: '' },
        { name: 'Payment Processor Setup', desc: '' },
        { name: 'Annual Report Filing', desc: '' },
        { name: 'Ongoing Administrative Support', desc: '' }
      ]

  return (
    <>
      <ContractStyles />

      <div id="success-state" style={{ display: 'none' }} />

      <div id="contract-body" ref={contractBodyRef}>
        {/* HEADER */}
        <div className="contract-header">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo.jpg" alt="Tony Durante LLC" />
          <h1>Master Service Agreement</h1>
          <div className="contract-subtitle">&amp; Statement of Work</div>
        </div>

        {/* PART 1 — MSA */}
        <div className="contract-part-divider"><h2>Part 1 — Master Service Agreement</h2></div>

        <p>This Master Service Agreement (&ldquo;<strong>Agreement</strong>&rdquo; or &ldquo;<strong>MSA</strong>&rdquo;) is entered into as of <strong>{effDate}</strong> (&ldquo;<strong>Effective Date</strong>&rdquo;), by and between:</p>
        <p style={{ margin: '14px 0' }}><strong>Tony Durante LLC</strong>, a Florida limited liability company, with principal offices in Largo, Florida (&ldquo;<strong>Consulting Firm</strong>&rdquo;), and</p>
        <p style={{ margin: '14px 0' }}>the individual or entity identified below (&ldquo;<strong>Client</strong>&rdquo;).</p>
        <p>Collectively referred to as the &ldquo;<strong>Parties</strong>&rdquo; and individually as a &ldquo;<strong>Party</strong>&rdquo;.</p>

        {/* KEY TERMS */}
        <table className="contract-key-terms">
          <caption>Key Terms Summary</caption>
          <tbody>
            <tr><th>Contract Year</th><td>{year} (January 1 - December 31)</td></tr>
            <tr><th>LLC Type</th><td>{llcType}</td></tr>
            <tr><th>Annual Service Fee</th><td>{fee}</td></tr>
            <tr><th>Payment Schedule</th><td>Full annual fee due upon signing. From the following year: {installments}</td></tr>
            <tr><th>Late Onboarding</th><td>Clients onboarding after January 1 shall pay the full Annual Service Fee for the initial Contract Year, regardless of start date. The fee will not be prorated.</td></tr>
            <tr><th>Cancellation Deadline</th><td>Written notice must be received no later than November 1 of the current Contract Year to prevent automatic renewal.</td></tr>
          </tbody>
        </table>

        {/* CLIENT FORM */}
        <table className="contract-client-form" id="client-form">
          <caption style={{ fontFamily: "'Inter',sans-serif", fontWeight: 700, fontSize: '11pt', textAlign: 'left', paddingBottom: 6, color: 'var(--c-primary)' }}>Client Information</caption>
          <tbody>
            <FormRow label="Full Legal Name"><input type="text" value={form.name} onChange={e => updateForm('name', e.target.value)} placeholder="Enter your full legal name" /></FormRow>
            <FormRow label="Residential Address" required><input type="text" value={form.address} onChange={e => updateForm('address', e.target.value)} placeholder="Street address" /></FormRow>
            <FormRow label="City" required><input type="text" value={form.city} onChange={e => updateForm('city', e.target.value)} placeholder="City" /></FormRow>
            <FormRow label="State / Province" required><input type="text" value={form.state} onChange={e => updateForm('state', e.target.value)} placeholder="State or province" /></FormRow>
            <FormRow label="ZIP / Postal Code" required invalid={!!zipInvalid}>
              <input type="text" value={form.zip} onChange={e => updateForm('zip', e.target.value)} placeholder="ZIP or postal code" inputMode="numeric" />
              <div className="contract-field-hint" style={{ display: zipInvalid ? 'block' : 'none', color: 'var(--c-red)' }}>Numbers only (e.g. 33771)</div>
            </FormRow>
            <FormRow label="Country" required><input type="text" value={form.country} onChange={e => updateForm('country', e.target.value)} placeholder="Country" /></FormRow>
            <FormRow label="Email Address"><input type="email" value={form.email} onChange={e => updateForm('email', e.target.value)} placeholder="Email address" /></FormRow>
            <FormRow label="Phone Number" required invalid={!!phoneInvalid}>
              <input type="tel" value={form.phone} onChange={e => updateForm('phone', e.target.value)} placeholder="+1 234 567 8900" />
              <div className="contract-field-hint" style={{ display: phoneInvalid ? 'block' : 'none', color: 'var(--c-red)' }}>Must start with + country code (e.g. +1, +39, +44)</div>
            </FormRow>
            <FormRow label="Nationality" required><input type="text" value={form.nationality} onChange={e => updateForm('nationality', e.target.value)} placeholder="Nationality" /></FormRow>
            <FormRow label="Passport Number" required><input type="text" value={form.passport} onChange={e => updateForm('passport', e.target.value)} placeholder="Passport number" /></FormRow>
            <FormRow label="Passport Expiration" required><input type="text" value={form.passport_exp} onChange={e => updateForm('passport_exp', e.target.value)} placeholder="MM/YYYY" /></FormRow>
          </tbody>
        </table>

        {/* LEGAL SECTIONS 1-24 */}
        <LegalSections />

        {/* EXHIBIT A */}
        <div className="contract-section" style={{ marginTop: 36 }}>
          <h3>Exhibit A &mdash; Client Identification</h3>
          <p>The Client shall provide a clear, legible copy of a valid government-issued passport.</p>
          <div className="contract-exhibit-box" onClick={() => document.getElementById('passport-file')?.click()}>
            <input type="file" id="passport-file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) setPassportFile(e.target.files[0]) }} />
            <p>{passportFile ? <span className="contract-uploaded-name">{passportFile.name}</span> : 'Click to upload your passport copy'}</p>
          </div>
        </div>

        {/* MSA SIGNATURES */}
        <div className="contract-sig-section">
          <h3 style={{ textAlign: 'center' }}>Master Service Agreement &mdash; Signatures</h3>
          <p className="contract-text-center contract-text-muted" style={{ marginBottom: 16, fontSize: '9.5pt' }}>By signing below, the Parties acknowledge that they have read, understood, and agree to be bound by the terms and conditions of this Master Service Agreement.</p>
          <div className="contract-sig-grid">
            <div className="contract-sig-block">
              <div className="contract-sig-label">Consulting Firm</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="contract-sig-static"><img src="/images/logo.jpg" alt="Tony Durante" style={{ maxHeight: 40, opacity: 0.8 }} /></div>
              <div className="contract-sig-field">Name: Tony Durante</div>
              <div className="contract-sig-field">Title: Managing Member</div>
              <div className="contract-sig-date">Date: {today()}</div>
            </div>
            <div className="contract-sig-block">
              <div className="contract-sig-label">Client</div>
              <div className="contract-sig-canvas-wrap">
                <canvas ref={sigMsaRef} style={{ width: '100%', height: 120, display: 'block', borderRadius: 6 }} />
                <button className="contract-clear-btn" onClick={() => clearSig('msa')}>Clear</button>
              </div>
              <div className="contract-sig-field">Name: {form.name}</div>
              <div className="contract-sig-date">Date: {today()}</div>
            </div>
          </div>
        </div>

        {/* PART 2 — SOW */}
        <div className="contract-part-divider" style={{ marginTop: 48 }}><h2>Part 2 — Statement of Work</h2></div>

        <p>This Statement of Work (&ldquo;SOW&rdquo;) is entered into pursuant to the Master Service Agreement dated <strong>{effDate}</strong> between Tony Durante LLC (&ldquo;Consulting Firm&rdquo;) and <strong>{form.name || '[Client Name]'}</strong> (&ldquo;Client&rdquo;).</p>

        <table className="contract-key-terms" style={{ marginTop: 20 }}>
          <caption>SOW Details</caption>
          <tbody>
            <tr><th>Contract Year</th><td>{year} (January 1 - December 31)</td></tr>
            <tr><th>LLC Type</th><td>{llcType}</td></tr>
            <tr><th>Annual Service Fee</th><td>{fee}</td></tr>
          </tbody>
        </table>

        <div className="contract-section"><h3>Included Services</h3>
          <p>The following services are included in the Annual Service Fee:</p>
          <ol>
            {servicesList.map((svc, i) => (
              <li key={i}><strong>{svc.name}</strong>{svc.desc ? ` — ${svc.desc}` : ''}</li>
            ))}
          </ol>
        </div>

        <div className="contract-section"><h3>Estimated Timeline</h3>
          <table className="contract-key-terms">
            <tbody>
              <tr><th>LLC Formation</th><td>2-4 weeks (state processing)</td></tr>
              <tr><th>EIN Issuance</th><td>1-6 weeks (IRS processing)</td></tr>
              <tr><th>Bank Account</th><td>2-6 weeks (bank approval)</td></tr>
              <tr><th>Full Setup</th><td>4-10 weeks from onboarding</td></tr>
            </tbody>
          </table>
          <p style={{ marginTop: 10 }}><strong>Disclaimer:</strong> The Consulting Firm does not guarantee specific timelines. Processing times are determined by government agencies, financial institutions, and other third-party entities. Delays caused by third-party processing shall not constitute a breach.</p>
        </div>

        <div className="contract-section"><h3>Payment Schedule</h3>
          <table className="contract-key-terms">
            <tbody>
              <tr><th>Total Annual Fee</th><td>{fee}</td></tr>
              <tr><th>Upon Signing (First Year)</th><td>The full Annual Service Fee of {fee} is due at the time of contract signing.</td></tr>
              <tr><th>From Following Year</th><td>{installments}</td></tr>
            </tbody>
          </table>
          <p style={{ marginTop: 10 }}>All payments are subject to the terms set forth in Section 5 of the MSA.</p>
        </div>

        <div className="contract-section"><h3>Key Exclusions</h3>
          <ul>
            <li>Personal tax return preparation</li>
            <li>Tax planning and advisory services</li>
            <li>Legal representation or legal advice</li>
            <li>Trademark or intellectual property registration</li>
            <li>Website development or marketing services</li>
            <li>Bookkeeping and accounting services (unless in separate SOW)</li>
            <li>State-specific filings outside of Florida</li>
            <li>Physical mail forwarding (shipping costs apply)</li>
            <li>Rush or expedited processing</li>
          </ul>
        </div>

        {/* SOW SIGNATURES */}
        <div className="contract-sig-section" style={{ marginTop: 40 }}>
          <h3 style={{ textAlign: 'center' }}>Statement of Work &mdash; Signatures</h3>
          <p className="contract-text-center contract-text-muted" style={{ marginBottom: 16, fontSize: '9.5pt' }}>By signing below, the Parties acknowledge that they have read, understood, and agree to the terms of this Statement of Work.</p>
          <div className="contract-sig-grid">
            <div className="contract-sig-block">
              <div className="contract-sig-label">Consulting Firm</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="contract-sig-static"><img src="/images/logo.jpg" alt="Tony Durante" style={{ maxHeight: 40, opacity: 0.8 }} /></div>
              <div className="contract-sig-field">Name: Tony Durante</div>
              <div className="contract-sig-field">Title: Managing Member</div>
              <div className="contract-sig-date">Date: {today()}</div>
            </div>
            <div className="contract-sig-block">
              <div className="contract-sig-label">Client</div>
              <div className="contract-sig-canvas-wrap">
                <canvas ref={sigSowRef} style={{ width: '100%', height: 120, display: 'block', borderRadius: 6 }} />
                <button className="contract-clear-btn" onClick={() => clearSig('sow')}>Clear</button>
              </div>
              <div className="contract-sig-field">Name: {form.name}</div>
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
      <div className="contract-action-bar" id="action-bar">
        <button className="contract-btn contract-btn-sign" onClick={signContract} disabled={!ready || signing}>
          {signing ? 'Generating PDF...' : 'Sign & Submit Contract'}
        </button>
        <div className={`contract-status-msg ${statusType === 'error' ? 'contract-error-msg' : statusType === 'success' ? 'contract-success-msg' : ''}`}>
          {statusMsg}
        </div>
      </div>
    </>
  )
}

// Form Row helper
function FormRow({ label, required, invalid, children }: { label: string; required?: boolean; invalid?: boolean; children: React.ReactNode }) {
  return (
    <tr>
      <th>{label}</th>
      <td className={`${required ? 'contract-required-field' : ''} ${invalid ? 'contract-field-invalid' : ''}`}>
        {children}
      </td>
    </tr>
  )
}

// Legal Sections 1-24 (static contract text)
function LegalSections() {
  return (
    <div id="legal-sections">
      <div className="contract-section"><h3>1. Purpose &amp; Structure</h3>
        <p>The Consulting Firm provides professional consulting services related to the formation, management, and ongoing compliance of U.S. Limited Liability Companies (&ldquo;LLCs&rdquo;) for international entrepreneurs and foreign nationals.</p>
        <p>This MSA governs the general terms and conditions of the business relationship between the Parties. Specific services, deliverables, and fees are set forth in one or more Statements of Work (&ldquo;SOW&rdquo;) attached hereto and incorporated by reference.</p></div>

      <div className="contract-section"><h3>2. Scope of Services</h3>
        <p>The Consulting Firm shall provide the services described in the applicable SOW, which may include but are not limited to:</p>
        <ul><li>LLC formation and state registration</li><li>EIN (Employer Identification Number) application with the IRS</li><li>Registered Agent services</li><li>Business bank account and payment processor setup assistance</li><li>Annual report filing and state compliance</li><li>Mail handling and forwarding from the U.S. business address</li><li>Ongoing administrative and operational support</li></ul>
        <p>Any services not explicitly listed in the SOW are outside the scope of this Agreement and may be subject to additional fees.</p></div>

      <div className="contract-section"><h3>3. Client Responsibilities</h3>
        <p>The Client agrees to:</p>
        <ol type="a"><li>Provide accurate, complete, and truthful information as required for LLC formation and ongoing services;</li><li>Respond to requests for information or documentation within five (5) business days;</li><li>Comply with all applicable U.S. federal, state, and local laws, as well as any laws of the Client&apos;s country of residence;</li><li>Maintain valid identification documents (passport) throughout the duration of this Agreement;</li><li>Notify the Consulting Firm promptly of any material changes in personal information, contact details, or business structure;</li><li>Not use the LLC or any services provided for illegal, fraudulent, or unethical purposes.</li></ol>
        <p>Failure to meet these responsibilities may result in delays, additional fees, or termination of this Agreement at the Consulting Firm&apos;s sole discretion.</p></div>

      <div className="contract-section"><h3>4. Communication &amp; Business Hours</h3>
        <div className="contract-subsection"><h4>4.1 Business Hours</h4><p>The Consulting Firm operates <strong>Monday through Friday, 8:00 AM to 3:00 PM Eastern Time (ET)</strong>, excluding U.S. federal holidays (&ldquo;Business Hours&rdquo;). Client communications received outside of Business Hours will be addressed on the next business day.</p></div>
        <div className="contract-subsection"><h4>4.2 Communication Channels</h4><p>Official communications between the Parties shall be conducted via:</p><ul><li><strong>Email:</strong> Primary channel for all business correspondence</li><li><strong>WhatsApp:</strong> For quick operational questions and updates</li><li><strong>Telegram:</strong> For quick operational questions and updates</li></ul><p>The Consulting Firm shall use reasonable efforts to respond within <strong>two (2) business days</strong>.</p></div>
        <div className="contract-subsection"><h4>4.3 Scheduled Calls</h4><p>Scheduled video or phone calls are available <strong>only when strictly necessary</strong>. A fee of <strong>$197.00 per call</strong> may apply for non-essential calls.</p></div></div>

      <div className="contract-section"><h3>5. Fees &amp; Payment</h3>
        <div className="contract-subsection"><h4>5.1 Annual Service Fee</h4><p>The Client shall pay the Annual Service Fee as specified in the Key Terms Summary and the applicable SOW.</p></div>
        <div className="contract-subsection"><h4>5.2 Payment Methods</h4><p>Payments may be made via:</p><ul><li><strong>Credit or debit card</strong> through the secure online checkout system;</li><li><strong>Bank wire transfer</strong> to the designated bank account.</li></ul></div>
        <div className="contract-subsection"><h4>5.3 Payment Schedule</h4><p>The payment schedule shall be as specified in the Key Terms Summary.</p></div>
        <div className="contract-subsection"><h4>5.4 Late Payment</h4><p>A late fee of <strong>1.5% per month</strong> shall accrue on unpaid balances. Services may be <strong>suspended after thirty (30) days</strong> past due.</p></div>
        <div className="contract-subsection"><h4>5.5 Refund Policy</h4><p><strong>All fees paid under this Agreement are non-refundable.</strong></p></div>
        <div className="contract-subsection"><h4>5.6 Additional Fees</h4><p>Services not included in the SOW may incur additional charges with advance notification.</p></div></div>

      <div className="contract-section"><h3>6. Third-Party Providers</h3><p>The Consulting Firm may engage third-party service providers. The Consulting Firm shall not be liable for the acts, omissions, or failures of any third-party provider.</p></div>

      <div className="contract-section"><h3>7. Mail Handling &amp; Forwarding</h3><p>The Consulting Firm shall receive, scan, and forward mail addressed to the Client&apos;s LLC at the U.S. registered business address within two (2) business days.</p></div>

      <div className="contract-section"><h3>8. Confidentiality</h3><p>Each Party agrees to maintain confidentiality of all proprietary, financial, and personal information. This obligation survives termination for three (3) years.</p></div>

      <div className="contract-section"><h3>9. Data Protection &amp; Privacy</h3><p>Personal data shall be processed solely for performing the Services. For EU/EEA residents, processing is based on Article 6(1)(b) GDPR.</p></div>

      <div className="contract-section"><h3>10. Tax Return Preparation</h3><p>If included in the SOW, the Consulting Firm shall arrange for preparation and filing of the LLC&apos;s annual U.S. tax return through a qualified third-party professional. The Client is solely responsible for providing accurate financial records.</p></div>

      <div className="contract-section"><h3>11. Contract Year &amp; Renewal</h3><p>The Contract Year runs <strong>January 1 through December 31</strong>. This Agreement shall <strong>automatically renew</strong> each year unless notice is provided by <strong>November 1</strong>. Clients onboarding after January 1 pay the full fee (no proration).</p></div>

      <div className="contract-section"><h3>12. Termination</h3>
        <div className="contract-subsection"><h4>12.1 By Client</h4><p>Written notice, effective thirty (30) days after receipt. No refund.</p></div>
        <div className="contract-subsection"><h4>12.2 By Consulting Firm</h4><p>Immediate termination for material breach, non-payment (30+ days), illegal conduct, or violation of Section 13.</p></div>
        <div className="contract-subsection"><h4>12.3 Effect</h4><p>Client remains liable for accrued fees. Sections 5.5, 8, 9, 15, 16, 17, and 20 survive termination.</p></div></div>

      <div className="contract-section"><h3>13. Client Conduct</h3><p>The Client shall conduct all interactions professionally. Immediate termination without refund may result from abusive behavior, unreasonable demands, false information, or illegal use.</p></div>

      <div className="contract-section"><h3>14. Intellectual Property</h3><p>All templates, processes, and systems remain the exclusive IP of Tony Durante LLC.</p></div>

      <div className="contract-section"><h3>15. Limitation of Liability</h3><p style={{ textTransform: 'uppercase', fontSize: '9.5pt' }}>Total liability shall not exceed fees paid in the preceding twelve (12) months. No liability for indirect, incidental, special, consequential, or punitive damages.</p></div>

      <div className="contract-section"><h3>16. Force Majeure</h3><p>Neither Party liable for failures beyond reasonable control (acts of God, pandemics, government actions, etc.).</p></div>

      <div className="contract-section"><h3>17. Indemnification</h3><p>The Client shall indemnify the Consulting Firm against claims arising from Client&apos;s breach, law violations, inaccurate information, illegal use, or third-party claims.</p></div>

      <div className="contract-section"><h3>18. Assignment</h3><p>Client may not assign without written consent. Consulting Firm may assign to successors.</p></div>

      <div className="contract-section"><h3>19. Independent Contractor</h3><p>The Consulting Firm is an independent contractor. No employment, partnership, or agency relationship is created.</p></div>

      <div className="contract-section"><h3>20. Governing Law &amp; Dispute Resolution</h3>
        <div className="contract-subsection"><h4>20.1</h4><p>Governed by <strong>Florida law</strong>.</p></div>
        <div className="contract-subsection"><h4>20.2</h4><p>Disputes resolved by: (a) mediation in <strong>Pinellas County, FL</strong>, then (b) binding arbitration under <strong>AAA rules</strong>. Prevailing party recovers attorneys&apos; fees.</p></div></div>

      <div className="contract-section"><h3>21. Electronic Signatures</h3><p>Electronic signatures are valid and binding under the <strong>ESIGN Act</strong> (15 U.S.C. &sect; 7001) and <strong>UETA</strong> (Fla. Stat. &sect; 668.50).</p></div>

      <div className="contract-section"><h3>22. Entire Agreement</h3><p>This Agreement and all SOWs constitute the entire agreement. No amendments unless in writing and signed by both Parties.</p></div>

      <div className="contract-section"><h3>23. Notices</h3><p>Formal notices via email (with confirmation) or certified mail. <strong>WhatsApp/Telegram do not constitute formal notice.</strong></p>
        <table className="contract-key-terms" style={{ marginTop: 12 }}>
          <tbody>
            <tr><th>Consulting Firm</th><td>Tony Durante LLC<br />10225 Ulmerton Road, Suite 3D<br />Largo, FL 33771<br />Email: support@tonydurante.us</td></tr>
            <tr><th>Client</th><td id="v-client-notice">To be completed upon signing</td></tr>
          </tbody>
        </table>
      </div>

      <div className="contract-section"><h3>24. Severability</h3><p>Invalid provisions shall be modified or severed; remaining provisions continue in full force.</p></div>
    </div>
  )
}

function ContractStyles() {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:wght@400;600;700&display=swap');
      :root { --c-primary:#1a1a2e; --c-accent:#c8a45a; --c-text:#2d2d2d; --c-light:#f8f7f4; --c-border:#d4d0c8; --c-muted:#6b6b6b; --c-green:#2d8a4e; --c-red:#c0392b; }
      body { font-family:'Source Serif 4',Georgia,serif !important; font-size:11pt !important; line-height:1.6 !important; color:var(--c-text) !important; background:#fff !important; max-width:8.5in; margin:0 auto !important; padding:40px 24px !important; }

      .contract-loading { text-align:center; padding:100px 20px; }
      .contract-spinner { width:40px; height:40px; border:3px solid var(--c-border); border-top-color:var(--c-accent); border-radius:50%; animation:cspin 1s linear infinite; margin:0 auto 16px; }
      @keyframes cspin { to { transform:rotate(360deg); } }
      .contract-error-box { max-width:500px; margin:80px auto; text-align:center; padding:40px; background:var(--c-light); border-radius:12px; }
      .contract-error-box h2 { color:var(--c-red); margin-bottom:12px; }

      .contract-header { text-align:center; padding-bottom:20px; border-bottom:3px solid var(--c-primary); margin-bottom:28px; }
      .contract-header img { max-height:55px; margin-bottom:10px; }
      .contract-header h1 { font-family:'Inter',sans-serif; font-size:18pt; font-weight:700; color:var(--c-primary); letter-spacing:1px; text-transform:uppercase; margin-bottom:2px; }
      .contract-subtitle { font-family:'Inter',sans-serif; font-size:10pt; color:var(--c-muted); font-weight:500; }

      .contract-part-divider { text-align:center; margin:36px 0 24px; }
      .contract-part-divider h2 { font-family:'Inter',sans-serif; font-size:14pt; font-weight:700; color:var(--c-primary); text-transform:uppercase; letter-spacing:2px; padding:12px 0; border-top:3px solid var(--c-primary); border-bottom:1px solid var(--c-border); }

      .contract-key-terms { width:100%; border-collapse:collapse; margin:20px 0; font-size:10pt; }
      .contract-key-terms caption { font-family:'Inter',sans-serif; font-weight:700; font-size:11pt; text-align:left; padding-bottom:6px; color:var(--c-primary); }
      .contract-key-terms th, .contract-key-terms td { padding:8px 12px; text-align:left; border:1px solid var(--c-border); }
      .contract-key-terms th { background:var(--c-light); font-family:'Inter',sans-serif; font-weight:600; font-size:9.5pt; width:35%; color:var(--c-primary); }

      .contract-section { margin:24px 0; }
      .contract-section h3 { font-family:'Inter',sans-serif; font-size:11pt; font-weight:700; color:var(--c-primary); margin-bottom:8px; padding-bottom:3px; border-bottom:1px solid var(--c-border); }
      .contract-section p, .contract-section li { margin-bottom:6px; text-align:justify; font-size:10.5pt; }
      .contract-section ol, .contract-section ul { margin-left:20px; margin-bottom:10px; }
      .contract-subsection { margin:12px 0; }
      .contract-subsection h4 { font-family:'Inter',sans-serif; font-size:10pt; font-weight:600; color:var(--c-text); margin-bottom:4px; }

      .contract-client-form { width:100%; border-collapse:collapse; margin:20px 0; }
      .contract-client-form th, .contract-client-form td { padding:6px 12px; text-align:left; border:1px solid var(--c-border); font-size:10pt; }
      .contract-client-form th { background:var(--c-light); font-family:'Inter',sans-serif; font-weight:600; width:30%; color:var(--c-primary); }
      .contract-client-form input { width:100%; border:none; background:transparent; font-family:inherit; font-size:10pt; padding:4px 0; outline:none; color:var(--c-text); }
      .contract-client-form input:focus { background:#fffde8; }
      .contract-client-form input::placeholder { color:var(--c-accent); font-style:italic; }
      .contract-required-field { background:#fff8f0; }
      .contract-field-invalid { background:#fef2f2 !important; }
      .contract-field-invalid input { color:var(--c-red); }
      .contract-field-hint { font-size:8pt; margin-top:2px; font-style:italic; }

      .contract-sig-section { margin-top:40px; page-break-inside:avoid; }
      .contract-sig-section h3 { font-family:'Inter',sans-serif; font-size:11pt; font-weight:700; color:var(--c-primary); margin-bottom:16px; }
      .contract-sig-grid { display:flex; gap:32px; flex-wrap:wrap; }
      .contract-sig-block { flex:1; min-width:280px; }
      .contract-sig-label { font-family:'Inter',sans-serif; font-size:8.5pt; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:var(--c-muted); margin-bottom:4px; }
      .contract-sig-canvas-wrap { border:1px solid var(--c-border); border-radius:6px; background:#fafaf8; position:relative; margin-bottom:4px; }
      .contract-clear-btn { position:absolute; top:4px; right:4px; background:var(--c-light); border:1px solid var(--c-border); border-radius:4px; padding:2px 8px; font-size:8pt; cursor:pointer; color:var(--c-muted); }
      .contract-clear-btn:hover { background:#fff; color:var(--c-red); }
      .contract-sig-field { font-size:8.5pt; color:var(--c-muted); margin-bottom:12px; }
      .contract-sig-static { border-bottom:1px solid var(--c-text); padding:8px 0; min-height:40px; margin-bottom:4px; }
      .contract-sig-static img { max-height:50px; }
      .contract-sig-date { font-family:'Inter',sans-serif; font-size:9pt; color:var(--c-text); margin-top:4px; }

      .contract-exhibit-box { border:2px dashed var(--c-border); padding:30px; text-align:center; margin:20px 0; min-height:120px; background:var(--c-light); border-radius:4px; cursor:pointer; transition:border-color .2s; }
      .contract-exhibit-box:hover { border-color:var(--c-accent); }
      .contract-exhibit-box p { color:var(--c-muted); font-style:italic; font-size:10pt; }
      .contract-uploaded-name { color:var(--c-green); font-weight:600; font-style:normal; }

      .contract-action-bar { position:sticky; bottom:0; background:#fff; border-top:2px solid var(--c-primary); padding:16px 0; text-align:center; z-index:100; margin-top:40px; }
      .contract-btn { display:inline-block; padding:14px 40px; border:none; border-radius:8px; font-family:'Inter',sans-serif; font-size:13pt; font-weight:700; cursor:pointer; transition:all .2s; }
      .contract-btn-sign { background:var(--c-green); color:#fff; }
      .contract-btn-sign:hover { background:#246e3d; }
      .contract-btn-sign:disabled { background:var(--c-border); color:var(--c-muted); cursor:not-allowed; }
      .contract-status-msg { font-size:10pt; color:var(--c-muted); margin-top:8px; }
      .contract-error-msg { color:var(--c-red) !important; }
      .contract-success-msg { color:var(--c-green) !important; font-weight:600; }

      .contract-success-panel { max-width:540px; margin:60px auto; text-align:center; padding:48px 32px; background:var(--c-light); border-radius:16px; border:2px solid var(--c-green); }
      .contract-success-icon { font-size:48pt; margin-bottom:16px; }
      .contract-success-panel h2 { font-family:'Inter',sans-serif; color:var(--c-green); font-size:20pt; margin-bottom:8px; }
      .contract-success-panel p { color:var(--c-muted); font-size:11pt; margin-bottom:20px; }
      .contract-bank-details-box { background:#fff; border:1px solid var(--c-border); border-radius:12px; padding:24px; text-align:left; margin:24px 0; }
      .contract-bank-details-box h3 { font-family:'Inter',sans-serif; font-size:11pt; color:var(--c-primary); margin-bottom:16px; text-align:center; text-transform:uppercase; letter-spacing:1px; border-bottom:none; }
      .contract-bank-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; font-size:10.5pt; }
      .contract-bank-row:last-child { border-bottom:none; }
      .contract-bank-label { color:var(--c-muted); }
      .contract-bank-value { font-weight:600; font-family:'Inter',monospace; letter-spacing:.5px; }
      .contract-bank-amount { text-align:center; font-size:18pt; font-weight:700; color:var(--c-primary); margin:16px 0 4px; }
      .contract-bank-ref { text-align:center; font-size:9pt; color:var(--c-muted); margin-bottom:12px; }
      .contract-success-link { display:inline-block; margin-top:20px; padding:12px 32px; background:var(--c-primary); color:#fff; text-decoration:none; border-radius:8px; font-family:'Inter',sans-serif; font-weight:600; font-size:10.5pt; }

      .contract-receipt-upload { margin:24px 0; padding:20px; background:#fff; border:1px solid var(--c-border); border-radius:12px; text-align:center; }
      .contract-receipt-upload h3 { font-family:'Inter',sans-serif; color:var(--c-primary); border-bottom:none; }
      .contract-receipt-drop { border:2px dashed var(--c-border); padding:24px; border-radius:8px; cursor:pointer; transition:border-color .2s; margin-bottom:12px; }
      .contract-receipt-drop:hover { border-color:var(--c-accent); }
      .contract-receipt-drop p { color:var(--c-muted); font-style:italic; font-size:10pt; margin:0; }
      .contract-receipt-btn { display:inline-block; padding:10px 28px; background:var(--c-green); color:#fff; border:none; border-radius:6px; font-family:'Inter',sans-serif; font-weight:600; font-size:10pt; cursor:pointer; transition:background .2s; }
      .contract-receipt-btn:hover { background:#246e3d; }
      .contract-receipt-btn:disabled { background:var(--c-border); color:var(--c-muted); cursor:not-allowed; }

      /* Choice buttons */
      .ps-choice-btn { display:flex; align-items:center; gap:16px; width:100%; padding:20px 24px; border-radius:14px; border:2px solid var(--c-border); background:#fff; text-decoration:none; color:var(--c-primary); cursor:pointer; transition:border-color .2s, box-shadow .2s; font-family:'Inter',sans-serif; }
      .ps-choice-btn:hover { border-color:var(--c-green); box-shadow:0 4px 16px rgba(34,197,94,.15); }
      .ps-choice-icon { font-size:24pt; flex-shrink:0; }
      .ps-choice-label { font-size:13pt; font-weight:700; flex:1; text-align:left; }
      .ps-choice-price { font-size:14pt; font-weight:800; font-family:'Source Code Pro','Courier New',monospace; }
      .ps-choice-badge { display:inline-block; background:var(--c-accent); color:#fff; padding:2px 10px; border-radius:20px; font-size:9pt; font-weight:700; margin-left:4px; }
      .ps-choice-card { border-color:var(--c-green); background:linear-gradient(135deg,#f0fdf4,#fff); }

      .post-sign-option { background:#fff; border:1px solid var(--c-border); border-radius:14px; padding:28px 24px; margin-bottom:8px; text-align:center; }
      .post-sign-option-label { font-family:'Inter',sans-serif; font-size:16pt; font-weight:700; margin-bottom:16px; color:var(--c-primary); }
      .post-sign-divider { display:flex; align-items:center; gap:16px; margin:16px 0; }
      .post-sign-divider::before, .post-sign-divider::after { content:''; flex:1; height:1px; background:var(--c-border); }
      .post-sign-divider span { font-family:'Inter',sans-serif; font-size:10pt; font-weight:700; letter-spacing:3px; color:var(--c-muted); }
      .post-sign-bank-amount { font-size:22pt; font-weight:800; color:var(--c-primary); margin-bottom:16px; }

      .contract-text-center { text-align:center; }
      .contract-text-muted { color:var(--c-muted); }
      .contract-text-small { font-size:8.5pt; }

      @media print { .contract-action-bar, .contract-clear-btn, .contract-exhibit-box input { display:none !important; } body { padding:0 !important; max-width:none !important; } .contract-sig-canvas-wrap { border:none; background:transparent; } }
      @media (max-width:600px) { body { padding:20px 12px !important; } .contract-sig-grid { flex-direction:column; } .contract-btn { width:100%; padding:16px; } }
    `}</style>
  )
}
