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
 * Tax Statement / Certificate of Distribution and Tax Status.
 * Renders legal HTML for PDF export via html2pdf.js.
 * Supports SMLLC (disregarded entity), MMLLC (partnership), Corporation.
 */
const TaxStatementTemplate = forwardRef<HTMLDivElement, DocumentTemplateProps>(
  function TaxStatementTemplate({ company, members, form, entityCategory, signatureImage }, ref) {
    const address = getDocumentAddress(company.physicalAddress)
    const amountFormatted = formatDocumentAmount(form.amount, form.currency)
    const amountWords = numberToWords(form.amount)
    const dateFormatted = formatLegalDate(form.distributionDate)
    const managingMember = getManagingMember(members)
    const formationDateFormatted = company.formationDate
      ? formatLegalDate(company.formationDate)
      : 'N/A'

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
            Certificate of Distribution and Tax Status
          </div>
        </div>

        {/* Body */}
        <div style={{ textAlign: 'justify' }}>
          <p><strong>Date:</strong> {dateFormatted}</p>
          <p><strong>To Whom It May Concern:</strong></p>

          <p>
            This certificate is issued by <strong>{company.companyName}</strong>, a limited liability
            {entityCategory === 'Corporation' ? ' corporation' : ' company'} organized under the laws of
            the State of <strong>{company.stateOfFormation || 'N/A'}</strong>, United States of America
            (EIN: <strong>{company.ein || 'N/A'}</strong>), formed on{' '}
            <strong>{formationDateFormatted}</strong> (the
            &quot;{entityCategory === 'Corporation' ? 'Corporation' : 'Company'}&quot;).
          </p>

          {/* Section 1: Entity Classification */}
          <p>
            <strong>1. Entity Classification.</strong>{' '}
            {entityCategory === 'SMLLC' && managingMember && (
              <>
                The Company is a single-member
                limited liability company wholly owned by <strong>{managingMember.fullName}</strong>.
                Pursuant to U.S. Treasury Regulation Section 301.7701-3, the Company is classified as a{' '}
                <strong>disregarded entity</strong> for United States federal income tax purposes. As such,
                the Company is not treated as a separate taxable entity, and its activities are reported on
                the income tax return of its sole owner.
              </>
            )}
            {entityCategory === 'MMLLC' && (
              <>
                The Company is a multi-member limited liability company owned by the following members:
              </>
            )}
            {entityCategory === 'Corporation' && (
              <>
                The Corporation is a {company.stateOfFormation} corporation owned by the following
                shareholders:
              </>
            )}
          </p>

          {(entityCategory === 'MMLLC' || entityCategory === 'Corporation') && (
            <table style={{ width: '100%', borderCollapse: 'collapse', margin: '10px 0 15px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #333' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: '10pt' }}>
                    {entityCategory === 'Corporation' ? 'Shareholder' : 'Member'}
                  </th>
                  <th style={{ textAlign: 'center', padding: '6px 8px', fontSize: '10pt' }}>Ownership %</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #ddd' }}>
                    <td style={{ padding: '6px 8px', fontSize: '10pt' }}>{m.fullName}</td>
                    <td style={{ textAlign: 'center', padding: '6px 8px', fontSize: '10pt' }}>
                      {m.ownershipPct ?? Math.round(100 / members.length)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {entityCategory === 'MMLLC' && (
            <p>
              Pursuant to U.S. Treasury Regulation Section 301.7701-3, the Company is classified as a{' '}
              <strong>partnership</strong> for United States federal income tax purposes. As such, the
              Company files an informational tax return (Form 1065) and issues Schedule K-1 to each member
              reporting their respective share of income, deductions, and credits.
            </p>
          )}

          {entityCategory === 'Corporation' && (
            <p>
              The Corporation files a U.S. corporate income tax return (Form 1120) and is subject to
              United States federal corporate income tax on its taxable income.
            </p>
          )}

          {/* Section 2: Distribution of Profits */}
          <p>
            <strong>2. Distribution of Profits.</strong>{' '}
            On or about <strong>{dateFormatted}</strong>, the{' '}
            {entityCategory === 'Corporation' ? 'Corporation' : 'Company'} authorized and made a
            distribution of <strong>{amountFormatted}</strong> ({amountWords})
            {entityCategory === 'SMLLC' && managingMember && (
              <> to its sole member, <strong>{managingMember.fullName}</strong>,</>
            )}
            {entityCategory === 'MMLLC' && <> to its members in proportion to their ownership interests,</>}
            {entityCategory === 'Corporation' && <> to its shareholders in proportion to their shareholdings,</>}
            {' '}representing a distribution of profits for the fiscal year ending December 31, {form.fiscalYear}.
          </p>

          {(entityCategory === 'MMLLC' || entityCategory === 'Corporation') && members.length > 1 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', margin: '10px 0 15px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #333' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: '10pt' }}>
                    {entityCategory === 'Corporation' ? 'Shareholder' : 'Member'}
                  </th>
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
                      <td style={{ textAlign: 'right', padding: '6px 8px', fontSize: '10pt' }}>
                        {formatDocumentAmount(memberAmount, form.currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* Section 3: US Tax Status */}
          <p>
            <strong>3. United States Tax Status.</strong>{' '}
            {entityCategory === 'SMLLC' && (
              <>
                As a disregarded entity owned by a foreign person who is not engaged in a U.S. trade or
                business generating effectively connected income, the Company confirms that:
              </>
            )}
            {entityCategory === 'MMLLC' && (
              <>
                As a partnership for U.S. tax purposes with foreign members, the Company confirms that:
              </>
            )}
            {entityCategory === 'Corporation' && (
              <>
                With respect to the dividend distribution described above, the Corporation confirms that:
              </>
            )}
          </p>

          <div style={{ marginLeft: '30px' }}>
            {entityCategory === 'SMLLC' && (
              <>
                <p>
                  (a) No United States federal corporate income tax has been assessed or paid by the
                  Company on the distributed amount;
                </p>
                <p>
                  (b) No United States federal withholding tax has been withheld from the distribution
                  to the sole member;
                </p>
                <p>
                  (c) The Company has fulfilled its U.S. reporting obligations by filing Form 5472 with
                  a pro forma Form 1120 with the Internal Revenue Service for the applicable tax year.
                </p>
              </>
            )}
            {entityCategory === 'MMLLC' && (
              <>
                <p>
                  (a) The Company, as a partnership, is not itself subject to United States federal
                  income tax. Income is passed through to individual members via Schedule K-1;
                </p>
                <p>
                  (b) No United States federal withholding tax has been withheld from the distribution
                  to the foreign members, as the Company is not engaged in a U.S. trade or business
                  generating effectively connected income;
                </p>
                <p>
                  (c) The Company has fulfilled its U.S. reporting obligations by filing Form 1065
                  (U.S. Return of Partnership Income) and issuing Schedule K-1 to each member for the
                  applicable tax year.
                </p>
              </>
            )}
            {entityCategory === 'Corporation' && (
              <>
                <p>
                  (a) The Corporation has filed its U.S. corporate income tax return (Form 1120) for
                  the applicable tax year and has paid or will pay any corporate income tax due thereon;
                </p>
                <p>
                  (b) The dividend distribution to shareholders represents a post-tax distribution of
                  corporate earnings and profits;
                </p>
                <p>
                  (c) No additional United States federal withholding tax has been applied to the
                  dividend distribution to the foreign shareholders, in accordance with the applicable
                  tax treaty provisions, if any.
                </p>
              </>
            )}
          </div>

          {/* Section 4: Purpose */}
          <p>
            <strong>4. Purpose.</strong>{' '}
            This certificate is issued at the request of the{' '}
            {entityCategory === 'SMLLC' ? 'sole member' : entityCategory === 'MMLLC' ? 'members' : 'shareholders'}{' '}
            for the purpose of presenting to the relevant tax authorities in the{' '}
            {entityCategory === 'SMLLC' ? "member's" : "recipients'"} country of residence to document
            the origin of the distribution and the{' '}
            {entityCategory === 'Corporation'
              ? 'tax treatment thereof.'
              : 'absence of United States taxation thereon.'}
          </p>
        </div>

        {/* Closing */}
        <div style={{ marginTop: '40px' }}>
          <p><strong>{company.companyName}</strong></p>
          <div style={{ marginTop: '30px' }}>
            {signatureImage ? (
              <div style={{ marginBottom: '5px' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={signatureImage} alt="Signature" style={{ height: '50px' }} />
              </div>
            ) : (
              <div>
                By: <span style={{ borderBottom: '1px solid #333', display: 'inline-block', width: '250px', height: '30px' }} />
              </div>
            )}
            <div style={{ fontWeight: 'bold', marginTop: '5px' }}>
              {managingMember?.fullName || members[0]?.fullName || 'N/A'}
            </div>
            <div style={{ fontSize: '9pt', color: '#555' }}>
              {entityCategory === 'SMLLC' ? 'Sole Member' : entityCategory === 'MMLLC' ? 'Managing Member' : 'President'}
            </div>
          </div>
          <p style={{ marginTop: '15px' }}>Date: {dateFormatted}</p>
        </div>
      </div>
    )
  }
)

export default TaxStatementTemplate
