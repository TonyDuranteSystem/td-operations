'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabasePublic } from '@/lib/supabase/public-client'
import type { Offer } from '@/lib/types/offer'

// ─── Bilingual Labels ───────────────────────────────────────

const LABELS = {
  en: {
    title: 'Consulting Proposal',
    subtitle: 'Business Consulting',
    preparedFor: 'Prepared for',
    date: 'Date',
    issues: 'Issues Identified',
    issuesIntro: 'During our consultation, the following situations emerged that require priority attention:',
    immediateActions: 'Recommended Immediate Actions',
    strategy: 'Our Strategy',
    services: 'Proposed Services',
    servicesIntro: 'Based on your situation, you can choose between the following options.',
    recommended: 'RECOMMENDED',
    includes: 'INCLUDES:',
    costSummary: 'Cost Summary',
    total: 'Total',
    recurringCosts: 'Annual Costs',
    futureDevelopments: 'Future Developments',
    futureDevelopmentsIntro: 'Once operational with the new structure, we can discuss next steps:',
    nextSteps: 'Next Steps',
    readyToStart: 'Ready to Start?',
    contractSigned: 'Contract signed successfully!',
    proceedPayment: 'Proceed with payment to start the collaboration.',
    proceedWire: 'Proceed with the wire transfer to start the collaboration.',
    reviewAndSign: 'Review and sign the contract to confirm the collaboration.',
    acceptAndSign: 'Accept & Sign Contract',
    afterSignature: 'After signing you will be guided to payment',
    questions: 'Have questions? Contact us before proceeding.',
    contactWhatsApp: 'Contact us on WhatsApp',
    paymentSecure: 'Secure and encrypted transaction',
    paymentNote: 'Secure payment via credit card, Apple Pay or Bancontact',
    bankDetails: 'Bank Details',
    beneficiary: 'Beneficiary',
    iban: 'IBAN',
    bic: 'BIC/SWIFT',
    bank: 'Bank',
    accountNumber: 'Account Number',
    routingNumber: 'Routing Number',
    bankAddress: 'Address',
    reference: 'Reference',
    expired: 'Offer Expired',
    expiredMessage: 'This offer is no longer available. Contact Tony Durante for a new proposal.',
    invalidLink: 'Invalid Link',
    invalidLinkMessage: 'This link does not contain a valid reference.',
    notFound: 'Offer Not Found',
    loading: 'Loading offer...',
    emailGateTitle: 'Verify Your Identity',
    emailGateMessage: 'Enter the email address associated with this proposal to view it.',
    emailGateButton: 'View Proposal',
    emailGateError: 'The email address does not match. Please try again.',
    emailPlaceholder: 'your@email.com',
    contactPayment: 'Contact us on WhatsApp to proceed with payment.',
    payByCard: 'Pay by Card',
    payByTransfer: 'Bank Transfer',
  },
  it: {
    title: 'Offerta Consulenziale',
    subtitle: 'Business Consulting',
    preparedFor: 'Preparata per',
    date: 'Data',
    issues: 'Criticità Identificate',
    issuesIntro: 'Durante la nostra call sono emerse alcune situazioni da risolvere con priorità:',
    immediateActions: 'Azioni Immediate Consigliate',
    strategy: 'La Strategia',
    services: 'Servizi Proposti',
    servicesIntro: 'In base alla vostra situazione, potete scegliere tra le opzioni seguenti.',
    recommended: 'CONSIGLIATO',
    includes: 'INCLUDE:',
    costSummary: 'Riepilogo Costi',
    total: 'Totale',
    recurringCosts: 'Costi Annuali',
    futureDevelopments: 'Sviluppi Futuri',
    futureDevelopmentsIntro: 'Una volta operativi con la nuova struttura, possiamo ragionare su passi successivi:',
    nextSteps: 'Prossimi Passi',
    readyToStart: 'Pronto a Partire?',
    contractSigned: 'Contratto firmato con successo!',
    proceedPayment: 'Procedi con il pagamento per avviare la collaborazione.',
    proceedWire: 'Procedi con il bonifico bancario per avviare la collaborazione.',
    reviewAndSign: 'Rivedi e firma il contratto per confermare la collaborazione.',
    acceptAndSign: 'Accetta e Firma Contratto',
    afterSignature: 'Dopo la firma verrai guidato al pagamento',
    questions: 'Hai domande? Contattaci prima di procedere.',
    contactWhatsApp: 'Contattaci su WhatsApp',
    paymentSecure: 'Transazione protetta e crittografata',
    paymentNote: 'Pagamento sicuro tramite carta di credito, Apple Pay o Bancontact',
    bankDetails: 'Coordinate Bancarie',
    beneficiary: 'Beneficiario',
    iban: 'IBAN',
    bic: 'BIC/SWIFT',
    bank: 'Banca',
    accountNumber: 'Numero Conto',
    routingNumber: 'Routing Number',
    bankAddress: 'Indirizzo',
    reference: 'Causale',
    expired: 'Offerta Scaduta',
    expiredMessage: 'Questa offerta non è più disponibile. Contatta Tony Durante per una nuova proposta.',
    invalidLink: 'Link non valido',
    invalidLinkMessage: 'Questo link non contiene un riferimento valido.',
    notFound: 'Offerta non trovata',
    loading: 'Caricamento offerta...',
    emailGateTitle: 'Verifica la tua identità',
    emailGateMessage: 'Inserisci l\'indirizzo email associato a questa proposta per visualizzarla.',
    emailGateButton: 'Visualizza Proposta',
    emailGateError: 'L\'indirizzo email non corrisponde. Riprova.',
    emailPlaceholder: 'tua@email.com',
    contactPayment: 'Contattaci su WhatsApp per procedere con il pagamento.',
    payByCard: 'Paga con Carta',
    payByTransfer: 'Bonifico Bancario',
  },
}

// ─── Helpers ────────────────────────────────────────────────

function formatDate(d: string, lang: 'en' | 'it') {
  const date = new Date(d)
  const monthsEn = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const monthsIt = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']
  const months = lang === 'en' ? monthsEn : monthsIt
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

function calcSurcharge(amountStr: string, pct: number = 5): string {
  const currency = amountStr.match(/^[^0-9]*/)?.[0] || '$'
  const num = parseFloat(amountStr.replace(/[^0-9.]/g, ''))
  if (isNaN(num)) return amountStr
  const total = Math.round(num * (1 + pct / 100))
  return `${currency}${total.toLocaleString()}`
}

const COOKIE_NAME = 'offer_verified'

function setVerifiedCookie(token: string) {
  document.cookie = `${COOKIE_NAME}_${token}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Strict`
}

function hasVerifiedCookie(token: string): boolean {
  return document.cookie.includes(`${COOKIE_NAME}_${token}=1`)
}

// ─── Component ──────────────────────────────────────────────

export default function OfferPageWithCode() {
  const { token, code } = useParams<{ token: string; code: string }>()
  const searchParams = useSearchParams()
  const accessCode = code
  const isPreview = searchParams.get('preview') === '1'

  const [offer, setOffer] = useState<Offer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [verified, setVerified] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [emailError, setEmailError] = useState(false)
  const [lang, setLang] = useState<'en' | 'it'>('it')
  const [selectedOptional, setSelectedOptional] = useState<Set<string>>(new Set())

  const L = LABELS[lang]

  const loadOffer = useCallback(async () => {
    try {
      const { data, error: err } = await supabasePublic
        .from('offers')
        .select('*')
        .eq('token', token)
        .single()

      if (err || !data) { setError('not_found'); setLoading(false); return }

      let o = data as Offer

      // Safeguard: parse JSONB fields that may be stored as strings
      const jsonFields = ['issues', 'immediate_actions', 'strategy', 'services', 'additional_services', 'cost_summary', 'recurring_costs', 'future_developments', 'next_steps', 'payment_links'] as const
      for (const f of jsonFields) {
        const val = (o as any)[f]
        if (typeof val === 'string') {
          try { (o as any)[f] = JSON.parse(val) } catch { (o as any)[f] = [] }
        }
      }

      // Check access code
      if (o.access_code && accessCode && o.access_code !== accessCode) {
        setError('not_found')
        setLoading(false)
        return
      }

      if (o.expires_at && new Date(o.expires_at) < new Date()) {
        o = { ...o, status: 'expired' }
      }

      setOffer(o)
      setLang(o.language || 'it')
      setLoading(false)

      // Pre-select recommended optional services
      const recommended = new Set<string>()
      o.services?.forEach(sv => {
        if ((sv as any).optional && (sv as any).recommended) recommended.add(sv.name)
      })
      if (recommended.size > 0) setSelectedOptional(recommended)

      // Check if already verified via cookie, admin preview, or valid access code in URL
      const hasValidCode = !!(accessCode && o.access_code && accessCode === o.access_code)
      if (hasVerifiedCookie(token) || isPreview || hasValidCode) {
        setVerified(true)
        if (hasValidCode) setVerifiedCookie(token) // persist for page reloads
      }

      // Track view (only once verified or no email gate needed)
      if (hasVerifiedCookie(token) || !o.client_email || isPreview || hasValidCode) {
        trackView(o)
      }
    } catch {
      setError('load_error')
      setLoading(false)
    }
  }, [token, accessCode])

  function trackView(o: Offer) {
    supabasePublic
      .from('offers')
      .update({
        view_count: (o.view_count || 0) + 1,
        viewed_at: new Date().toISOString(),
        status: o.status === 'draft' || o.status === 'sent' ? 'viewed' : o.status,
      })
      .eq('id', o.id)
      .then(() => {})
  }

  function handleEmailVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!offer) return
    if (emailInput.toLowerCase().trim() === (offer.client_email || '').toLowerCase().trim()) {
      setVerified(true)
      setEmailError(false)
      setVerifiedCookie(token)
      trackView(offer)
    } else {
      setEmailError(true)
    }
  }

  useEffect(() => {
    if (!token) { setError('invalid_link'); setLoading(false); return }
    loadOffer()
    // Prevent copy/print
    const handler = (e: Event) => e.preventDefault()
    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [token, loadOffer])

  // Set document title and lang
  useEffect(() => {
    if (offer) {
      document.title = lang === 'en'
        ? `Proposal for ${offer.client_name} — Tony Durante LLC`
        : `Offerta per ${offer.client_name} — Tony Durante LLC`
      document.documentElement.lang = lang
    }
  }, [offer, lang])

  if (loading) return (
    <>
      <OfferStyles />
      <div className="offer-loading"><div className="offer-loading-spinner" /><span>{L.loading}</span></div>
    </>
  )

  if (error) {
    const errorL = LABELS[lang]
    return (
      <>
        <OfferStyles />
        <div className="offer-error-page"><div>
          <h1>{error === 'invalid_link' ? errorL.invalidLink : errorL.notFound}</h1>
          <p>{error === 'invalid_link' ? errorL.invalidLinkMessage : errorL.notFound}</p>
        </div></div>
      </>
    )
  }

  if (!offer) return null

  // Email verification gate
  if (!verified && offer.client_email) {
    return (
      <>
        <OfferStyles />
        <div className="offer-gate">
          <div className="offer-gate-box">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/logo.jpg" alt="Tony Durante LLC" className="offer-gate-logo" />
            <h2>{L.emailGateTitle}</h2>
            <p>{L.emailGateMessage}</p>
            <form onSubmit={handleEmailVerify}>
              <input
                type="email"
                value={emailInput}
                onChange={(e) => { setEmailInput(e.target.value); setEmailError(false) }}
                placeholder={L.emailPlaceholder}
                className={`offer-gate-input${emailError ? ' offer-gate-input-error' : ''}`}
                required
                autoFocus
              />
              {emailError && <div className="offer-gate-error-msg">{L.emailGateError}</div>}
              <button type="submit" className="offer-gate-btn">{L.emailGateButton}</button>
            </form>
          </div>
        </div>
      </>
    )
  }

  const o = offer
  const isSigned = o.status === 'signed' || o.status === 'completed'
  const ptype = o.payment_type || 'none'

  return (
    <>
      <OfferStyles />

      {o.status === 'expired' && (
        <div className="offer-expired-overlay">
          <div className="offer-expired-box">
            <h2>{L.expired}</h2>
            <p>{L.expiredMessage}</p>
          </div>
        </div>
      )}

      <div className="offer-container">
        <div className="offer-header-bar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo.jpg" alt="Tony Durante LLC" className="offer-logo-img" />
        </div>

        <div className="offer-hero">
          <div className="offer-hero-label">{L.subtitle}</div>
          <h1>{L.title}</h1>
          <div className="offer-hero-meta">
            <div><div className="offer-hero-meta-item">{L.preparedFor}</div><div className="offer-hero-meta-value">{o.client_name || ''}</div></div>
            <div><div className="offer-hero-meta-item">{L.date}</div><div className="offer-hero-meta-value">{formatDate(o.offer_date, lang)}</div></div>
          </div>
          <div className="offer-hero-line" />
        </div>

        <div className="offer-content">
          {/* Intro */}
          {(o.intro_en || o.intro_it) && (
            <div className="offer-intro-block">
              {o.intro_en && <><div className="offer-lang-badge offer-lang-en">EN</div><div className="offer-intro-text">{o.intro_en}</div></>}
              {o.intro_it && <><div className="offer-lang-badge offer-lang-it">IT</div><div className="offer-intro-text">{o.intro_it}</div></>}
            </div>
          )}

          {/* Issues */}
          {o.issues && o.issues.length > 0 && (
            <div className="offer-section offer-criticita-box">
              <div className="offer-section-title" style={{ color: 'var(--offer-red)' }}>{L.issues}</div>
              <p style={{ marginBottom: 16, fontSize: 15 }}>{L.issuesIntro}</p>
              {o.issues.map((c, i) => (
                <div key={i} className="offer-criticita-item"><strong>{c.title}:</strong> {c.description}</div>
              ))}
            </div>
          )}

          {/* Immediate Actions */}
          {o.immediate_actions && o.immediate_actions.length > 0 && (
            <div className="offer-section offer-azioni-box">
              <div className="offer-section-title" style={{ color: 'var(--offer-green)' }}>{L.immediateActions}</div>
              {o.immediate_actions.map((a, i) => (
                <div key={i} className="offer-azione-item">&rarr; <strong>{a.title}</strong> {a.text || a.description}</div>
              ))}
            </div>
          )}

          {/* Strategy */}
          {o.strategy && o.strategy.length > 0 && (
            <div className="offer-section">
              <div className="offer-section-title">{L.strategy}</div>
              {o.strategy.map((st, i) => (
                <div key={i} className="offer-strategia-step">
                  <div className="offer-step-number">{st.step_number}</div>
                  <div className="offer-step-content"><h3>{st.title}</h3><p>{st.description}</p></div>
                </div>
              ))}
            </div>
          )}

          {/* Services */}
          {((o.services && o.services.length > 0) || (o.additional_services && o.additional_services.length > 0)) && (
            <div className="offer-section">
              <div className="offer-section-title">{L.services}</div>
              {o.services && o.services.length > 1 && (
                <p style={{ marginBottom: 20, fontSize: 15, color: '#6b7280' }}>{L.servicesIntro}</p>
              )}
              <div className="offer-servizi-grid">
                {o.services?.map((sv, i) => {
                  const isOpt = !!(sv as any).optional
                  const isSelected = !isOpt || selectedOptional.has(sv.name)
                  return (
                  <div key={i} className={`offer-servizio-card${sv.recommended ? ' offer-recommended' : ''}${isOpt && !isSelected ? ' offer-optional-dimmed' : ''}${isOpt ? ' offer-optional' : ''}`}
                    onClick={isOpt ? () => {
                      setSelectedOptional(prev => {
                        const next = new Set(prev)
                        if (next.has(sv.name)) next.delete(sv.name)
                        else next.add(sv.name)
                        return next
                      })
                    } : undefined}
                    style={isOpt ? { cursor: 'pointer' } : undefined}
                  >
                    {isOpt && (
                      <div className="offer-optional-checkbox">
                        <input type="checkbox" checked={isSelected} readOnly style={{ width: 18, height: 18, accentColor: '#1e40af', cursor: 'pointer' }} />
                        <span className="offer-optional-label">{lang === 'it' ? 'OPZIONALE' : 'OPTIONAL'}</span>
                      </div>
                    )}
                    {sv.recommended && <div className="offer-badge-recommended">{L.recommended}</div>}
                    <h3>{sv.name}</h3>
                    <div className="offer-price">{sv.price}</div>
                    <div className="offer-price-label">{sv.price_label || ''}</div>
                    <p>{sv.description}</p>
                    {sv.includes && sv.includes.length > 0 && (
                      <>
                        <div className="offer-includes-label">{L.includes}</div>
                        <ul className="offer-includes-list">
                          {sv.includes.map((inc, j) => <li key={j}>&#10003; {inc}</li>)}
                        </ul>
                      </>
                    )}
                  </div>
                  )
                })}
                {o.additional_services?.map((sv, i) => (
                  <div key={`addon-${i}`} className="offer-servizio-card offer-addon">
                    <h3>{sv.name}</h3>
                    <div className="offer-price">{sv.price}</div>
                    <div className="offer-price-label">{sv.price_label || ''}</div>
                    <p>{sv.description}</p>
                    {sv.includes && sv.includes.length > 0 && (
                      <>
                        <div className="offer-includes-label">{L.includes}</div>
                        <ul className="offer-includes-list">
                          {sv.includes.map((inc, j) => <li key={j}>&#10003; {inc}</li>)}
                        </ul>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cost Summary */}
          {((o.cost_summary && o.cost_summary.length > 0) || (o.recurring_costs && o.recurring_costs.length > 0)) && (
            <div className="offer-section">
              <div className="offer-section-title">{L.costSummary}</div>
              <div className="offer-riepilogo-box">
                {o.cost_summary?.map((r, i) => (
                  <div key={i} className="offer-riepilogo-section">
                    <h4>{r.label}</h4>
                    <div className="offer-riepilogo-line" />
                    {r.items?.map((item, j) => (
                      <div key={j} className="offer-riepilogo-row"><span>{item.name}</span><span className="offer-riepilogo-price">{item.price}</span></div>
                    ))}
                    <div className="offer-riepilogo-total"><span>{r.total_label || L.total}</span><span>{r.total}</span></div>
                  </div>
                ))}
                {o.recurring_costs && o.recurring_costs.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--offer-blue)', marginBottom: 8 }}>{L.recurringCosts}</h4>
                    {o.recurring_costs.map((c, i) => (
                      <div key={i} className="offer-riepilogo-row offer-annual"><span>{c.label}</span><span className="offer-riepilogo-price">{c.price}</span></div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Future Developments */}
          {o.future_developments && o.future_developments.length > 0 && (
            <div className="offer-section">
              <div className="offer-section-title">{L.futureDevelopments}</div>
              <div className="offer-sviluppi-box">
                <p style={{ marginBottom: 12, fontSize: 15 }}>{L.futureDevelopmentsIntro}</p>
                {o.future_developments.map((sv, i) => (
                  <div key={i} className="offer-sviluppo-item">&rarr; {sv.text}</div>
                ))}
              </div>
            </div>
          )}

          {/* Next Steps */}
          {o.next_steps && o.next_steps.length > 0 && (
            <div className="offer-section">
              <div className="offer-section-title">{L.nextSteps}</div>
              {o.next_steps.map((p, i) => (
                <div key={i} className="offer-passo-step">
                  <div className="offer-passo-number">{p.step_number}</div>
                  <div className="offer-passo-content"><h4>{p.title}</h4><p>{p.description}</p></div>
                </div>
              ))}
            </div>
          )}

          {/* CTA */}
          <div className="offer-cta-box">
            <h2>{L.readyToStart}</h2>

            {isSigned && <p style={{ fontSize: 18, marginBottom: 16 }}>&#10004; {L.contractSigned}</p>}

            {/* Payment Info — informational only, no buttons */}
            {(o.payment_links?.length || o.bank_details) && (
              <div className="offer-pay-info">
                {o.payment_links?.length && o.bank_details ? (
                  <>
                    <div className="offer-pay-info-row">
                      <span>&#128179; {L.payByCard}</span>
                      <span className="offer-pay-info-price">{o.payment_links[0].amount} <span className="offer-surcharge-tag">+5%</span></span>
                    </div>
                    <div className="offer-pay-info-or">{lang === 'it' ? 'oppure' : 'or'}</div>
                    <div className="offer-pay-info-row">
                      <span>&#127974; {L.payByTransfer}</span>
                      <span className="offer-pay-info-price">{o.bank_details.amount}</span>
                    </div>
                  </>
                ) : o.payment_links?.length ? (
                  <div className="offer-pay-info-row">
                    <span>&#128179; {L.payByCard}</span>
                    <span className="offer-pay-info-price">{o.payment_links[0].amount}</span>
                  </div>
                ) : o.bank_details ? (
                  <div className="offer-pay-info-row">
                    <span>&#127974; {L.payByTransfer}</span>
                    <span className="offer-pay-info-price">{o.bank_details.amount}</span>
                  </div>
                ) : null}
                <p className="offer-pay-info-note">{lang === 'it' ? 'Sceglierai il metodo di pagamento dopo la firma del contratto.' : 'You will choose your payment method after signing the contract.'}</p>
              </div>
            )}

            {!o.payment_links?.length && !o.bank_details && (
              <p style={{ opacity: 0.9 }}>{L.contactPayment}</p>
            )}

            {/* Contract signing */}
            {!isSigned && (
              <div className="offer-contract-cta">
                <a href={`/offer/${encodeURIComponent(token)}/contract${selectedOptional.size > 0 ? '?sel=' + encodeURIComponent(Array.from(selectedOptional).join('|')) : ''}`}
                  className="offer-accept-btn"
                  onClick={async () => {
                    const allSelected = (o.services || [])
                      .filter(sv => !(sv as any).optional || selectedOptional.has(sv.name))
                      .map(sv => sv.name)
                    try {
                      await supabasePublic.from('offers').update({ selected_services: allSelected }).eq('token', token)
                    } catch { /* non-blocking */ }
                  }}
                >&#9997;&#65039; {L.acceptAndSign}</a>
              </div>
            )}

            {/* WhatsApp */}
            <div className="offer-payment-section">
              <p style={{ opacity: 0.8, marginBottom: 12 }}>{L.questions}</p>
              <a href="https://wa.me/17273187027" className="offer-cta-button">{L.contactWhatsApp}</a>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="offer-footer">
          <div className="offer-footer-name">Tony Durante LLC</div>
          <div className="offer-footer-tagline">Your Way to Freedom</div>
          <div className="offer-footer-address">10225 Ulmerton Road, Suite 3D<br />Largo, FL 33771<br />United States</div>
          <div className="offer-footer-line" />
          <div className="offer-footer-certs">
            <span className="offer-cert-badge">IRS Certified Acceptance Agent</span>
            <span className="offer-cert-badge">Public Notary</span>
            <span className="offer-cert-badge">Professional Tax Preparer</span>
            <span className="offer-cert-badge">CMRA for USPS</span>
          </div>
        </div>
      </div>
    </>
  )
}

function OfferStyles() {
  return (
    <style jsx global>{`
      body { background: #f7f8fa !important; color: #374151 !important; font-family: 'Source Sans 3', -apple-system, sans-serif !important; line-height: 1.7 !important; -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');
      @media print { body { display: none !important; } }

      :root {
        --offer-red: #b8292f; --offer-red-dark: #961f24; --offer-blue: #1e3a5f; --offer-blue-light: #e8eff7;
        --offer-blue-lighter: #f0f5fb; --offer-dark: #1a1a2e; --offer-gray-100: #f7f8fa; --offer-gray-200: #edf0f4;
        --offer-gray-300: #d1d5db; --offer-gray-500: #6b7280; --offer-gray-700: #374151; --offer-green: #059669;
        --offer-green-bg: #ecfdf5; --offer-green-border: #a7f3d0; --offer-white: #fff;
      }

      /* Email verification gate */
      .offer-gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
      .offer-gate-box { background: #fff; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 440px; width: 100%; }
      .offer-gate-logo { height: 48px; margin-bottom: 24px; }
      .offer-gate-box h2 { font-family: 'Playfair Display', serif; font-size: 24px; color: var(--offer-blue); margin-bottom: 8px; }
      .offer-gate-box p { font-size: 15px; color: var(--offer-gray-500); margin-bottom: 24px; line-height: 1.6; }
      .offer-gate-input { width: 100%; padding: 14px 16px; border: 2px solid var(--offer-gray-200); border-radius: 8px; font-size: 16px; outline: none; transition: border-color .2s; box-sizing: border-box; }
      .offer-gate-input:focus { border-color: var(--offer-blue); }
      .offer-gate-input-error { border-color: var(--offer-red) !important; }
      .offer-gate-error-msg { color: var(--offer-red); font-size: 14px; margin-top: 8px; }
      .offer-gate-btn { display: block; width: 100%; margin-top: 16px; padding: 14px; background: var(--offer-blue); color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background .2s; }
      .offer-gate-btn:hover { background: #162d4a; }

      .offer-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-size: 18px; color: var(--offer-gray-500); }
      .offer-loading-spinner { width: 40px; height: 40px; border: 3px solid var(--offer-gray-200); border-top-color: var(--offer-red); border-radius: 50%; animation: offer-spin 1s linear infinite; margin-bottom: 16px; }
      @keyframes offer-spin { to { transform: rotate(360deg); } }

      .offer-error-page { display: flex; align-items: center; justify-content: center; height: 100vh; text-align: center; }
      .offer-error-page h1 { color: var(--offer-red); font-family: 'Playfair Display', serif; margin-bottom: 12px; }
      .offer-error-page p { color: var(--offer-gray-500); }

      .offer-expired-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.85); display: flex; align-items: center; justify-content: center; z-index: 1000; }
      .offer-expired-box { background: #fff; padding: 48px; border-radius: 16px; text-align: center; max-width: 400px; }
      .offer-expired-box h2 { color: var(--offer-red); margin-bottom: 12px; }

      .offer-container { max-width: 820px; margin: 0 auto; background: var(--offer-white); box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 20px 60px rgba(0,0,0,.06); }
      .offer-header-bar { display: flex; justify-content: space-between; align-items: center; padding: 24px 48px; border-bottom: 1px solid var(--offer-gray-200); }
      .offer-logo-img { height: 60px; }

      .offer-hero { background: linear-gradient(135deg, var(--offer-blue) 0%, #162d4a 100%); color: #fff; padding: 48px; }
      .offer-hero-label { font-size: 11px; letter-spacing: 4px; text-transform: uppercase; opacity: .7; margin-bottom: 16px; }
      .offer-hero h1 { font-family: 'Playfair Display', serif; font-size: 42px; font-weight: 800; margin-bottom: 32px; line-height: 1.15; }
      .offer-hero-meta { display: flex; gap: 48px; }
      .offer-hero-meta-item { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; opacity: .6; }
      .offer-hero-meta-value { font-size: 18px; font-weight: 600; opacity: 1; margin-top: 4px; }
      .offer-hero-line { width: 60px; height: 3px; background: var(--offer-red); margin-top: 32px; }

      .offer-content { padding: 48px; }
      .offer-intro-block { margin-bottom: 40px; }
      .offer-lang-badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 1px; margin-bottom: 8px; }
      .offer-lang-en { background: var(--offer-blue); color: #fff; }
      .offer-lang-it { background: var(--offer-green); color: #fff; }
      .offer-intro-text { font-size: 16px; line-height: 1.8; color: var(--offer-gray-700); margin-bottom: 24px; padding: 20px 24px; background: var(--offer-gray-100); border-radius: 8px; border-left: 3px solid var(--offer-gray-300); }

      .offer-section { margin-bottom: 48px; }
      .offer-section-title { font-family: 'Playfair Display', serif; font-size: 26px; font-weight: 700; color: var(--offer-blue); margin-bottom: 20px; }

      .offer-criticita-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 32px; }
      .offer-criticita-item { padding: 16px 0; border-bottom: 1px solid #fecaca; font-size: 15px; line-height: 1.7; }
      .offer-criticita-item:last-child { border-bottom: none; }

      .offer-azioni-box { background: var(--offer-green-bg); border: 1px solid var(--offer-green-border); border-radius: 12px; padding: 32px; }
      .offer-azione-item { padding: 12px 0; font-size: 15px; line-height: 1.7; }

      .offer-strategia-step { display: flex; gap: 20px; margin-bottom: 24px; align-items: flex-start; }
      .offer-step-number { flex-shrink: 0; width: 44px; height: 44px; background: var(--offer-red); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; }
      .offer-step-content h3 { font-size: 18px; font-weight: 700; color: var(--offer-blue); margin-bottom: 6px; }
      .offer-step-content p { font-size: 15px; line-height: 1.7; }

      .offer-servizi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
      .offer-servizio-card { border: 1px solid var(--offer-gray-200); border-radius: 12px; padding: 28px; position: relative; transition: box-shadow .2s; }
      .offer-servizio-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,.08); }
      .offer-servizio-card.offer-recommended { border-color: var(--offer-blue); border-width: 2px; background: var(--offer-blue-lighter); }
      .offer-servizio-card.offer-addon { grid-column: 1 / -1; }
      .offer-servizio-card.offer-optional { border-style: dashed; transition: opacity .2s, border-color .2s; }
      .offer-servizio-card.offer-optional:hover { border-color: var(--offer-blue); }
      .offer-servizio-card.offer-optional-dimmed { opacity: 0.5; border-color: var(--offer-gray-200); }
      .offer-optional-checkbox { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      .offer-optional-label { font-size: 11px; font-weight: 700; letter-spacing: 1px; color: var(--offer-blue); }
      .offer-badge-recommended { position: absolute; top: -12px; right: 20px; background: var(--offer-blue); color: #fff; padding: 4px 14px; border-radius: 20px; font-size: 10px; font-weight: 700; letter-spacing: 2px; }
      .offer-servizio-card h3 { font-size: 18px; font-weight: 700; color: var(--offer-dark); margin-bottom: 8px; }
      .offer-price { font-size: 28px; font-weight: 700; color: var(--offer-blue); }
      .offer-price-label { font-size: 13px; color: var(--offer-gray-500); margin-bottom: 12px; }
      .offer-servizio-card p { font-size: 14px; color: var(--offer-gray-500); margin-bottom: 16px; line-height: 1.6; }
      .offer-includes-label { font-size: 11px; letter-spacing: 2px; font-weight: 700; color: var(--offer-gray-500); margin-bottom: 8px; }
      .offer-includes-list { list-style: none; padding: 0; margin: 0; }
      .offer-includes-list li { font-size: 14px; padding: 4px 0; color: var(--offer-gray-700); }

      .offer-riepilogo-box { background: var(--offer-blue-light); border-radius: 12px; padding: 32px; border-left: 4px solid var(--offer-blue); }
      .offer-riepilogo-section { margin-bottom: 24px; }
      .offer-riepilogo-section:last-child { margin-bottom: 0; }
      .offer-riepilogo-section h4 { font-size: 16px; font-weight: 700; color: var(--offer-blue); margin-bottom: 8px; }
      .offer-riepilogo-line { height: 1px; background: rgba(30,58,95,.2); margin-bottom: 12px; }
      .offer-riepilogo-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 15px; }
      .offer-riepilogo-row.offer-annual { color: var(--offer-gray-500); font-size: 14px; }
      .offer-riepilogo-price { font-weight: 600; }
      .offer-riepilogo-total { display: flex; justify-content: space-between; padding: 12px 0 0; border-top: 2px solid var(--offer-blue); margin-top: 8px; font-size: 18px; font-weight: 700; color: var(--offer-blue); }

      .offer-sviluppi-box { background: var(--offer-blue-lighter); border-radius: 12px; padding: 32px; }
      .offer-sviluppo-item { padding: 8px 0; font-size: 15px; }

      .offer-passo-step { display: flex; gap: 20px; margin-bottom: 20px; align-items: flex-start; }
      .offer-passo-number { flex-shrink: 0; width: 36px; height: 36px; background: var(--offer-blue); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; }
      .offer-passo-content h4 { font-size: 16px; font-weight: 700; color: var(--offer-dark); margin-bottom: 4px; }
      .offer-passo-content p { font-size: 14px; color: var(--offer-gray-500); line-height: 1.6; }

      .offer-cta-box { background: linear-gradient(135deg, var(--offer-red) 0%, var(--offer-red-dark) 100%); color: #fff; text-align: center; padding: 48px; border-radius: 12px; margin-bottom: 48px; }
      .offer-cta-box h2 { font-family: 'Playfair Display', serif; font-size: 32px; margin-bottom: 12px; }
      .offer-cta-box p { font-size: 16px; opacity: .9; margin-bottom: 24px; }
      .offer-cta-button { display: inline-block; background: #fff; color: var(--offer-red); padding: 14px 40px; border-radius: 8px; font-weight: 700; font-size: 16px; text-decoration: none; transition: transform .2s, box-shadow .2s; }
      .offer-cta-button:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.2); }

      .offer-accept-btn { display: inline-flex; align-items: center; justify-content: center; gap: 10px; background: linear-gradient(135deg, #1e3a5f 0%, #162d4a 100%); color: #fff; padding: 18px 56px; border-radius: 10px; font-weight: 700; font-size: 18px; text-decoration: none; transition: transform .2s, box-shadow .2s; box-shadow: 0 4px 20px rgba(30,58,95,.35); letter-spacing: .5px; }
      .offer-accept-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(30,58,95,.45); }

      .offer-payment-section { margin-top: 28px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,.2); }
      .offer-payment-buttons { display: flex; flex-direction: column; gap: 12px; align-items: center; }
      .offer-payment-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: #fff; padding: 16px 48px; border-radius: 10px; font-weight: 700; font-size: 17px; text-decoration: none; transition: transform .2s, box-shadow .2s; min-width: 320px; box-shadow: 0 4px 14px rgba(34,197,94,.3); }
      .offer-payment-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(34,197,94,.4); }
      .offer-payment-note { font-size: 13px; opacity: .7; margin-top: 12px; }
      .offer-payment-secure { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 8px; font-size: 12px; opacity: .5; }

      .offer-pay-info { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.15); border-radius: 12px; padding: 20px 28px; margin-bottom: 20px; }
      .offer-pay-info-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; font-size: 16px; font-weight: 600; }
      .offer-pay-info-price { font-family: 'Source Code Pro', monospace; font-weight: 700; font-size: 18px; }
      .offer-pay-info-or { text-align: center; font-size: 12px; font-weight: 700; letter-spacing: 2px; opacity: .5; padding: 4px 0; }
      .offer-pay-info-note { text-align: center; font-size: 12px; opacity: .55; margin: 12px 0 0; font-style: italic; }
      .offer-surcharge-tag { display: inline-block; background: rgba(255,255,255,.2); border: 1px solid rgba(255,255,255,.3); padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; margin-left: 8px; vertical-align: middle; }
      .offer-contract-cta { margin-top: 32px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,.2); }

      .offer-bank-box { background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.25); border-radius: 12px; padding: 24px 32px; text-align: left; margin: 20px auto 0; max-width: 440px; }
      .offer-bank-title { font-size: 13px; letter-spacing: 2px; text-transform: uppercase; opacity: .6; margin-bottom: 12px; text-align: center; }
      .offer-bank-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; border-bottom: 1px solid rgba(255,255,255,.1); }
      .offer-bank-row:last-child { border-bottom: none; }
      .offer-bank-label { opacity: .7; }
      .offer-bank-value { font-weight: 600; font-family: 'Source Code Pro', monospace; letter-spacing: .5px; }
      .offer-bank-amount { margin-top: 16px; text-align: center; font-size: 22px; font-weight: 700; }
      .offer-bank-ref { margin-top: 8px; text-align: center; font-size: 13px; opacity: .6; }

      .offer-footer { background: var(--offer-dark); color: #fff; text-align: center; padding: 40px 48px; }
      .offer-footer-name { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
      .offer-footer-tagline { font-style: italic; opacity: .6; margin-bottom: 16px; }
      .offer-footer-address { font-size: 14px; opacity: .5; line-height: 1.6; margin-bottom: 20px; }
      .offer-footer-line { width: 60px; height: 2px; background: var(--offer-red); margin: 0 auto 16px; }
      .offer-footer-certs { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
      .offer-cert-badge { padding: 4px 14px; border: 1px solid rgba(255,255,255,.2); border-radius: 20px; font-size: 12px; opacity: .7; }

      @media (max-width: 700px) {
        .offer-servizi-grid { grid-template-columns: 1fr; }
        .offer-hero { padding: 32px; }
        .offer-content { padding: 32px; }
        .offer-hero h1 { font-size: 32px; }
        .offer-header-bar { padding: 16px 24px; }
        .offer-footer { padding: 32px 24px; }
        .offer-hero-meta { flex-direction: column; gap: 16px; }
        .offer-payment-btn { min-width: auto; width: 100%; padding: 14px 24px; }
        .offer-bank-box { padding: 20px 16px; }
        .offer-gate-box { padding: 32px 24px; }
      }
    `}</style>
  )
}
