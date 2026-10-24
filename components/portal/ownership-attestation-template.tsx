'use client'

import { forwardRef } from 'react'
import type { AttestationOwner } from '@/lib/pdf/ownership-attestation-pdf'

/**
 * Attestation of Beneficial Ownership — the client-portal version, rendered as HTML and turned into a PDF in the browser
 * (html2pdf.js), exactly like the other documents on the Generate Documents page. Generic on purpose: no bank name and no
 * addressee, so the same page works for any bank that asks who owns 25% or more. The staff-side PDF
 * (lib/pdf/ownership-attestation-pdf.ts) prints the same facts.
 */
export interface OwnershipAttestationTemplateProps {
  companyName: string
  registeredIn: string
  companyAddress: string
  contactEmail?: string | null
  /** Already formatted, e.g. "October 23, 2026". */
  dateLine: string
  owners: AttestationOwner[]
  signerName: string
  signerPosition: string
  /** data URL when signed */
  signatureImage?: string | null
}

const GREEN = '#3f8f3f'

function pct(n: number): string {
  return `${n.toFixed(2)}%`
}

const OwnershipAttestationTemplate = forwardRef<HTMLDivElement, OwnershipAttestationTemplateProps>(
  function OwnershipAttestationTemplate(
    { companyName, registeredIn, companyAddress, contactEmail, dateLine, owners, signerName, signerPosition, signatureImage },
    ref,
  ) {
    return (
      <div
        ref={ref}
        style={{
          fontFamily: 'Arial, Helvetica, sans-serif',
          fontSize: '10.5pt',
          lineHeight: '1.5',
          color: '#111',
          padding: '40px 50px',
          maxWidth: '8.5in',
          background: 'white',
        }}
      >
        {/* Letterhead band */}
        <div style={{ background: '#ececec', padding: '16px 20px', marginBottom: '28px' }}>
          <div style={{ fontSize: '16pt', fontWeight: 'bold', color: '#1d5a45' }}>{companyName}</div>
          <div style={{ fontSize: '9pt', color: '#666' }}>{companyAddress}</div>
          {contactEmail && <div style={{ fontSize: '9pt', color: '#666' }}>{contactEmail}</div>}
        </div>

        <div style={{ marginBottom: '22px' }}>{dateLine}</div>

        <p style={{ marginBottom: '18px' }}>
          Below we have indicated our ownership structure for {companyName} and highlighted each of our Ultimate
          Beneficial Owners (individuals with a 25% or more ownership share in the business).
        </p>

        <div style={{ textAlign: 'center', fontWeight: 'bold', marginBottom: '16px' }}>
          Shareholding Structure Chart of {companyName}
        </div>

        {/* Chart: owner boxes → company box */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginBottom: '0' }}>
          {owners.map((o, i) => (
            <div
              key={`${o.fullName}-${i}`}
              style={{
                flex: `0 1 ${owners.length === 1 ? '260px' : '100%'}`,
                maxWidth: '260px',
                border: '1px solid #111',
                padding: '10px 8px',
                textAlign: 'center',
                color: GREEN,
                fontStyle: 'italic',
                fontWeight: 'bold',
                fontSize: '9pt',
                lineHeight: '1.4',
              }}
            >
              <div>UBO #{i + 1}: {o.fullName}</div>
              <div>Date of birth: {o.dateOfBirth}</div>
              <div>Nationality: {o.nationality}</div>
              <div>Ownership: {pct(o.ownershipPct)}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
          {owners.map((o, i) => (
            <div
              key={`line-${o.fullName}-${i}`}
              style={{
                flex: `0 1 ${owners.length === 1 ? '260px' : '100%'}`,
                maxWidth: '260px',
                height: '46px',
                position: 'relative',
              }}
            >
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, borderLeft: '1px solid #111' }} />
              <div style={{ position: 'absolute', left: 'calc(50% + 6px)', top: '14px', fontSize: '8.5pt', fontWeight: 'bold' }}>
                {pct(o.ownershipPct)}
              </div>
            </div>
          ))}
        </div>
        {owners.length > 1 && (
          <div style={{ margin: '0 auto', width: `calc(100% - ${(100 / owners.length)}%)`, borderTop: '1px solid #111' }} />
        )}
        {owners.length > 1 && <div style={{ margin: '0 auto', height: '24px', width: '0', borderLeft: '1px solid #111' }} />}
        <div
          style={{
            margin: '0 auto 26px',
            maxWidth: owners.length === 1 ? '360px' : '100%',
            border: '1px solid #111',
            padding: '10px 8px',
            textAlign: 'center',
            fontWeight: 'bold',
            fontSize: '10pt',
          }}
        >
          <div>{companyName}</div>
          <div>(Registered in {registeredIn})</div>
        </div>

        <p style={{ fontStyle: 'italic', fontWeight: 'bold', marginBottom: '34px' }}>
          [I confirm that these natural persons hold or control an interest of 25% or more of {companyName}]
        </p>

        {/* Signature block */}
        <div style={{ display: 'grid', gridTemplateColumns: '150px 240px', rowGap: '16px', alignItems: 'end' }}>
          <div style={{ fontWeight: 'bold' }}>Signed by:</div>
          <div style={{ borderBottom: '1px solid #111', height: '44px', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            {signatureImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={signatureImage} alt="Signature" style={{ maxHeight: '42px', maxWidth: '230px' }} />
            )}
          </div>
          <div style={{ fontWeight: 'bold' }}>Name:</div>
          <div style={{ borderBottom: '1px solid #111', padding: '0 4px 7px', lineHeight: '1.2' }}>{signerName}</div>
          <div style={{ fontWeight: 'bold' }}>Position:</div>
          <div style={{ borderBottom: '1px solid #111', padding: '0 4px 7px', lineHeight: '1.2' }}>{signerPosition}</div>
        </div>
      </div>
    )
  },
)

export default OwnershipAttestationTemplate
