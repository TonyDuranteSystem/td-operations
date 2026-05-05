'use client'

import { forwardRef, useMemo } from 'react'
import {
  generateOASections,
  type OAData,
} from '@/lib/types/oa-templates'

interface OAMember {
  fullName: string
  address: string
  ownershipPct: number
}

interface OAAccount {
  companyName: string
  ein: string | null
  stateOfFormation: string | null
  formationDate: string | null
  physicalAddress: string | null
  entityType: string | null
  registeredAgentAddress: string | null
}

interface Props {
  account: OAAccount
  members: OAMember[]
  effectiveDate: string
  signatureImage?: string | null
}

const OperatingAgreementTemplate = forwardRef<HTMLDivElement, Props>(
  function OperatingAgreementTemplate({ account, members, effectiveDate, signatureImage }, ref) {
    const primaryMember = members[0]
    const isMMLC = members.length > 1 || account.entityType?.toLowerCase().includes('multi')

    const oaData: OAData = useMemo(() => ({
      company_name: account.companyName,
      state_of_formation: account.stateOfFormation || 'Florida',
      formation_date: account.formationDate || effectiveDate,
      ein_number: account.ein ?? undefined,
      entity_type: isMMLC ? 'MMLLC' : 'SMLLC',
      member_name: primaryMember?.fullName || 'N/A',
      member_address: primaryMember?.address || 'As on file with the Company',
      members: isMMLC
        ? members.map(m => ({
            name: m.fullName,
            address: m.address,
            ownership_pct: m.ownershipPct,
            initial_contribution: '$1,000 USD',
          }))
        : undefined,
      manager_name: primaryMember?.fullName || 'N/A',
      effective_date: effectiveDate,
      business_purpose: 'engaging in any and all lawful business activities',
      initial_contribution: '$1,000 USD',
      fiscal_year_end: 'December 31',
      accounting_method: 'Cash',
      duration: 'Perpetual',
      registered_agent_name: 'As designated in Articles of Organization',
      registered_agent_address: account.registeredAgentAddress || '',
      principal_address: account.physicalAddress || '10225 Ulmerton Rd, Suite 3D, Largo, FL 33771',
    }), [account, members, effectiveDate, isMMLC, primaryMember])

    const sections = useMemo(() => generateOASections(oaData), [oaData])

    const managingMember = primaryMember?.fullName || 'N/A'

    return (
      <div
        ref={ref}
        style={{
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: '11pt',
          lineHeight: '1.6',
          color: '#1a1a1a',
          padding: '40px 50px',
          maxWidth: '8.5in',
          background: 'white',
        }}
      >
        {/* Letterhead */}
        <div style={{ textAlign: 'center', marginBottom: '30px', borderBottom: '2px solid #333', paddingBottom: '20px' }}>
          <div style={{ fontSize: '16pt', fontWeight: 'bold', letterSpacing: '1px' }}>
            {account.companyName}
          </div>
          {account.ein && (
            <div style={{ fontSize: '9pt', color: '#555', marginTop: '4px' }}>
              EIN: {account.ein}
            </div>
          )}
          {account.physicalAddress && (
            <div style={{ fontSize: '9pt', color: '#555', marginTop: '2px' }}>
              {account.physicalAddress}
            </div>
          )}
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: '25px' }}>
          <div style={{ fontSize: '14pt', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Operating Agreement
          </div>
          <div style={{ fontSize: '10pt', fontStyle: 'italic', marginTop: '4px', color: '#444' }}>
            {isMMLC ? 'Multi-Member Limited Liability Company' : 'Single-Member Limited Liability Company'}
          </div>
          <div style={{ fontSize: '9pt', color: '#555', marginTop: '6px' }}>
            Effective Date: {effectiveDate}
          </div>
        </div>

        {/* Sections */}
        {sections.map((section, i) => (
          <div key={i} style={{ marginBottom: '18px' }}>
            <div style={{ fontWeight: 'bold', fontSize: '11pt', marginBottom: '6px', textDecoration: 'underline' }}>
              {section.title}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: '11pt', textAlign: 'justify' }}>
              {section.content}
            </div>
          </div>
        ))}

        {/* Signature block */}
        <div style={{ marginTop: '40px', borderTop: '1px solid #333', paddingTop: '20px' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '20px' }}>IN WITNESS WHEREOF</div>
          <p style={{ marginBottom: '20px' }}>
            The undersigned has executed this Operating Agreement as of {effectiveDate}.
          </p>

          {isMMLC ? (
            members.map((m, i) => (
              <div key={i} style={{ marginBottom: '32px' }}>
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Member: {m.fullName}</div>
                <div style={{ fontSize: '9pt', color: '#555', marginBottom: '12px' }}>Ownership: {m.ownershipPct}%</div>
                {i === 0 && signatureImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={signatureImage} alt="Signature" style={{ height: '50px', marginBottom: '4px' }} />
                ) : (
                  <div style={{ borderBottom: '1px solid #333', width: '280px', marginBottom: '4px', height: '40px' }} />
                )}
                <div style={{ fontSize: '9pt' }}>Signature</div>
                <div style={{ marginTop: '8px', fontSize: '9pt' }}>
                  Date: ___________________
                </div>
              </div>
            ))
          ) : (
            <div style={{ marginBottom: '32px' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Sole Member: {managingMember}</div>
              {signatureImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={signatureImage} alt="Signature" style={{ height: '50px', marginBottom: '4px' }} />
              ) : (
                <div style={{ borderBottom: '1px solid #333', width: '280px', marginBottom: '4px', height: '40px' }} />
              )}
              <div style={{ fontSize: '9pt' }}>Signature</div>
              <div style={{ marginTop: '8px', fontSize: '9pt' }}>
                Date: ___________________
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ marginTop: '30px', borderTop: '1px solid #ccc', paddingTop: '10px', fontSize: '8pt', color: '#888', textAlign: 'center' }}>
          This Operating Agreement is a private document and shall not be filed with any government agency unless required by law.
        </div>
      </div>
    )
  }
)

export default OperatingAgreementTemplate
