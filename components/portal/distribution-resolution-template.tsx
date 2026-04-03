'use client'

import {
  type DocumentTemplateProps,
  formatDocumentAmount,
  formatLegalDate,
  getDocumentAddress,
  getManagingMember,
  numberToWords,
} from '@/lib/portal/document-templates'
import { forwardRef } from 'react'

/**
 * Distribution Resolution document template.
 * Renders legal HTML for PDF export via html2pdf.js.
 * Supports SMLLC, MMLLC, and Corporation entity types.
 */
const DistributionResolutionTemplate = forwardRef<HTMLDivElement, DocumentTemplateProps>(
  function DistributionResolutionTemplate({ company, members, form, entityCategory, signatureImage }, ref) {
    const address = getDocumentAddress(company.physicalAddress)
    const amountFormatted = formatDocumentAmount(form.amount, form.currency)
    const amountWords = numberToWords(form.amount)
    const dateFormatted = formatLegalDate(form.distributionDate)
    const managingMember = getManagingMember(members)

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
          {company.logoUrl && (
            <div style={{ marginBottom: '10px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={company.logoUrl}
                alt={company.companyName}
                style={{ maxHeight: '50px', maxWidth: '200px' }}
                crossOrigin="anonymous"
              />
            </div>
          )}
          <div style={{ fontSize: '16pt', fontWeight: 'bold', letterSpacing: '1px' }}>
            {company.companyName}
          </div>
          {company.ein && (
            <div style={{ fontSize: '9pt', color: '#555', marginTop: '4px' }}>
              EIN: {company.ein}
            </div>
          )}
          <div style={{ fontSize: '9pt', color: '#555', marginTop: '2px' }}>
            {address}
          </div>
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: '25px' }}>
          <div style={{ fontSize: '14pt', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>
            {entityCategory === 'Corporation'
              ? 'Resolution of the Board of Directors'
              : entityCategory === 'MMLLC'
                ? 'Resolution of the Members'
                : 'Resolution of the Sole Member'}
          </div>
          <div style={{ fontSize: '10pt', fontStyle: 'italic', marginTop: '4px', color: '#444' }}>
            Written Consent in Lieu of {entityCategory === 'Corporation' ? 'Board Meeting' : 'Meeting'}
          </div>
        </div>

        {/* Body */}
        <div style={{ textAlign: 'justify' }}>
          {/* --- SMLLC --- */}
          {entityCategory === 'SMLLC' && managingMember && (
            <>
              <p>
                The undersigned, <strong>{managingMember.fullName}</strong>, being the sole member of{' '}
                <strong>{company.companyName}</strong>, a {company.stateOfFormation} limited liability company
                (the &quot;Company&quot;), hereby adopts the following resolution by written consent in lieu of
                a formal meeting, pursuant to the Operating Agreement of the Company:
              </p>
              <p>
                <strong>WHEREAS</strong>, the Company has generated profits during the fiscal year ending
                December 31, {form.fiscalYear}; and
              </p>
              <p>
                <strong>WHEREAS</strong>, the sole member desires to authorize a distribution of profits
                from the Company;
              </p>
              <p>
                <strong>NOW, THEREFORE, BE IT RESOLVED</strong>, that the sole member hereby authorizes and
                directs the Company to distribute the sum of <strong>{amountFormatted}</strong>{' '}
                ({amountWords}) to the sole member, representing a distribution of profits for the fiscal
                year ending December 31, {form.fiscalYear}.
              </p>
              <p>
                <strong>FURTHER RESOLVED</strong>, that said distribution shall be made on or about{' '}
                <strong>{dateFormatted}</strong>, from the Company&apos;s operating account.
              </p>
              <p>
                <strong>FURTHER RESOLVED</strong>, that the Manager of the Company is hereby authorized to
                take all actions necessary to effectuate the foregoing resolution.
              </p>
            </>
          )}

          {/* --- MMLLC --- */}
          {entityCategory === 'MMLLC' && (
            <>
              <p>
                The undersigned, being all of the members of <strong>{company.companyName}</strong>,
                a {company.stateOfFormation} limited liability company (the &quot;Company&quot;), hereby
                adopt the following resolution by unanimous written consent in lieu of a formal meeting,
                pursuant to the Operating Agreement of the Company:
              </p>
              <p>
                <strong>WHEREAS</strong>, the Company has generated profits during the fiscal year ending
                December 31, {form.fiscalYear}; and
              </p>
              <p>
                <strong>WHEREAS</strong>, the members desire to authorize a distribution of profits from
                the Company to the members in accordance with their respective ownership interests;
              </p>
              <p>
                <strong>NOW, THEREFORE, BE IT RESOLVED</strong>, that the members hereby authorize and
                direct the Company to distribute the total sum of <strong>{amountFormatted}</strong>{' '}
                ({amountWords}) to the members in proportion to their ownership interests, as follows:
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', margin: '15px 0' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #333' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: '10pt' }}>Member</th>
                    <th style={{ textAlign: 'center', padding: '6px 8px', fontSize: '10pt' }}>Ownership %</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: '10pt' }}>Distribution Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, i) => {
                    const pct = m.ownershipPct ?? (100 / members.length)
                    const memberAmount = form.amount * (pct / 100)
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid #ddd' }}>
                        <td style={{ padding: '6px 8px', fontSize: '10pt' }}>{m.fullName}</td>
                        <td style={{ textAlign: 'center', padding: '6px 8px', fontSize: '10pt' }}>{pct}%</td>
                        <td style={{ textAlign: 'right', padding: '6px 8px', fontSize: '10pt' }}>
                          {formatDocumentAmount(memberAmount, form.currency)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p>
                The above distribution represents a distribution of profits for the fiscal year ending
                December 31, {form.fiscalYear}.
              </p>
              <p>
                <strong>FURTHER RESOLVED</strong>, that said distribution shall be made on or about{' '}
                <strong>{dateFormatted}</strong>, from the Company&apos;s operating account.
              </p>
              <p>
                <strong>FURTHER RESOLVED</strong>, that the Manager of the Company is hereby authorized to
                take all actions necessary to effectuate the foregoing resolution.
              </p>
            </>
          )}

          {/* --- Corporation --- */}
          {entityCategory === 'Corporation' && (
            <>
              <p>
                The undersigned, being {members.length > 1 ? 'all of the directors' : 'the sole director'} of{' '}
                <strong>{company.companyName}</strong>, a {company.stateOfFormation} corporation
                (the &quot;Corporation&quot;), hereby {members.length > 1 ? 'adopt' : 'adopts'} the
                following resolution by written consent in lieu of a{members.length > 1 ? ' regular' : ''} meeting
                of the Board of Directors:
              </p>
              <p>
                <strong>WHEREAS</strong>, the Corporation has generated profits during the fiscal year ending
                December 31, {form.fiscalYear}; and
              </p>
              <p>
                <strong>WHEREAS</strong>, the Board of Directors deems it advisable and in the best interest
                of the Corporation to declare and pay a dividend to its shareholders;
              </p>
              <p>
                <strong>NOW, THEREFORE, BE IT RESOLVED</strong>, that the Board of Directors hereby declares
                a dividend in the total amount of <strong>{amountFormatted}</strong> ({amountWords}),
                payable to the shareholders of record as of {dateFormatted}, in proportion to their
                respective shareholdings.
              </p>
              {members.length > 1 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', margin: '15px 0' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #333' }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: '10pt' }}>Shareholder</th>
                      <th style={{ textAlign: 'center', padding: '6px 8px', fontSize: '10pt' }}>Ownership %</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: '10pt' }}>Dividend Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m, i) => {
                      const pct = m.ownershipPct ?? (100 / members.length)
                      const memberAmount = form.amount * (pct / 100)
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #ddd' }}>
                          <td style={{ padding: '6px 8px', fontSize: '10pt' }}>{m.fullName}</td>
                          <td style={{ textAlign: 'center', padding: '6px 8px', fontSize: '10pt' }}>{pct}%</td>
                          <td style={{ textAlign: 'right', padding: '6px 8px', fontSize: '10pt' }}>
                            {formatDocumentAmount(memberAmount, form.currency)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              <p>
                <strong>FURTHER RESOLVED</strong>, that the dividend shall be paid on or about{' '}
                <strong>{dateFormatted}</strong>, from the Corporation&apos;s operating account.
              </p>
              <p>
                <strong>FURTHER RESOLVED</strong>, that the officers of the Corporation are hereby authorized
                to take all actions necessary to effectuate the foregoing resolution.
              </p>
            </>
          )}

          {/* Effective date */}
          <p style={{ marginTop: '20px' }}>
            This Written Consent shall be effective as of the date set forth below and shall be filed with
            the records of the {entityCategory === 'Corporation' ? 'Corporation' : 'Company'}.
          </p>
        </div>

        {/* Signature Block */}
        <div style={{ marginTop: '40px' }}>
          {entityCategory === 'SMLLC' && managingMember && (
            <div>
              <p>Date: {dateFormatted}</p>
              <div style={{ marginTop: '30px' }}>
                {signatureImage ? (
                  <div style={{ marginBottom: '5px' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={signatureImage} alt="Signature" style={{ height: '50px' }} />
                  </div>
                ) : (
                  <div style={{ borderBottom: '1px solid #333', width: '300px', height: '40px' }} />
                )}
                <div style={{ fontWeight: 'bold', marginTop: '5px' }}>{managingMember.fullName}</div>
                <div style={{ fontSize: '9pt', color: '#555' }}>Sole Member</div>
              </div>
            </div>
          )}

          {entityCategory === 'MMLLC' && (
            <div>
              <p>Date: {dateFormatted}</p>
              {members.map((m, i) => (
                <div key={i} style={{ marginTop: i === 0 ? '30px' : '25px' }}>
                  {signatureImage && i === 0 ? (
                    <div style={{ marginBottom: '5px' }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={signatureImage} alt="Signature" style={{ height: '50px' }} />
                    </div>
                  ) : (
                    <div style={{ borderBottom: '1px solid #333', width: '300px', height: '40px' }} />
                  )}
                  <div style={{ fontWeight: 'bold', marginTop: '5px' }}>{m.fullName}</div>
                  <div style={{ fontSize: '9pt', color: '#555' }}>
                    Member ({m.ownershipPct ?? Math.round(100 / members.length)}%)
                  </div>
                </div>
              ))}
            </div>
          )}

          {entityCategory === 'Corporation' && (
            <div>
              <p>Date: {dateFormatted}</p>
              {members.map((m, i) => (
                <div key={i} style={{ marginTop: i === 0 ? '30px' : '25px' }}>
                  {signatureImage && i === 0 ? (
                    <div style={{ marginBottom: '5px' }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={signatureImage} alt="Signature" style={{ height: '50px' }} />
                    </div>
                  ) : (
                    <div style={{ borderBottom: '1px solid #333', width: '300px', height: '40px' }} />
                  )}
                  <div style={{ fontWeight: 'bold', marginTop: '5px' }}>{m.fullName}</div>
                  <div style={{ fontSize: '9pt', color: '#555' }}>
                    {m.role === 'owner' ? 'Director' : m.role || 'Director'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }
)

export default DistributionResolutionTemplate
