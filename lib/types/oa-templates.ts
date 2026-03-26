/**
 * Operating Agreement Templates — SMLLC & MMLLC
 * State-specific templates for NM, WY, FL (English only)
 * All LLCs are Manager-Managed.
 *
 * Dimensions: entity_type (SMLLC | MMLLC) x state (NM | WY | FL)
 */

// ─── Types ───────────────────────────────────────────────

export interface OAMember {
  name: string
  address?: string
  email?: string
  ownership_pct: number
  initial_contribution: string
}

export interface OAData {
  company_name: string
  state_of_formation: string
  formation_date: string
  ein_number?: string
  entity_type: "SMLLC" | "MMLLC"
  member_name: string
  member_address?: string
  members?: OAMember[]
  manager_name: string
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
  DE: "This Agreement shall be governed by and construed in accordance with the Delaware Limited Liability Company Act, 6 Del. C. Chapter 18.",
}

const STATE_FULL_NAME: Record<string, string> = {
  NM: "New Mexico",
  WY: "Wyoming",
  FL: "Florida",
  DE: "Delaware",
}

// ─── State-specific additional clauses ───────────────────────

function getStateSpecificClauses(state: string, isMM: boolean): OASection[] {
  const memberRef = isMM ? "Members" : "Member"

  switch (state) {
    case "NM":
      return [
        {
          title: "Confidentiality of Agreement",
          content:
            `The State of New Mexico does not require disclosure of members or managers in public filings. This Agreement shall not be filed with any state office and shall remain confidential. This Agreement is the sole document establishing and proving the ${memberRef}'s ownership interest in the Company.`,
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
            `A judgment creditor of any ${memberRef} shall have no right to obtain possession of, or exercise legal or equitable remedies with respect to, the property of the Company. The charging order shall be the sole and exclusive remedy available to a creditor of any ${memberRef}, in accordance with W.S. 17-29-503. No lien may be placed against any ${memberRef}'s interest in the Company.`,
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
            `The ${memberRef}'s duties of loyalty and care shall be as set forth in FL Stat 605.04091. These duties may be modified but not eliminated by this Agreement, and any modification must not be manifestly unreasonable as determined by a court. Nothing in this Agreement shall relieve any Member or Manager from liability for conduct involving bad faith, willful or intentional misconduct, or knowing violation of law (FL Stat 605.0105).`,
        },
        {
          title: "Annual Report Compliance",
          content:
            "The Company shall file an annual report with the Florida Division of Corporations by May 1 of each year and pay the required filing fee ($138.75 or as updated by the State). Failure to file by the third supplemental due date may result in administrative dissolution.",
        },
        {
          title: "State Tax Treatment",
          content:
            `The Company is formed in the State of Florida, which imposes no personal income tax on individuals. Each ${memberRef}'s distributive share of Company income shall be subject to federal income tax only, unless the Company operates in other states that impose income tax obligations.`,
        },
      ]

    case "DE":
      return [
        {
          title: "Limited Liability Protection",
          content:
            `Pursuant to 6 Del. C. Section 18-303, no ${memberRef} shall be obligated personally for any debt, obligation, or liability of the Company solely by reason of being a ${memberRef}. The Company's debts, obligations, and liabilities, whether arising in contract, tort, or otherwise, shall be solely the debts, obligations, and liabilities of the Company.`,
        },
        {
          title: "Freedom of Contract",
          content:
            `Delaware's LLC Act (6 Del. C. Section 18-1101) gives maximum effect to the principle of freedom of contract and to the enforceability of this Agreement. It is the policy of the State of Delaware to give maximum effect to the terms of this Agreement. To the extent permitted by Delaware law, the provisions of this Agreement shall supersede any contrary provisions of the Delaware LLC Act.`,
        },
        {
          title: "Annual Tax",
          content:
            "The Company shall pay the annual franchise tax of $300 to the State of Delaware on or before June 1 of each year, as required by 6 Del. C. Section 18-1107. Failure to pay may result in penalties and administrative dissolution.",
        },
      ]

    default:
      return []
  }
}

// ─── Initial Resolutions ─────────────────────────────────────

function generateInitialResolutions(data: OAData, stateName: string): OASection {
  return {
    title: "Initial Resolutions of the Manager",
    content: `The undersigned, being the Manager of ${data.company_name}, a ${stateName} limited liability company (the "Company"), hereby adopts the following resolutions effective as of ${data.effective_date}:

RESOLVED, that the Manager is authorized to open bank accounts in the name of the Company with such financial institutions as the Manager may determine, and to designate authorized signatories for such accounts;

RESOLVED, that the Manager is authorized to apply for an Employer Identification Number (EIN) from the Internal Revenue Service on behalf of the Company;

RESOLVED, that the Manager is authorized to execute and deliver any and all documents, agreements, certificates, and instruments necessary or desirable to carry out the purposes and business of the Company;

RESOLVED, that the Company shall elect to be treated as ${data.entity_type === "SMLLC" ? "a disregarded entity" : "a partnership"} for federal income tax purposes, unless the Manager determines that a different tax classification would be in the best interest of the Company and its Members;

RESOLVED, that the fiscal year of the Company shall end on ${data.fiscal_year_end}, and the Company shall use the ${data.accounting_method.toLowerCase()} method of accounting;

RESOLVED, that the principal office of the Company shall be located at ${data.principal_address}, or at such other place as the Manager may from time to time designate;

RESOLVED, that the Manager is authorized to enter into intercompany agreements, including but not limited to Intercompany Transfer Agreements, Intercompany Loan Agreements, and Management Services Agreements, with any Member entity or affiliated entity of the Company, on commercially reasonable terms;

RESOLVED, that the Manager is authorized to take any and all actions necessary to comply with the laws and regulations of the State of ${stateName} and any other jurisdiction in which the Company conducts business.

These resolutions are effective as of the date first set forth above.

Manager: ${data.manager_name}`,
  }
}

// ─── Members table formatter ─────────────────────────────────

function formatMembersTable(members: OAMember[]): string {
  return members.map((m, i) => {
    return `Member ${i + 1}:
Name: ${m.name}
Address: ${m.address || "As on file with the Company"}
Ownership: ${m.ownership_pct}%
Initial Contribution: ${m.initial_contribution}`
  }).join("\n\n")
}

// ─── SMLLC Template Generator ────────────────────────────────

function generateSMLLCSections(data: OAData, state: string, stateName: string): OASection[] {
  return [
    {
      title: "Article I — Formation",
      content: `1.1 Formation. ${data.member_name} (the "Member") hereby forms a single-member limited liability company (the "Company") under the laws of the State of ${stateName}. The Company was formed by filing Articles of Organization with the ${stateName} filing office on ${data.formation_date}.

1.2 Name. The name of the Company is ${data.company_name}.${data.ein_number ? ` The Company's Employer Identification Number (EIN) is ${data.ein_number}.` : ""}

1.3 Principal Office. The principal office of the Company shall be located at ${data.principal_address}, or at such other place as the Manager may designate from time to time.

1.4 Registered Agent. The registered agent and office of the Company is:
${data.registered_agent_name || "As designated in the Articles of Organization"}
${data.registered_agent_address || ""}
The registered agent may be changed by filing the appropriate form with the state filing office.

1.5 Purpose. The Company is formed for the purpose of ${data.business_purpose}. The Company may engage in any and all lawful business activities permitted under the laws of ${stateName}.

1.6 Duration. The duration of the Company shall be ${data.duration.toLowerCase()}, unless sooner dissolved in accordance with this Agreement or by operation of law.

1.7 Effective Date. This Operating Agreement is effective as of ${data.effective_date}.`,
    },
    {
      title: "Article II — Membership",
      content: `2.1 Sole Member. The sole Member of the Company is:

Name: ${data.member_name}
Address: ${data.member_address || "As on file with the Company"}
Ownership: 100%

2.2 Limited Liability. The Member shall not be personally liable for any debts, obligations, or liabilities of the Company, whether arising in contract, tort, or otherwise, solely by reason of being a member of the Company.

2.3 Management. The Company shall be manager-managed. ${data.manager_name} is hereby designated as the Manager of the Company. The Manager shall have full and exclusive authority to manage the business and affairs of the Company, and shall have all powers available to a manager under the laws of ${stateName}. The Manager may appoint officers, employees, and agents as the Manager deems necessary.

2.4 Compensation. The Member shall not receive compensation solely for services as a member of the Company. The Manager may receive reasonable compensation for services rendered to the Company in the capacity of Manager, as determined from time to time.`,
    },
    {
      title: "Article III — Capital Contributions",
      content: `3.1 Initial Contribution. The Member has made an initial capital contribution to the Company of ${data.initial_contribution}. The Member's percentage interest in the Company is 100%.

3.2 Additional Contributions. The Member may make additional capital contributions at any time. No additional contributions are required.

3.3 Capital Account. A capital account shall be maintained for the Member in accordance with applicable provisions of the Internal Revenue Code and corresponding regulations. The capital account shall reflect the Member's contributions, share of profits and losses, distributions, and other adjustments as required by law.

3.4 No Interest. No interest shall be paid on capital contributions or on the balance of the Member's capital account.`,
    },
    {
      title: "Article IV — Profits, Losses, and Distributions",
      content: `4.1 Allocation. All profits, losses, and other tax items of the Company shall be allocated entirely to the Member.

4.2 Distributions. The Manager may make distributions of Company cash or property at any time and in any amount, subject to applicable law regarding the solvency of the Company at the time of distribution.

4.3 Tax Classification. The Company shall be classified as a disregarded entity for federal income tax purposes, with all income and expenses reported on the Member's individual tax return. The Member may elect to change the tax classification by filing IRS Form 8832, Entity Classification Election.

4.4 Tax Year and Method. The tax year of the Company shall end on ${data.fiscal_year_end}. The Company shall use the ${data.accounting_method.toLowerCase()} method of accounting.`,
    },
    {
      title: "Article V — Banking and Records",
      content: `5.1 Bank Accounts. The Company shall maintain one or more bank accounts in the name of the Company. The Manager shall be the sole authorized signatory on all Company accounts. Company funds shall not be commingled with the personal funds of any Member.

5.2 Records. The Company shall maintain at its principal office:
(a) A copy of the Articles of Organization and all amendments thereto;
(b) A copy of this Operating Agreement and all amendments thereto;
(c) The Company's federal, state, and local income tax returns for the three most recent years;
(d) The Company's financial statements and books of account;
(e) A record of the name and address of each Member and Manager.

5.3 Title to Assets. All real and personal property owned by the Company shall be held in the name of the Company, not in the name of any Member individually.`,
    },
    {
      title: "Article VI — Transfer and Assignment",
      content: `6.1 Transfer of Interest. The Member may freely transfer, assign, or convey all or any portion of the Member's interest in the Company at any time without restriction.

6.2 Admission of New Members. The Manager may admit additional members to the Company at any time. Upon admission of a new member, this Agreement shall be amended to reflect the new membership structure.`,
    },
    {
      title: "Article VII — Dissolution",
      content: `7.1 Events of Dissolution. The Company shall be dissolved upon the occurrence of any of the following events:
(a) The written decision of the Manager to dissolve the Company;
(b) The death or permanent incapacity of the sole Member, unless a successor is designated;
(c) Entry of a decree of judicial dissolution;
(d) Any event that makes it unlawful for the Company to continue its business.

7.2 Winding Up. Upon dissolution, the Manager (or a designated representative) shall wind up the Company's affairs, liquidate its assets, pay its debts and obligations, and distribute any remaining assets to the Member.

7.3 Articles of Dissolution. Upon completion of winding up, the Manager shall file Articles of Dissolution (or equivalent document) with the ${stateName} filing office.`,
    },
    ...getStateSpecificClauses(state, false),
    {
      title: "Article VIII — General Provisions",
      content: `8.1 Indemnification. The Company shall indemnify the Manager, the Member, and any authorized officers, agents, or employees for all costs, losses, liabilities, and damages incurred in connection with the business of the Company, to the extent permitted by the laws of ${stateName}.

8.2 Governing Law. ${GOVERNING_LAW[state] || `This Agreement shall be governed by the laws of the State of ${stateName}.`}

8.3 Amendments. This Agreement may be amended only by a written instrument signed by the Member.

8.4 Entire Agreement. This Operating Agreement constitutes the entire agreement regarding the affairs of the Company and supersedes any prior oral or written agreements.

8.5 Severability. If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.`,
    },
  ]
}

// ─── MMLLC Template Generator ────────────────────────────────

function generateMMLLCSections(data: OAData, state: string, stateName: string): OASection[] {
  const members = data.members || []

  return [
    {
      title: "Article I — Formation",
      content: `1.1 Formation. The undersigned Members hereby form a multi-member limited liability company (the "Company") under the laws of the State of ${stateName}. The Company was formed by filing Articles of Organization with the ${stateName} filing office on ${data.formation_date}.

1.2 Name. The name of the Company is ${data.company_name}.${data.ein_number ? ` The Company's Employer Identification Number (EIN) is ${data.ein_number}.` : ""}

1.3 Principal Office. The principal office of the Company shall be located at ${data.principal_address}, or at such other place as the Manager may designate from time to time.

1.4 Registered Agent. The registered agent and office of the Company is:
${data.registered_agent_name || "As designated in the Articles of Organization"}
${data.registered_agent_address || ""}
The registered agent may be changed by filing the appropriate form with the state filing office.

1.5 Purpose. The Company is formed for the purpose of ${data.business_purpose}. The Company may engage in any and all lawful business activities permitted under the laws of ${stateName}.

1.6 Duration. The duration of the Company shall be ${data.duration.toLowerCase()}, unless sooner dissolved in accordance with this Agreement or by operation of law.

1.7 Effective Date. This Operating Agreement is effective as of ${data.effective_date}.`,
    },
    {
      title: "Article II — Membership",
      content: `2.1 Members. The Members of the Company, their addresses, and their respective ownership interests are as follows:

${formatMembersTable(members)}

2.2 Limited Liability. No Member shall be personally liable for any debts, obligations, or liabilities of the Company, whether arising in contract, tort, or otherwise, solely by reason of being a member of the Company.

2.3 Management. The Company shall be manager-managed. ${data.manager_name} is hereby designated as the Manager of the Company. The Manager shall have full and exclusive authority to manage the business and affairs of the Company, and shall have all powers available to a manager under the laws of ${stateName}. The Manager may appoint officers, employees, and agents as the Manager deems necessary. No Member, solely by virtue of being a Member, shall have the authority to bind the Company.

2.4 Compensation. No Member shall receive compensation solely for services as a member of the Company. The Manager may receive reasonable compensation for services rendered to the Company in the capacity of Manager, as determined from time to time.

2.5 Voting. Each Member shall have voting rights in proportion to their respective ownership interest. Except as otherwise provided in this Agreement, decisions requiring Member approval shall require a majority vote of the Members based on ownership percentages.`,
    },
    {
      title: "Article III — Capital Contributions",
      content: `3.1 Initial Contributions. The Members have made the following initial capital contributions to the Company:

${members.map(m => `${m.name}: ${m.initial_contribution} (${m.ownership_pct}% interest)`).join("\n")}

3.2 Additional Contributions. Members may make additional capital contributions with the consent of the Manager. No additional contributions are required unless unanimously agreed upon by all Members.

3.3 Capital Accounts. A separate capital account shall be maintained for each Member in accordance with applicable provisions of the Internal Revenue Code and corresponding regulations. Each capital account shall reflect the Member's contributions, share of profits and losses, distributions, and other adjustments as required by law.

3.4 No Interest. No interest shall be paid on capital contributions or on the balance of any Member's capital account.`,
    },
    {
      title: "Article IV — Profits, Losses, and Distributions",
      content: `4.1 Allocation. All profits, losses, and other tax items of the Company shall be allocated among the Members in proportion to their respective ownership interests.

4.2 Distributions. The Manager may make distributions of Company cash or property at any time, in proportion to the Members' respective ownership interests, subject to applicable law regarding the solvency of the Company at the time of distribution.

4.3 Tax Classification. The Company shall be classified as a partnership for federal income tax purposes, with each Member's share of income and expenses reported on Schedule K-1. The Manager may elect to change the tax classification by filing IRS Form 8832, Entity Classification Election, with the consent of all Members.

4.4 Tax Year and Method. The tax year of the Company shall end on ${data.fiscal_year_end}. The Company shall use the ${data.accounting_method.toLowerCase()} method of accounting.

4.5 Tax Matters Partner. ${data.manager_name} shall serve as the Tax Matters Partner (or Partnership Representative under the Bipartisan Budget Act) for federal income tax purposes and shall have all powers and responsibilities associated with that role.

4.6 Non-Pro-Rata Distributions. Notwithstanding Section 4.2, the Manager may authorize non-pro-rata distributions to one or more Members when such distributions serve a legitimate business purpose, including but not limited to intercompany fund transfers between the Company and its Member entities. Any non-pro-rata distribution shall be documented in writing by the Manager and reflected in the Members' capital accounts.

4.7 Intercompany Transfers. Where a Member is a legal entity (e.g., another LLC or corporation), the Manager is authorized to enter into intercompany agreements with such Member entities for the transfer of funds, services, or other consideration between the Company and the Member entity. Such intercompany transactions shall be conducted on commercially reasonable terms, documented in a written Intercompany Transfer Agreement, and properly reflected in the Company's books and records. These transfers may include, without limitation, treasury management, capital contributions, distributions, loans, or service fees.`,
    },
    {
      title: "Article V — Banking and Records",
      content: `5.1 Bank Accounts. The Company shall maintain one or more bank accounts in the name of the Company. The Manager shall be the authorized signatory on all Company accounts. Company funds shall not be commingled with the personal funds of any Member.

5.2 Records. The Company shall maintain at its principal office:
(a) A copy of the Articles of Organization and all amendments thereto;
(b) A copy of this Operating Agreement and all amendments thereto;
(c) The Company's federal, state, and local income tax returns for the three most recent years;
(d) The Company's financial statements and books of account;
(e) A record of the name and address of each Member and Manager.

5.3 Title to Assets. All real and personal property owned by the Company shall be held in the name of the Company, not in the name of any Member individually.

5.4 Right to Inspect. Each Member shall have the right to inspect the Company's books and records at reasonable times and upon reasonable notice to the Manager.

5.5 Intercompany Agreements. The Manager is authorized, without the need for further Member approval, to execute Intercompany Transfer Agreements, Intercompany Loan Agreements, or Management Services Agreements with any Member entity or affiliated entity, provided that such agreements are in writing, on commercially reasonable terms, and properly recorded in the Company's books. The Manager shall maintain copies of all intercompany agreements at the Company's principal office.`,
    },
    {
      title: "Article VI — Transfer and Assignment",
      content: `6.1 Restrictions on Transfer. No Member may transfer, assign, or convey all or any portion of the Member's interest in the Company without the prior written consent of the Manager and a majority vote of the remaining Members based on ownership percentages.

6.2 Right of First Refusal. Before any Member may transfer an interest to a third party, the remaining Members shall have a right of first refusal to purchase the interest on the same terms offered by the third party. The remaining Members shall have thirty (30) days to exercise this right.

6.3 Admission of New Members. The Manager may admit additional members to the Company with the consent of a majority of the existing Members based on ownership percentages. Upon admission of a new member, this Agreement shall be amended to reflect the new membership structure.`,
    },
    {
      title: "Article VII — Dissolution",
      content: `7.1 Events of Dissolution. The Company shall be dissolved upon the occurrence of any of the following events:
(a) The written consent of Members holding a majority of the ownership interests;
(b) The death, permanent incapacity, or withdrawal of any Member, unless the remaining Members unanimously agree to continue the Company within ninety (90) days;
(c) Entry of a decree of judicial dissolution;
(d) Any event that makes it unlawful for the Company to continue its business.

7.2 Winding Up. Upon dissolution, the Manager (or a designated representative) shall wind up the Company's affairs, liquidate its assets, pay its debts and obligations, and distribute any remaining assets to the Members in proportion to their respective ownership interests.

7.3 Articles of Dissolution. Upon completion of winding up, the Manager shall file Articles of Dissolution (or equivalent document) with the ${stateName} filing office.`,
    },
    ...getStateSpecificClauses(state, true),
    {
      title: "Article VIII — General Provisions",
      content: `8.1 Indemnification. The Company shall indemnify the Manager, the Members, and any authorized officers, agents, or employees for all costs, losses, liabilities, and damages incurred in connection with the business of the Company, to the extent permitted by the laws of ${stateName}.

8.2 Governing Law. ${GOVERNING_LAW[state] || `This Agreement shall be governed by the laws of the State of ${stateName}.`}

8.3 Amendments. This Agreement may be amended only by a written instrument signed by the Manager and Members holding a majority of the ownership interests.

8.4 Entire Agreement. This Operating Agreement constitutes the entire agreement among the Members regarding the affairs of the Company and supersedes any prior oral or written agreements.

8.5 Severability. If any provision of this Agreement is held to be invalid or unenforceable, the remaining provisions shall continue in full force and effect.

8.6 Dispute Resolution. Any dispute arising under this Agreement shall first be submitted to mediation. If mediation is unsuccessful, the dispute shall be resolved by binding arbitration in accordance with the laws of ${stateName}.`,
    },
  ]
}

// ─── Main template generator ─────────────────────────────────

export function generateOASections(data: OAData): OASection[] {
  const state = data.state_of_formation.toUpperCase()
  const stateName = STATE_FULL_NAME[state] || data.state_of_formation
  const isMMLLC = data.entity_type === "MMLLC"

  const resolutions = generateInitialResolutions(data, stateName)

  const body = isMMLLC
    ? generateMMLLCSections(data, state, stateName)
    : generateSMLLCSections(data, state, stateName)

  return [resolutions, ...body]
}

// ─── Supported states ────────────────────────────────────────

export const OA_SUPPORTED_STATES = ["NM", "WY", "FL", "DE"] as const
export type OASupportedState = (typeof OA_SUPPORTED_STATES)[number]
export type OAEntityType = "SMLLC" | "MMLLC"
