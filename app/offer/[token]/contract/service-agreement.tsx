'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { supabasePublic } from '@/lib/supabase/public-client'
import type { Offer } from '@/lib/types/offer'
import { SERVICE_CONTENT } from './standalone-service-agreement'

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
    successTitle: 'Contract Signed Successfully!',
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
    afterPayment: 'Once payment is received and verified, we will activate your services immediately.',
    backToOffer: '&larr; Back to Offer',
    signed: 'Contract signed and submitted! Tony Durante will contact you shortly.',
    uploaded: 'Uploaded',
  },
  it: {
    signing: 'Generazione PDF...',
    successTitle: 'Contratto Firmato con Successo!',
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
    afterPayment: 'Una volta ricevuto e verificato il pagamento, attiveremo i servizi immediatamente.',
    backToOffer: '&larr; Torna all&#39;Offerta',
    signed: 'Contratto firmato e inviato! Tony Durante ti contatterà a breve.',
    uploaded: 'Caricata',
  },
}

interface FormData {
  name: string; email: string; phone: string; address: string; city: string
  state: string; zip: string; country: string; nationality: string; passport: string
  passport_exp: string
}

interface Props {
  offer: Offer
  token: string
}

export default function ServiceAgreement({ offer, token: _token }: Props) {
  const cl = CL[offer.language || 'en']
  const [signing, setSigning] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Complete all required fields and sign both sections above.')
  const [statusType, setStatusType] = useState<'info' | 'error' | 'success'>('info')
  const [ready, setReady] = useState(false)
  const [form, setForm] = useState<FormData>({ name: offer.client_name || '', email: offer.client_email || '', phone: '', address: '', city: '', state: '', zip: '', country: '', nationality: '', passport: '', passport_exp: '' })
  const formRef = useRef<FormData>(form)
  useEffect(() => { formRef.current = form }, [form])

  const sigMsaRef = useRef<HTMLCanvasElement>(null)
  const sigSowRef = useRef<HTMLCanvasElement>(null)
  const addonSigRefs = useRef<Record<string, HTMLCanvasElement | null>>({})
  const sigPadsRef = useRef<Record<string, any>>({})
  const contractBodyRef = useRef<HTMLDivElement>(null)

  // Init signature pads
  useEffect(() => {
    const timer = setTimeout(() => { initSigPads() }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function initSigPads() {
    const SignaturePad = (await import('signature_pad')).default
    const canvases: Record<string, HTMLCanvasElement | null> = { msa: sigMsaRef.current, sow: sigSowRef.current }
    // Include addon signature canvases
    Object.entries(addonSigRefs.current).forEach(([key, canvas]) => {
      if (canvas) canvases[key] = canvas
    })
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

  const isValidPhone = (v: string) => /^\+\d[\d\s\-()]{6,20}$/.test(v)
  const isValidZip = (v: string) => /^\d{3,10}$/.test(v.replace(/\s/g, ''))

  const checkReady = useCallback(() => {
    const f = formRef.current
    const hasMSA = sigPadsRef.current.msa && !sigPadsRef.current.msa.isEmpty()
    const hasSOW = sigPadsRef.current.sow && !sigPadsRef.current.sow.isEmpty()
    const phoneOk = !f.phone || isValidPhone(f.phone)
    const zipOk = !f.zip || isValidZip(f.zip)
    // Check addon signatures
    const addonKeys = Object.keys(sigPadsRef.current).filter(k => k.startsWith('addon_'))
    const allAddonsSigned = addonKeys.every(k => sigPadsRef.current[k] && !sigPadsRef.current[k].isEmpty())
    const isReady = !!f.name && !!f.email && !!f.phone && !!f.address && !!f.zip && !!f.country && !!f.passport && hasMSA && hasSOW && allAddonsSigned && phoneOk && zipOk
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
      addonKeys.forEach(k => {
        if (!sigPadsRef.current[k] || sigPadsRef.current[k].isEmpty()) {
          const type = k.replace('addon_', '').replace('_', ' ')
          missing.push(`${type} agreement signature`)
        }
      })
      setStatusMsg('Missing: ' + missing.join(', '))
      setStatusType('info')
    } else {
      setStatusMsg('Ready to sign. Click the button below.')
      setStatusType('info')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { checkReady() }, [form, checkReady])

  function updateForm(field: keyof FormData, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  // Extract data
  const year = offer.offer_date ? new Date(offer.offer_date).getFullYear() : new Date().getFullYear()
  const effDate = today()

  // Calculate setup fee dynamically from MAIN contract services only
  const services = Array.isArray(offer.services) ? offer.services : []
  const selectedSet = new Set(Array.isArray((offer as any).selected_services) ? (offer as any).selected_services : [])
  const offerContractType = (offer as any).contract_type || 'onboarding'
  let totalSetup = 0
  let currencySymbol = 'EUR'
  for (const svc of services) {
    const isOpt = !!(svc as any).optional
    const isSelected = selectedSet.size > 0 ? (!isOpt || selectedSet.has(svc.name)) : !isOpt
    if (!isSelected) continue
    // Multi-contract: only count services belonging to main contract
    const svcCt = (svc as any).contract_type
    if (svcCt && svcCt !== offerContractType) continue
    const priceStr = String(svc.price || '0')
    if (/\/(year|anno|month|mese)/i.test(priceStr)) continue
    if (/includ|inclus/i.test(priceStr)) continue
    const priceNum = parseFloat(priceStr.replace(/[^0-9.]/g, ''))
    if (!isNaN(priceNum) && priceNum > 0) {
      totalSetup += priceNum
      if (/\$|usd/i.test(priceStr)) currencySymbol = '$'
      else if (/EUR/i.test(priceStr)) currencySymbol = 'EUR'
    }
  }
  const fee = totalSetup > 0
    ? `${currencySymbol}${totalSetup.toLocaleString('en-US', { minimumFractionDigits: 0 })}`
    : 'As specified in the offer'

  // Installments from recurring_costs — always English labels in contract
  const rc = Array.isArray(offer.recurring_costs) ? offer.recurring_costs : []
  const installmentLines: { label: string; amount: string }[] = []
  let annualFeeNum = 0
  for (let idx = 0; idx < rc.length; idx++) {
    const item = rc[idx]
    const amt = (item as any).amount || (item as any).price || ''
    const numAmt = parseFloat(String(amt).replace(/[^0-9.]/g, ''))
    // Normalize labels to English for the legal document
    const rawLabel = (item.label || '').toLowerCase()
    let engLabel: string
    const isTotal = rawLabel.includes('annual') || rawLabel.includes('total') || rawLabel.includes('annuale')
    if (rawLabel.includes('jan') || rawLabel.includes('genn')) engLabel = 'First Installment (January)'
    else if (rawLabel.includes('jun') || rawLabel.includes('giugno')) engLabel = 'Second Installment (June)'
    else if (isTotal) engLabel = 'Annual Total'
    else engLabel = idx === 0 ? 'First Installment' : idx === 1 ? 'Second Installment' : item.label || 'Additional'
    // Only sum installments, not the "Annual Total" summary line (avoids double-counting)
    if (!isNaN(numAmt) && !isTotal) annualFeeNum += numAmt
    installmentLines.push({ label: engLabel, amount: String(amt) })
  }

  // Services from offer — filter by client selections, exclude recurring, only main contract_type
  const servicesList = services
    .filter(svc => {
      const priceStr = String(svc.price || '')
      if (/\/(year|anno|month|mese)/i.test(priceStr)) return false
      const isOpt = !!(svc as any).optional
      if (isOpt && selectedSet.size > 0 && !selectedSet.has(svc.name)) return false
      // Multi-contract: only include services that belong to the main contract
      const svcCt = (svc as any).contract_type
      if (svcCt && svcCt !== offerContractType) return false
      return true
    })
    .map(svc => ({ name: svc.name || '', desc: svc.description || '', includes: svc.includes || [] }))

  // Addon services — services with a different contract_type that are selected
  const addonServices = services.filter(svc => {
    const svcCt = (svc as any).contract_type
    if (!svcCt || svcCt === offerContractType) return false
    if (!['itin', 'tax_return'].includes(svcCt)) return false
    const isOpt = !!(svc as any).optional
    if (isOpt && selectedSet.size > 0 && !selectedSet.has(svc.name)) return false
    return true
  })

  // LLC type
  let llcType = 'Single-Member LLC'
  if (offer.services && Array.isArray(offer.services)) {
    const allNames = offer.services.map(s => (s.name || '').toLowerCase()).join(' ')
    if (allNames.includes('multi')) llcType = 'Multi-Member LLC'
  }

  // Payment schedule text for Key Terms
  const paymentScheduleText = installmentLines.length > 0
    ? installmentLines.map(i => `${i.label}: ${i.amount}`).join(' — ')
    : fee

  // Sign contract
  async function signContract() {
    if (!offer || signing) return
    setSigning(true)
    setStatusMsg(cl.signing)
    setStatusType('info')

    try {
      const html2pdf = (await import('html2pdf.js')).default

      // Freeze form fields
      const formEl = document.getElementById('client-form-svc')
      if (formEl) {
        formEl.querySelectorAll('input').forEach(inp => {
          const td = inp.parentElement!
          const val = inp.value
          td.innerHTML = `<span style="font-weight:500">${esc(val)}</span>`
        })
      }

      // Replace canvases with images (MSA + SOW + addon agreements)
      ;['msa', 'sow'].forEach(id => {
        const canvas = id === 'msa' ? sigMsaRef.current : sigSowRef.current
        if (!canvas || !sigPadsRef.current[id]) return
        const wrap = canvas.parentElement!
        const dataUrl = sigPadsRef.current[id].toDataURL('image/png')
        wrap.innerHTML = `<img src="${dataUrl}" style="height:120px;display:block">`
      })
      // Replace addon signature canvases
      Object.entries(addonSigRefs.current).forEach(([key, canvas]) => {
        if (!canvas || !sigPadsRef.current[key]) return
        const wrap = canvas.parentElement!
        const dataUrl = sigPadsRef.current[key].toDataURL('image/png')
        wrap.innerHTML = `<img src="${dataUrl}" style="height:120px;display:block">`
      })

      // Hide action bar
      const actionBar = document.getElementById('action-bar-svc')
      if (actionBar) actionBar.style.display = 'none'
      document.querySelectorAll('.contract-clear-btn').forEach(b => (b as HTMLElement).style.display = 'none')

      // Generate PDF
      const element = contractBodyRef.current
      const opt = {
        margin: [0.5, 0.6, 0.7, 0.6] as [number, number, number, number],
        filename: `Tony_Durante_Service_Agreement_${offer.token}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      }
      const pdfBlob = await (html2pdf() as any).set(opt).from(element).outputPdf('blob')

      // Upload PDF
      setStatusMsg('Uploading signed contract...')
      const pdfPath = `${offer.token}/service-agreement-signed-${Date.now()}.pdf`
      await fetch(`${SB_URL}/storage/v1/object/signed-contracts/${pdfPath}`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`, 'Content-Type': 'application/pdf' },
        body: pdfBlob
      })

      // Save contract record
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
        llc_type: llcType.includes('Multi') ? 'MMLLC' : 'SMLLC',
        annual_fee: annualFeeNum > 0 ? annualFeeNum.toString() : null,
        contract_year: year.toString(),
        installments: installmentLines.length >= 2
          ? JSON.stringify({ jan: parseFloat(String(installmentLines[0].amount).replace(/[^0-9.]/g, '')), jun: parseFloat(String(installmentLines[1].amount).replace(/[^0-9.]/g, '')) })
          : null,
      }
      await supabasePublic.from('contracts').insert(contractData)

      // Update offer status
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { error: pErr } = await supabasePublic.from('offers').update({ status: 'signed' }).eq('token', offer.token)
          if (!pErr) break
        } catch { /* retry */ }
      }

      // Notify backend
      try {
        await fetch('/api/webhooks/offer-signed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offer_token: offer.token })
        })
      } catch (e) {
        console.warn('[service-agreement] Failed to notify offer-signed webhook:', e)
      }

      // Post-sign: show payment options — ensure real bank details (replace placeholders)
      const { ensureBankDetails } = await import('./bank-defaults')
      const bankDetails = offer.bank_details
        ? ensureBankDetails(offer.bank_details as Record<string, string>, offer.cost_summary as unknown[])
        : null
      const hasCard = offer.payment_links && offer.payment_links.length > 0
      const hasBank = !!bankDetails
      const successEl = document.getElementById('success-state-svc')

      if ((hasCard || hasBank) && successEl && contractBodyRef.current) {
        contractBodyRef.current.style.display = 'none'
        let sh = '<div class="contract-success-panel"><div class="contract-success-icon">&#10004;</div>'
        sh += `<h2>${cl.successTitle}</h2>`
        sh += `<p style="font-size:12pt;margin-bottom:28px;">${cl.choosePayment}</p>`
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
          sh += `<span class="ps-choice-price">${esc(bankDetails!.amount || '')}</span>`
          sh += '</button>'
        }
        sh += '</div>'

        if (hasBank) {
          const b = bankDetails!
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
          sh += '<div class="contract-receipt-upload">'
          sh += `<h3 style="font-size:11pt;margin-bottom:8px;">${cl.receiptTitle}</h3>`
          sh += `<p style="font-size:9.5pt;color:var(--c-muted);margin-bottom:12px;">${cl.receiptDesc}</p>`
          sh += '<div class="contract-receipt-drop" id="receipt-drop" onclick="document.getElementById(\'receipt-input\').click()">'
          sh += '<input type="file" id="receipt-input" accept="image/*,.pdf" style="display:none" />'
          sh += `<p id="receipt-label">${cl.receiptLabel}</p>`
          sh += '</div>'
          sh += `<button id="receipt-submit" class="contract-receipt-btn" disabled>${cl.receiptBtn}</button>`
          sh += '<div id="receipt-status" style="font-size:9pt;margin-top:8px;"></div>'
          sh += '</div></div></div>'
        }

        sh += `<p style="font-size:9.5pt;color:var(--c-muted);margin-top:24px;">${cl.afterPayment}</p>`
        sh += `<a href="/offer/${encodeURIComponent(offer.token)}" class="contract-success-link">${cl.backToOffer}</a>`
        sh += '</div>'
        successEl.innerHTML = sh
        successEl.style.display = 'block'

        if (hasBank) {
          document.getElementById('choose-bank')?.addEventListener('click', () => {
            const choiceEl = document.getElementById('payment-choice')
            const bankEl = document.getElementById('bank-panel')
            if (choiceEl) choiceEl.style.display = 'none'
            if (bankEl) bankEl.style.display = 'block'
          })

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
      const actionBar = document.getElementById('action-bar-svc')
      if (actionBar) actionBar.style.display = 'block'
    }
  }

  const phoneInvalid = form.phone && !isValidPhone(form.phone)
  const zipInvalid = form.zip && !isValidZip(form.zip)

  return (
    <>
      <div id="success-state-svc" style={{ display: 'none' }} />

      <div id="contract-body-svc" ref={contractBodyRef}>
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
            <tr><th>Setup Fee</th><td>{fee} (one-time, covers all services for the first contract year)</td></tr>
            <tr><th>Payment Schedule</th><td>Setup fee due upon signing. From the following year: {paymentScheduleText}</td></tr>
            <tr><th>Cancellation Deadline</th><td>Written notice must be received no later than November 1 of the current Contract Year to prevent automatic renewal.</td></tr>
          </tbody>
        </table>

        {/* CLIENT FORM */}
        <table className="contract-client-form" id="client-form-svc">
          <caption style={{ fontFamily: "'Inter',sans-serif", fontWeight: 700, fontSize: '11pt', textAlign: 'left', paddingBottom: 6, color: 'var(--c-primary)' }}>Client Information</caption>
          <tbody>
            <FormRow label="Full Legal Name"><input type="text" value={form.name} onChange={e => updateForm('name', e.target.value)} placeholder="Enter your full legal name" /></FormRow>
            <FormRow label="Residential Address" required><input type="text" value={form.address} onChange={e => updateForm('address', e.target.value)} placeholder="Street address" /></FormRow>
            <FormRow label="City"><input type="text" value={form.city} onChange={e => updateForm('city', e.target.value)} placeholder="City" /></FormRow>
            <FormRow label="State / Province"><input type="text" value={form.state} onChange={e => updateForm('state', e.target.value)} placeholder="State or province" /></FormRow>
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
            <FormRow label="Nationality"><input type="text" value={form.nationality} onChange={e => updateForm('nationality', e.target.value)} placeholder="Nationality" /></FormRow>
            <FormRow label="Passport Number" required><input type="text" value={form.passport} onChange={e => updateForm('passport', e.target.value)} placeholder="Passport number" /></FormRow>
            <FormRow label="Passport Expiration"><input type="text" value={form.passport_exp} onChange={e => updateForm('passport_exp', e.target.value)} placeholder="MM/YYYY" /></FormRow>
          </tbody>
        </table>

        {/* LEGAL SECTIONS 1-24 — Same as MSA */}
        <LegalSections />

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

        {/* PART 2 — SOW (Management Services — NO Formation) */}
        <div className="contract-part-divider" style={{ marginTop: 48 }}><h2>Part 2 — Statement of Work</h2></div>

        <p>This Statement of Work (&ldquo;SOW&rdquo;) is entered into pursuant to the Master Service Agreement dated <strong>{effDate}</strong> between Tony Durante LLC (&ldquo;Consulting Firm&rdquo;) and <strong>{form.name || '[Client Name]'}</strong> (&ldquo;Client&rdquo;).</p>

        <table className="contract-key-terms" style={{ marginTop: 20 }}>
          <caption>SOW Details</caption>
          <tbody>
            <tr><th>Contract Year</th><td>{year} (January 1 - December 31)</td></tr>
            <tr><th>LLC Type</th><td>{llcType}</td></tr>
            <tr><th>Setup Fee</th><td>{fee}</td></tr>
          </tbody>
        </table>

        <div className="contract-section"><h3>Included Services</h3>
          <p>The following services are included in the Setup Fee:</p>
          <ol>
            {servicesList.map((svc, i) => (
              <li key={i}>
                <strong>{svc.name}</strong>
                {svc.desc ? ` — ${svc.desc}` : ''}
                {svc.includes && svc.includes.length > 0 && (
                  <ul style={{ marginTop: 4 }}>
                    {svc.includes.map((inc: string, j: number) => <li key={j}>{inc}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>

        {/* CLIENT PORTAL SECTION */}
        <div className="contract-section">
          <h3>Client Portal</h3>
          <p>The Client will have access to the Client Portal at <strong>portal.tonydurante.us</strong>, which provides the following features:</p>

          <div className="contract-subsection">
            <h4>LLC Management</h4>
            <ul>
              <li><strong>Company documents</strong> &mdash; Articles of Organization, Operating Agreement, EIN Letter, and Lease Agreement always available</li>
              <li><strong>Service tracking</strong> &mdash; Real-time progress on all active services</li>
              <li><strong>Document signing</strong> &mdash; Operating Agreement, Lease, SS-4 signed directly online</li>
              <li><strong>Deadlines</strong> &mdash; Calendar with Annual Report, Registered Agent Renewal, Tax Filing dates</li>
              <li><strong>Tax documents</strong> &mdash; Upload bank statements, view filed returns</li>
              <li><strong>Document generation</strong> &mdash; Distribution Resolutions, Tax Statements on demand</li>
            </ul>
          </div>

          <div className="contract-subsection">
            <h4>Business Tools</h4>
            <ul>
              <li><strong>Invoicing</strong> &mdash; Create and send invoices to your LLC clients</li>
              <li><strong>Client management</strong> &mdash; Mini-CRM for your LLC clients</li>
              <li><strong>Payments</strong> &mdash; View invoices and payment history</li>
              <li><strong>Request services</strong> &mdash; Order new services with one click</li>
            </ul>
          </div>

          <div className="contract-subsection">
            <h4>Communication &mdash; Portal Chat Required</h4>
            <p>All day-to-day communications shall be conducted through the portal chat. The Client agrees to use the portal chat instead of WhatsApp, Telegram, or other messaging platforms for the following reasons:</p>
            <ul>
              <li><strong>Security</strong> &mdash; WhatsApp shares metadata with Meta (Facebook). The portal is private and protected.</li>
              <li><strong>Compliance</strong> &mdash; Professional firms are required to track and archive all client communications.</li>
              <li><strong>Organization</strong> &mdash; Documents, messages, signatures, and forms are linked to your profile. No files lost.</li>
              <li><strong>Faster responses</strong> &mdash; The team sees which matter the message relates to.</li>
              <li><strong>Voice dictation</strong> &mdash; Press the microphone icon, dictate your message. The portal transcribes automatically.</li>
            </ul>
          </div>

          <div className="contract-subsection">
            <h4>Mobile App</h4>
            <p>The portal can be installed as an app on your phone and computer with push notifications:</p>
            <ul>
              <li><strong>iPhone / iPad:</strong> Safari &rarr; Share &rarr; Add to Home Screen</li>
              <li><strong>Android:</strong> Chrome &rarr; Menu &rarr; Install app</li>
              <li><strong>Desktop:</strong> Chrome &rarr; Install icon in address bar</li>
            </ul>
          </div>
        </div>

        <div className="contract-section"><h3>Payment Schedule</h3>
          <table className="contract-key-terms">
            <tbody>
              <tr><th>Setup Fee</th><td>{fee} (one-time, due upon signing)</td></tr>
              {installmentLines.length >= 2 && (
                <tr><th>Annual Maintenance (from following year)</th><td>{installmentLines.map((inst, i) => <span key={i}>{i > 0 && <br />}&bull; {inst.label}: {inst.amount}</span>)}</td></tr>
              )}
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

        {/* ADDON STANDALONE AGREEMENTS — rendered inline for multi-contract offers */}
        {addonServices.map((svc) => {
          const svcCt = (svc as any).contract_type as 'itin' | 'tax_return'
          const ct = SERVICE_CONTENT[svcCt]
          if (!ct) return null
          const addonKey = `addon_${svcCt}`
          const svcFee = svc.price || ''
          return (
            <div key={addonKey} style={{ pageBreakBefore: 'always', marginTop: 48 }}>
              <div className="contract-part-divider"><h2>{ct.title}</h2></div>

              <p>This {ct.shortTitle} (&ldquo;<strong>Agreement</strong>&rdquo;) is entered into as of <strong>{today()}</strong>, by and between:</p>
              <p style={{ margin: '14px 0' }}><strong>Tony Durante LLC</strong>, a Florida limited liability company (&ldquo;<strong>Service Provider</strong>&rdquo;), and</p>
              <p style={{ margin: '14px 0' }}><strong>{form.name || '[Client Name]'}</strong> (&ldquo;<strong>Client</strong>&rdquo;).</p>

              <table className="contract-key-terms">
                <caption>Service Summary</caption>
                <tbody>
                  <tr><th>Service</th><td>{svc.name}</td></tr>
                  {svc.description && <tr><th>Description</th><td>{svc.description}</td></tr>}
                  <tr><th>Fee</th><td>{svcFee} (one-time)</td></tr>
                  {svc.includes && svc.includes.length > 0 && (
                    <tr><th>Includes</th><td>{(svc.includes as string[]).map((item, i) => <span key={i}>{item}{i < svc.includes!.length - 1 ? ', ' : ''}</span>)}</td></tr>
                  )}
                </tbody>
              </table>

              <div className="contract-section">
                <h3>1. Scope of Service</h3>
                <p>{ct.scope.intro}</p>
                <ul>{ct.scope.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
                <p><strong>{ct.scope.closing}</strong></p>
              </div>

              <div className="contract-section">
                <h3>2. Client Responsibilities</h3>
                <p>{ct.clientDuties.intro}</p>
                <ol type="a">{ct.clientDuties.items.map((item, i) => <li key={i}><strong>{item.bold}</strong>{item.rest}</li>)}</ol>
              </div>

              <div className="contract-section">
                <h3>3. Service Procedure</h3>
                <p>{ct.procedure.intro}</p>
                <ol>{ct.procedure.steps.map((step, i) => <li key={i}><strong>{step.title}</strong> &mdash; {step.desc}</li>)}</ol>
              </div>

              <div className="contract-section">
                <h3>4. Service Provider Commitments</h3>
                <p>The Service Provider agrees to:</p>
                <ol type="a">{ct.commitments.map((item, i) => <li key={i}>{item}</li>)}</ol>
              </div>

              <div className="contract-section">
                <h3>5. Payment</h3>
                <p>The total fee for this service is <strong>{svcFee}</strong>, payable in full before services begin. Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.</p>
                <p><strong>All fees are non-refundable</strong> once services have commenced.</p>
              </div>

              <div className="contract-section">
                <h3>6. Limitation of Liability</h3>
                <p>The Service Provider&rsquo;s total liability under this Agreement shall not exceed the fee paid by the Client.</p>
              </div>

              <div className="contract-section">
                <h3>7. Governing Law</h3>
                <p>This Agreement is governed by the laws of the State of Florida. Any disputes shall be resolved through binding arbitration in Pinellas County, Florida, under AAA rules.</p>
              </div>

              <div className="contract-section">
                <h3>8. Electronic Signatures</h3>
                <p>Electronic signatures on this Agreement are valid and binding under the ESIGN Act (15 U.S.C. &sect; 7001) and UETA (Fla. Stat. &sect; 668.50).</p>
              </div>

              <div className="contract-sig-section">
                <h3 style={{ textAlign: 'center' }}>{ct.shortTitle} &mdash; Signature</h3>
                <p className="contract-text-center contract-text-muted" style={{ marginBottom: 16, fontSize: '9.5pt' }}>{ct.signatureText}</p>
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
                      <canvas
                        ref={el => { addonSigRefs.current[addonKey] = el }}
                        style={{ width: '100%', height: 120, display: 'block', borderRadius: 6 }}
                      />
                      <button className="contract-clear-btn" onClick={() => clearSig(addonKey)}>Clear</button>
                    </div>
                    <div className="contract-sig-field">Name: {form.name}</div>
                    <div className="contract-sig-date">Date: {today()}</div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}

        {/* FOOTER */}
        <div className="contract-text-center" style={{ marginTop: 36, paddingTop: 20, borderTop: '1px solid var(--c-border)' }}>
          <p className="contract-text-muted contract-text-small">Tony Durante LLC &bull; 10225 Ulmerton Road, Suite 3D &bull; Largo, FL 33771</p>
          <p className="contract-text-muted contract-text-small">support@tonydurante.us &bull; www.tonydurante.us</p>
        </div>
      </div>

      {/* ACTION BAR */}
      <div className="contract-action-bar" id="action-bar-svc">
        <button className="contract-btn contract-btn-sign" onClick={signContract} disabled={!ready || signing}>
          {signing ? 'Generating PDF...' : `Sign${addonServices.length > 0 ? ` All (${2 + addonServices.length} Agreements)` : ''} & Submit Contract`}
        </button>
        <div className={`contract-status-msg ${statusType === 'error' ? 'contract-error-msg' : statusType === 'success' ? 'contract-success-msg' : ''}`}>
          {statusMsg}
        </div>
      </div>
    </>
  )
}

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

// Legal Sections 1-24 — identical to MSA
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
        <div className="contract-subsection"><h4>4.2 Communication Channels</h4><p>Official communications between the Parties shall be conducted via:</p><ul><li><strong>Email:</strong> Primary channel for all business correspondence</li><li><strong>Client Portal Chat:</strong> For operational questions, updates, and day-to-day communication. Available at portal.tonydurante.us with voice dictation support</li></ul><p>The Consulting Firm shall use reasonable efforts to respond within <strong>two (2) business days</strong>.</p></div>
        <div className="contract-subsection"><h4>4.3 Scheduled Calls</h4><p>Scheduled video or phone calls are available <strong>only when strictly necessary</strong>. A fee of <strong>$197.00 per call</strong> may apply for non-essential calls.</p></div></div>

      <div className="contract-section"><h3>5. Fees &amp; Payment</h3>
        <div className="contract-subsection"><h4>5.1 Service Fees</h4><p>The Client shall pay the Setup Fee and any applicable Annual Maintenance Fee as specified in the Key Terms Summary and the applicable SOW.</p></div>
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

      <div className="contract-section"><h3>23. Notices</h3><p>Formal notices via email (with confirmation) or certified mail. <strong>Portal chat messages do not constitute formal notice.</strong></p>
        <table className="contract-key-terms" style={{ marginTop: 12 }}>
          <tbody>
            <tr><th>Consulting Firm</th><td>Tony Durante LLC<br />10225 Ulmerton Road, Suite 3D<br />Largo, FL 33771<br />Email: support@tonydurante.us</td></tr>
            <tr><th>Client</th><td>To be completed upon signing</td></tr>
          </tbody>
        </table>
      </div>

      <div className="contract-section"><h3>24. Severability</h3><p>Invalid provisions shall be modified or severed; remaining provisions continue in full force.</p></div>
    </div>
  )
}
