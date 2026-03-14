/**
 * Operating Agreement Templates — Single Member LLC
 * State-specific templates for NM, WY, FL (English only)
 *
 * Each template is a function that receives OA data and returns
 * an array of sections for rendering in the frontend.
 */

export interface OAData {
  company_name: string
  state_of_formation: string
  formation_date: string
  ein_number?: string
  member_name: string
  member_address?: string
  effective_date: string
  business_purpose: string
  initial_contribution: string
  fiscal_year_end: string
  accounting_method: string
  duration: string
  registered_agent_name?: string
  registered_agent_address?: string
  principal_address: string
}

export interface OASection {
  title: string
  content: string
}

// ─── State-specific governing law clauses ────────────────────

const GOVERNING_LAW: Record<string, string> = {
  NM: "This Agreement shall be governed by and construed in accordance with the New Mexico Limited Liability Company Act, NMSA 1978, Sections 53-19-1 through 53-19-74.",
  WY: "This Agreement shall be governed by and construed in accordance with the Wyoming Limited Liability Company Act, W.S. 17-29-101 through 17-29-1104.",
  FL: "This Agreement shall be governed by and construed in accordance with the Florida Revised Limited Liability Company Act, FL Stat Chapter 605.",
}

const STATE_FULL_NAME: Record<string, string> = {
  NM: "New Mexico",
  WY: "Wyoming",
  FL: "Florida",
}

// ─── State-specific additional clauses ───────────────────────

function getStateSpecificClauses(state: string): OASection[] {
  switch (state) {
    case "NM":
      return [
        {
          title: "Confidentiality of Agreement",
          content:
            "The State of New Mexico does not require disclosure of members or managers in public filings. This Agreement shall not be filed with any state office and shall remain confidential. This Agreement is the sole document establishing and proving the Member's ownership interest in the Company.",
        },
        {
          title: "Record Retention",
          content:
            "Pursuant to NMSA 53-19-19, the Company shall maintain a copy of this Agreement and all prior versions and amendments at its principal place of business. This Agreement must be in written form to be valid under New Mexico law (NMSA 53-19-2).",
        },
      ]

    case "WY":
      return [
        {
          title: "Charging Order Protection",
          content:
            "A judgment creditor of the Member shall have no right to obtain possession of, or exercise legal or equitable remedies with respect to, the property of the Company. The charging order shall be the sole and exclusive remedy available to a creditor of the Member, in accordance with W.S. 17-29-503. No lien may be placed against the Member's interest in the Company.",
        },
        {
          title: "Annual Report Compliance",
          content:
            "The Company shall file an annual report with the Wyoming Secretary of State on or before the anniversary date of its formation each year, and pay the required annual license tax (minimum $60 or as determined by Wyoming assets).",
        },
      ]

    case "FL":
      return [
        {
          title: "Fiduciary Duties",
          content:
            "The Member's duties of loyalty and care shall be as set forth in FL Stat 605.04091. These duties may be modified but not eliminated by this Agreement, and any modification must not be manifestly unreasonable as determined by a court. Nothing in this Agreement shall relieve the Member or any Manager from liability for conduct involving bad faith, willful or intentional misconduct, or knowing violation of law (FL Stat 605.0105).",
        },
        {
          title: "Annual Report Compliance",
          content:
            "The Company shall file an annual report with the Florida Division of Corporations by May 1 of each year and pay the required filing fee ($138.75 or as updated by the State). Failure to file by the third supplemental due date may result in administrative dissolution.",
        },
        {
          title: "State Tax Treatment",
          content:
            "The Company is formed in the State of Florida, which imposes no personal income tax on individuals. The Member's distributive share of Company income shall be subject to federal income tax only, unless the Company operates in other states that impose income tax obligations.",
        },
      ]

    default:
      return []
  }
}

// ─── Main template generator ─────────────────────────────────

export function generateOASections(data: OAData): OASection[] {
  const state = data.state_of_formation.toUpperCase()
  const stateName = STATE_FULL_NAME[state] || data.state_of_formation

  const sections: OASection[] = [
    // ─── ARTICLE I: FORMATION ───
    {
      title: "Article I — Formation",
      content: `1.1 Formation. ${data.member_name} (the "Member") hereby forms a single-member limited liability company (the "Company") under the laws of the State of ${stateName}. The Company was formed by filing Articles of Organization with the ${stateName} filing office on ${data.formation_date}.

1.2 Name. The name of the Company is ${data.company_name}.${data.ein_number ? ` The Company's Employer Identification Number (EIN) is ${data.ein_number}.` : ""}

1.3 Principal Office. The principal office of the Company shall be located at ${data.principal_address}, or at such other place as the Member may designate from time to time.

1.4 Registered Agent. The registered agent and office of the Company is:
${data.registered_agent_name || "As designated in the Articles of Organization"}
${data.registered_agent_address || ""}
The registered agent may be changed by filing the appropriate form with the state filing office.

1.5 Purpose. The Company is formed for the purpose of ${data.business_purpose}. The Company may engage in any and all lawful business activities permitted under the laws of ${stateName}.

1.6 Duration. The duration of the Company shall be ${data.duration.toLowerCase()}, unless sooner dissolved in accordance with this Agreement or by operation of law.

1.7 Effective Date. This Operating Agreement is effective as of ${data.effective_date}.`,
    },

    // ─── ARTICLE II: MEMBERSHIP ───
    {
      title: "Article II — Membership",
      content: `2.1 Sole Member. The sole Member of the Company is:

Name: ${data.member_name}
Address: ${data.member_address || "As on file with the Company"}
Ownership: 100%

2.2 Limited Liability. The Member shall not be personally liable for any debts, obligations, or liabilities of the Company, whether arising in contract, tort, or otherwise, solely by reason of being a member of the Company.

2.3 Management. The Company shall be member-managed. The Member shall have full and exclusive authority to manage the business and affairs of the Company, and shall have all powers available to a manager under the laws of ${stateName}.

2.4 Compensation. The Member shall not receive compensation solely for services as a member or manager of the Company. The Member may be reimbursed for reasonable expenses incurred on behalf of the Company and may receive compensation for services rendered in other capacities.`,
    },

    // ─── ARTICLE III: CAPITAL ───
    {
      title: "Article III — Capital Contributions",
      content: `3.1 Initial Contribution. The Member has made an initial capital contribution to the Company of ${data.initial_contribution}. The Member's percentage interest in the Company is 100%.

3.2 Additional Contributions. The Member may make additional capital contributions at any time. No additional contributions are required.

3.3 Capital Account. A capital account shall be maintained for the Member in accordance with applicable provisions of the Internal Revenue Code and corresponding regulations. The capital account shall reflect the Member's contributions, share of profits and losses, distributions, and other adjustments as required by law.

3.4 No Interest. No interest shall be paid on capital contributions or on the balance of the Member's capital account.`,
    },

    // ─── ARTICLE IV: PROFITS, LOSSES, AND DISTRIBUTIONS ───
    {
      title: "Article IV — Profits, Losses, and Distributions",
      content: `4.1 Allocation. All profits, losses, and other tax items of the Company shall be allocated entirely to the Member.

4.2 Distributions. The Member may make distributions of Company cash or property at any time and in any amount, subject to applicable law regarding the solvency of the Company at the time of distribution.

4.3 Tax Classification. The Company shall be classified as a disregarded entity for federal income tax purposes, with all income and expenses reported on the Member's individual tax return. The Member may elect to change the tax classification by filing IRS Form 8832, Entity Classification Election.

4.4 Tax Year and Method. The tax year of the Company shall end on ${data.fiscal_year_end}. The Company shall use the ${data.accounting_method.toLowerCase()} method of accounting.`,
    },

    // ─── ARTICLE V: BANKING AND RECORDS ───
    {
      title: "Article V — Banking and Records",
      content: `5.1 Bank Accounts. The Company shall maintain one or more bank accounts in the name of the Company. The Member shall be the sole authorized signatory on all Company accounts. Company funds shall not be commingled with the personal funds of the Member.

5.2 Records. The Company shall maintain at its principal office:
(a) A copy of the Articles of Organization and all amendments thereto;
(b) A copy of this Operating Agreement and all amendments thereto;
(c) The Company's federal, state, and local income tax returns for the three most recent years;
(d) The Company's financial statements and books of account;
(e) A record of the name and address of the Member.

5.3 Title to Assets. All real and personal property owned by the Company shall be held in the name of the Company, not in the name of the Member individually.`,
    },

    // ─── ARTICLE VI: TRANSFER AND ASSIGNMENT ───
    {
      title: "Article VI — Transfer and Assignment",
      content: `6.1 Transfer of Interest. The Member may freely transfer, assign, or convey all or any portion of the Member's interest in the Company at any time without restriction.

6.2 Admission of New Members. The Member may admit additional members to the Company at any time. Upon admission of a new member, this Agreement shall be amended to reflect the new membership structure.`,
    },

    // ─── ARTICLE VII: DISSOLUTION ───
    {
      title: "Article VII — Dissolution",
      content: `7.1 Events of Dissolution. The Company shall be dissolved upon the occurrence of any of the following events:
(a) The written decision of the Member to dissolve the Company;
(b) The death or permanent incapacity of the Member, unless a successor is designated;
(c) Entry of a decree of judicial dissolution;
(d) Any event that makes it unlawful for the Company to continue its business.

7.2 Winding Up. Upon dissolution, the Member (or a designated representative) shall wind up the Company's affairs, liquidate its assets, pay its debts and obligations, and distribute any remaining assets to the Member.

7.3 Articles of Dissolution. Upon completion of winding up, the Member shall file Articles of Dissolution (or equivalent document) with the ${stateName} filing office.`,
    },

    // ─── STATE-SPECIFIC CLAUSES ───
    ...getStateSpecificClauses(state),

    // ─── ARTICLE VIII: GENERAL PROVISIONS ───
    {
      title: "Article VIII — General Provisions",
      content: `8.1 Indemnification. The Company shall indemnify the Member and any authorized officers, agents, or employees for all costs, losses, liabilities, and damages incurred in connection with the business of the Company, to the extent permitted by the laws of ${stateName}.

8.2 Governing Law. ${GOVERNING_LAW[state] || `This Agreement shall be governed by the laws of the State of ${stateName}.`}

8.3 Amendments. This Agreement may be amended only by a written instrument signed by the Member.

8.4 Entire Agreement. This Operating Agreement constitutes the entire agreement regarding the affairs of the Company and supersedes any prior oral or written agreements.

8.5 Severability. If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.`,
    },
  ]

  return sections
}

// ─── Supported states ────────────────────────────────────────

export const OA_SUPPORTED_STATES = ["NM", "WY", "FL"] as const
export type OASupportedState = (typeof OA_SUPPORTED_STATES)[number]
