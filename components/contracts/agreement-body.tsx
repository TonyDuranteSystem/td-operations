import { Fragment } from 'react'
import { isNoChargeFee } from '@/lib/offers/fee-label'
import { parseInline, type ContractWording } from '@/lib/contracts/contract-wording'

type AgreementContent = ContractWording

export function contractToday() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}
const today = contractToday

/**
 * A line of contract wording: words between ** ** are shown bold. Plain React text and <strong>, never HTML, so
 * stored wording cannot inject markup. A line with no marks renders exactly as plain text.
 */
export function InlineText({ text }: { text: string }) {
  const segs = parseInline(text)
  if (segs.length === 1 && !segs[0].bold) return <>{text}</>
  return <>{segs.map((s, i) => (s.bold ? <strong key={i}>{s.text}</strong> : <Fragment key={i}>{s.text}</Fragment>))}</>
}

export interface AgreementBodyProps {
  ct: AgreementContent
  clientName: string
  serviceName: string
  serviceDesc: string
  fee: string
  includes: string[]
  scopeClosing: string
  workPhrase: string
  liabilityPhrase: string
}

/** One agreement's parties, service summary and sections 1-8 (no signature — that is the page's). */
export function AgreementBody({ ct, clientName, serviceName, serviceDesc, fee, includes, scopeClosing, workPhrase, liabilityPhrase }: AgreementBodyProps) {
  // a $0 / "included" service still gets its agreement, but says so instead of "$0 payable in full"
  const noCharge = isNoChargeFee(fee)
  return (
    <>
        {/* PARTIES */}
        <p>This {ct.shortTitle} (&ldquo;<strong>Agreement</strong>&rdquo;) is entered into as of <strong>{today()}</strong>, by and between:</p>
        <p style={{ margin: '14px 0' }}><strong>Tony Durante LLC</strong>, a Florida limited liability company (&ldquo;<strong>Service Provider</strong>&rdquo;), and</p>
        <p style={{ margin: '14px 0' }}><strong>{clientName || '[Client Name]'}</strong> (&ldquo;<strong>Client</strong>&rdquo;).</p>

        {/* SERVICE SUMMARY */}
        <table className="contract-key-terms">
          <caption>Service Summary</caption>
          <tbody>
            <tr><th>Service</th><td>{serviceName}</td></tr>
            {serviceDesc && <tr><th>Description</th><td>{serviceDesc}</td></tr>}
            <tr><th>Fee</th><td>{noCharge ? 'Included \u2014 no separate charge' : <>{fee} (one-time)</>}</td></tr>
            {includes.length > 0 && (
              <tr><th>Includes</th><td>{(includes as string[]).map((item, i) => <span key={i}>{item}{i < includes.length - 1 ? ', ' : ''}</span>)}</td></tr>
            )}
          </tbody>
        </table>

        {/* SECTION 1 — SCOPE */}
        <div className="contract-section">
          <h3>1. Scope of Service</h3>
          <p><InlineText text={ct.scope.intro} /></p>
          <ul>
            {ct.scope.items.map((item, i) => <li key={i}><InlineText text={item} /></li>)}
          </ul>
          <p><strong>{scopeClosing}</strong></p>
        </div>

        {/* SECTION 2 — CLIENT RESPONSIBILITIES */}
        <div className="contract-section">
          <h3>2. Client Responsibilities</h3>
          <p><InlineText text={ct.clientDuties.intro} /></p>
          <ol type="a">
            {ct.clientDuties.items.map((item, i) => <li key={i}><strong>{item.bold}</strong><InlineText text={item.rest} /></li>)}
          </ol>
        </div>

        {/* SECTION 3 — PROCEDURE */}
        <div className="contract-section">
          <h3>3. Service Procedure</h3>
          <p><InlineText text={ct.procedure.intro} /></p>
          <ol>
            {ct.procedure.steps.map((step, i) => <li key={i}><strong>{step.title}</strong> &mdash; <InlineText text={step.desc} /></li>)}
          </ol>
        </div>

        {/* SECTION 4 — SERVICE PROVIDER COMMITMENTS */}
        <div className="contract-section">
          <h3>4. Service Provider Commitments</h3>
          <p>The Service Provider agrees to:</p>
          <ol type="a">
            {ct.commitments.map((item, i) => <li key={i}><InlineText text={item} /></li>)}
          </ol>
        </div>

        {/* SECTION 5 — PAYMENT */}
        <div className="contract-section">
          <h3>5. Payment</h3>
          {noCharge ? (
            <p>No service fee is payable to the Service Provider for this service itself; it is included in your offer. Any third-party or government charges described in this Agreement remain the Client&rsquo;s responsibility.</p>
          ) : (
            <>
              <p>The total fee for this service is <strong>{fee}</strong>, payable in full before {workPhrase} begins. Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.</p>
              <p><strong>All fees are non-refundable</strong> once {workPhrase} has commenced.</p>
            </>
          )}
        </div>

        {/* SECTION 6 — LIMITATION OF LIABILITY */}
        <div className="contract-section">
          <h3>6. Limitation of Liability</h3>
          <p>The Service Provider&rsquo;s total liability under this Agreement shall not exceed the fee paid by the Client. The Service Provider is not liable for {liabilityPhrase} resulting from inaccurate, incomplete, or late information provided by the Client.</p>
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

    </>
  )
}
