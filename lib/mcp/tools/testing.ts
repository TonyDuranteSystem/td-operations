/**
 * Testing Infrastructure — MCP Tools
 *
 * test_setup(scenario) — Creates test data DIRECTLY in tables at desired state.
 *   CRITICAL: NO side effects. No emails, no QB invoices, no Auth users, no webhooks.
 *   Just database inserts. All records get is_test=true and "TEST -" prefix.
 *
 * test_cleanup() — Safety check (count + summary), then delete all is_test=true records.
 *
 * Phase A of Admin Actions & Testing Plan.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ─── Scenario Definitions ──────────────────────────────────────

export interface TestScenarioResult {
  lead_id?: string
  contact_id?: string
  account_id?: string
  sd_id?: string
  payment_id?: string
  summary: string[]
}

const SCENARIOS = [
  'lead_new',
  'lead_offer_sent',
  'formation_stage_1',
  'formation_stage_2',
  'formation_stage_3',
  'formation_stage_4',
  'formation_completed',
  'onboarding_paid',
  'onboarding_completed',
  'tax_annual',
  'itin_individual',
] as const

type Scenario = typeof SCENARIOS[number]

// ─── Shared Test Data ──────────────────────────────────────────

const TEST_LEAD = {
  full_name: 'TEST - Mario Rossi',
  first_name: 'Mario',
  last_name: 'Rossi',
  email: 'test-mario@tonydurante.us',
  phone: '+39 000 000 0000',
  source: 'Test',
  reason: 'Test scenario',
  language: 'Italian',
  is_test: true,
}

const TEST_CONTACT = {
  full_name: 'TEST - Mario Rossi',
  first_name: 'Mario',
  last_name: 'Rossi',
  email: 'test-mario@tonydurante.us',
  phone: '+39 000 000 0000',
  language: 'Italian',
  citizenship: 'Italian',
  status: 'active',
  is_test: true,
}

const TEST_ACCOUNT = {
  company_name: 'TEST - Rossi LLC',
  entity_type: 'Single Member LLC' as const,
  state_of_formation: 'New Mexico',
  status: 'Pending Formation' as const,
  ein_number: '00-0000001',
  account_type: 'Client',
  is_test: true,
}

// ─── Scenario Builders ─────────────────────────────────────────

async function createLead(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('leads')
    .insert({ ...TEST_LEAD, ...overrides })
    .select('id')
    .single()
  if (error) throw new Error(`Lead insert failed: ${error.message}`)
  return data.id
}

async function createContact(overrides: Record<string, unknown> = {}): Promise<string> {
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .insert({ ...TEST_CONTACT, ...overrides })
    .select('id')
    .single()
  if (error) throw new Error(`Contact insert failed: ${error.message}`)
  return data.id
}

async function createAccount(overrides: Record<string, unknown> = {}): Promise<string> {
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .insert({ ...TEST_ACCOUNT, ...overrides })
    .select('id')
    .single()
  if (error) throw new Error(`Account insert failed: ${error.message}`)
  return data.id
}

async function linkContactToAccount(contactId: string, accountId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('account_contacts')
    .insert({ contact_id: contactId, account_id: accountId, role: 'Owner', ownership_pct: 100 })
  if (error) throw new Error(`Link contact-account failed: ${error.message}`)
}

async function createSD(params: {
  accountId?: string
  contactId?: string
  serviceType: string
  stage: string
  stageOrder: number
  serviceName?: string
}): Promise<string> {
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  const { data, error } = await supabaseAdmin
    .from('service_deliveries')
    .insert({
      service_name: params.serviceName || `${params.serviceType} - TEST`,
      service_type: params.serviceType,
      pipeline: params.serviceType,
      stage: params.stage,
      stage_order: params.stageOrder,
      account_id: params.accountId || null,
      contact_id: params.contactId || null,
      status: 'active',
      assigned_to: 'Luca',
      start_date: new Date().toISOString().split('T')[0],
      is_test: true,
    })
    .select('id')
    .single()
  if (error) throw new Error(`SD insert failed: ${error.message}`)
  return data.id
}

async function createPayment(params: {
  accountId?: string
  contactId?: string
  amount: number
  description: string
  status?: string
  currency?: string
}): Promise<string> {
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  const { data, error } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: params.accountId || null,
      contact_id: params.contactId || null,
      amount: params.amount,
      description: params.description,
      status: (params.status || 'Paid') as 'Paid',
      amount_currency: (params.currency || 'EUR') as 'EUR',
      payment_method: 'Test',
      paid_date: new Date().toISOString().split('T')[0],
      year: new Date().getFullYear(),
      is_test: true,
    })
    .select('id')
    .single()
  if (error) throw new Error(`Payment insert failed: ${error.message}`)
  return data.id
}

// ─── Scenario Implementations ──────────────────────────────────

async function scenarioLeadNew(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'New' })
  return {
    lead_id: leadId,
    summary: ['Lead created: TEST - Mario Rossi (status: New)'],
  }
}

async function scenarioLeadOfferSent(): Promise<TestScenarioResult> {
  const leadId = await createLead({
    status: 'Offer Sent',
    offer_year1_amount: 3250,
    offer_year1_currency: 'EUR',
    offer_annual_amount: 2000,
    offer_services: ['LLC Formation', 'Registered Agent', 'CMRA'],
    offer_status: 'Signed',
  })
  return {
    lead_id: leadId,
    summary: [
      'Lead created: TEST - Mario Rossi (status: Offer Sent)',
      'Offer data: EUR 3,250 / year 1, $2,000/yr annual',
    ],
  }
}

async function scenarioFormationStage1(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'Converted' })
  const contactId = await createContact({ portal_tier: 'onboarding' })
  const sdId = await createSD({
    contactId,
    serviceType: 'Company Formation',
    stage: 'Data Collection',
    stageOrder: 1,
  })
  const paymentId = await createPayment({ contactId, amount: 3250, description: 'TEST - Formation fee' })

  // Link lead to contact
  await supabaseAdmin.from('leads').update({ converted_to_contact_id: contactId }).eq('id', leadId)

  return {
    lead_id: leadId,
    contact_id: contactId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Lead: Converted',
      'Contact: TEST - Mario Rossi (portal_tier: onboarding)',
      'SD: Company Formation - stage 1 (Data Collection)',
      'Payment: EUR 3,250 (Paid)',
    ],
  }
}

async function scenarioFormationStage2(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'Converted' })
  const contactId = await createContact({ portal_tier: 'onboarding' })
  const accountId = await createAccount({ status: 'Pending Formation' as const, formation_date: null })
  await linkContactToAccount(contactId, accountId)
  const sdId = await createSD({
    accountId,
    contactId,
    serviceType: 'Company Formation',
    stage: 'State Filing',
    stageOrder: 2,
  })
  const paymentId = await createPayment({ accountId, contactId, amount: 3250, description: 'TEST - Formation fee' })
  await supabaseAdmin.from('leads').update({ converted_to_contact_id: contactId, converted_to_account_id: accountId }).eq('id', leadId)

  return {
    lead_id: leadId,
    contact_id: contactId,
    account_id: accountId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Lead: Converted',
      'Contact: TEST - Mario Rossi',
      'Account: TEST - Rossi LLC (Pending Formation)',
      'SD: Company Formation - stage 2 (State Filing)',
      'Payment: EUR 3,250',
    ],
  }
}

async function scenarioFormationStage3(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'Converted' })
  const contactId = await createContact({ portal_tier: 'onboarding' })
  const accountId = await createAccount({
    status: 'Pending Formation' as const,
    formation_date: '2026-03-01',
  })
  await linkContactToAccount(contactId, accountId)
  const sdId = await createSD({
    accountId,
    contactId,
    serviceType: 'Company Formation',
    stage: 'EIN Application',
    stageOrder: 3,
  })
  const paymentId = await createPayment({ accountId, contactId, amount: 3250, description: 'TEST - Formation fee' })
  await supabaseAdmin.from('leads').update({ converted_to_contact_id: contactId, converted_to_account_id: accountId }).eq('id', leadId)

  return {
    lead_id: leadId,
    contact_id: contactId,
    account_id: accountId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Lead: Converted',
      'Contact: TEST - Mario Rossi',
      'Account: TEST - Rossi LLC (formation_date: 2026-03-01)',
      'SD: Company Formation - stage 3 (EIN Application)',
      'Ready to test: SS-4 generation and signing',
    ],
  }
}

async function scenarioFormationStage4(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'Converted' })
  const contactId = await createContact({ portal_tier: 'active' })
  const accountId = await createAccount({
    status: 'Active' as const,
    formation_date: '2026-03-01',
    ein_number: '00-0000001',
  })
  await linkContactToAccount(contactId, accountId)
  const sdId = await createSD({
    accountId,
    contactId,
    serviceType: 'Company Formation',
    stage: 'Post-Formation + Banking',
    stageOrder: 4,
  })
  const paymentId = await createPayment({ accountId, contactId, amount: 3250, description: 'TEST - Formation fee' })
  await supabaseAdmin.from('leads').update({ converted_to_contact_id: contactId, converted_to_account_id: accountId }).eq('id', leadId)

  return {
    lead_id: leadId,
    contact_id: contactId,
    account_id: accountId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Lead: Converted',
      'Contact: TEST - Mario Rossi (portal_tier: active)',
      'Account: TEST - Rossi LLC (Active, EIN: 00-0000001)',
      'SD: Company Formation - stage 4 (Post-Formation + Banking)',
      'Ready to test: Welcome package, OA, Lease, Banking forms',
    ],
  }
}

async function scenarioFormationCompleted(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'Converted' })
  const contactId = await createContact({ portal_tier: 'active' })
  const accountId = await createAccount({
    status: 'Active' as const,
    formation_date: '2026-01-15',
    ein_number: '00-0000001',
    installment_1_amount: 1000,
    installment_2_amount: 1000,
  })
  await linkContactToAccount(contactId, accountId)
  const sdId = await createSD({
    accountId,
    contactId,
    serviceType: 'Company Formation',
    stage: 'Closing',
    stageOrder: 5,
    serviceName: 'Company Formation - TEST (Completed)',
  })
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  await supabaseAdmin.from('service_deliveries').update({ status: 'completed' }).eq('id', sdId)
  const paymentId = await createPayment({ accountId, contactId, amount: 3250, description: 'TEST - Formation fee' })
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  await supabaseAdmin.from('leads').update({ converted_to_contact_id: contactId, converted_to_account_id: accountId }).eq('id', leadId)

  return {
    lead_id: leadId,
    contact_id: contactId,
    account_id: accountId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Lead: Converted',
      'Contact: TEST - Mario Rossi (portal_tier: active)',
      'Account: TEST - Rossi LLC (Active, EIN, formation complete)',
      'SD: Company Formation - Completed',
      'Ready to test: Portal as fully active client',
    ],
  }
}

async function scenarioOnboardingPaid(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'Converted', reason: 'Onboarding existing LLC' })
  const contactId = await createContact({ portal_tier: 'onboarding' })
  const paymentId = await createPayment({ contactId, amount: 2000, description: 'TEST - Onboarding fee' })
  await supabaseAdmin.from('leads').update({ converted_to_contact_id: contactId }).eq('id', leadId)

  return {
    lead_id: leadId,
    contact_id: contactId,
    payment_id: paymentId,
    summary: [
      'Lead: Converted (Onboarding)',
      'Contact: TEST - Mario Rossi (portal_tier: onboarding)',
      'Payment: EUR 2,000 (Paid)',
      'No account yet — ready to test: Onboarding wizard',
    ],
  }
}

async function scenarioOnboardingCompleted(): Promise<TestScenarioResult> {
  const leadId = await createLead({ status: 'Converted', reason: 'Onboarding existing LLC' })
  const contactId = await createContact({ portal_tier: 'active' })
  const accountId = await createAccount({
    company_name: 'TEST - Existing Corp LLC',
    status: 'Active' as const,
    formation_date: '2024-06-15',
    ein_number: '00-0000002',
    state_of_formation: 'Wyoming',
  })
  await linkContactToAccount(contactId, accountId)
  const sdId = await createSD({
    accountId,
    contactId,
    serviceType: 'Company Formation',
    stage: 'Closing',
    stageOrder: 5,
    serviceName: 'Onboarding - TEST (Completed)',
  })
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  await supabaseAdmin.from('service_deliveries').update({ status: 'completed' }).eq('id', sdId)
  const paymentId = await createPayment({ accountId, contactId, amount: 2000, description: 'TEST - Onboarding fee' })
  // eslint-disable-next-line no-restricted-syntax -- test fixture: direct DB write intentional
  await supabaseAdmin.from('leads').update({ converted_to_contact_id: contactId, converted_to_account_id: accountId }).eq('id', leadId)

  return {
    lead_id: leadId,
    contact_id: contactId,
    account_id: accountId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Lead: Converted',
      'Contact: TEST - Mario Rossi (active)',
      'Account: TEST - Existing Corp LLC (Wyoming, Active)',
      'SD: Onboarding completed',
      'Ready to test: Document signing, portal features',
    ],
  }
}

async function scenarioTaxAnnual(): Promise<TestScenarioResult> {
  const contactId = await createContact({ portal_tier: 'active' })
  const accountId = await createAccount({
    status: 'Active' as const,
    formation_date: '2025-03-01',
    ein_number: '00-0000003',
  })
  await linkContactToAccount(contactId, accountId)

  // Create tax return record
  const { data: tr, error: trErr } = await supabaseAdmin
    .from('tax_returns')
    .insert({
      account_id: accountId,
      company_name: 'TEST - Existing Corp LLC',
      deadline: `${new Date().getFullYear()}-04-15`,
      tax_year: new Date().getFullYear() - 1,
      return_type: '5472' as never,
      status: 'Paid - Not Started',
      paid: true,
    })
    .select('id')
    .single()
  if (trErr) throw new Error(`Tax return insert failed: ${trErr.message}`)

  const sdId = await createSD({
    accountId,
    contactId,
    serviceType: 'Tax Return',
    stage: 'Data Collection',
    stageOrder: 1,
    serviceName: `Tax Return ${new Date().getFullYear() - 1} - TEST`,
  })
  const paymentId = await createPayment({ accountId, contactId, amount: 1000, description: 'TEST - Tax return fee', currency: 'USD' })

  return {
    contact_id: contactId,
    account_id: accountId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Contact: TEST - Mario Rossi (active)',
      `Account: TEST - Rossi LLC (Active, EIN: 00-0000003)`,
      `Tax return: ${new Date().getFullYear() - 1}, type 5472, Paid - Not Started`,
      `Tax return ID: ${tr.id}`,
      'SD: Tax Return - Data Collection',
      'Ready to test: Tax wizard, send to India',
    ],
  }
}

async function scenarioItinIndividual(): Promise<TestScenarioResult> {
  const contactId = await createContact({
    full_name: 'TEST - Stefano Pretto',
    first_name: 'Stefano',
    last_name: 'Pretto',
    email: 'test-stefano@tonydurante.us',
    portal_tier: 'onboarding',
  })
  const sdId = await createSD({
    contactId,
    serviceType: 'ITIN',
    stage: 'Data Collection',
    stageOrder: 1,
    serviceName: 'ITIN Application - TEST',
  })
  const paymentId = await createPayment({ contactId, amount: 500, description: 'TEST - ITIN fee', currency: 'USD' })

  return {
    contact_id: contactId,
    sd_id: sdId,
    payment_id: paymentId,
    summary: [
      'Contact: TEST - Stefano Pretto (NO account, portal_tier: onboarding)',
      'SD: ITIN - Data Collection',
      'Payment: $500 (Paid)',
      'Ready to test: ITIN wizard for person without LLC',
    ],
  }
}

// ─── Scenario Router ───────────────────────────────────────────

export async function runScenario(scenario: Scenario): Promise<TestScenarioResult> {
  switch (scenario) {
    case 'lead_new': return scenarioLeadNew()
    case 'lead_offer_sent': return scenarioLeadOfferSent()
    case 'formation_stage_1': return scenarioFormationStage1()
    case 'formation_stage_2': return scenarioFormationStage2()
    case 'formation_stage_3': return scenarioFormationStage3()
    case 'formation_stage_4': return scenarioFormationStage4()
    case 'formation_completed': return scenarioFormationCompleted()
    case 'onboarding_paid': return scenarioOnboardingPaid()
    case 'onboarding_completed': return scenarioOnboardingCompleted()
    case 'tax_annual': return scenarioTaxAnnual()
    case 'itin_individual': return scenarioItinIndividual()
  }
}

// ─── Cleanup ───────────────────────────────────────────────────

interface CleanupCounts {
  [table: string]: number
}

export async function countTestRecords(): Promise<CleanupCounts> {
  const tables = [
    'leads', 'contacts', 'accounts', 'service_deliveries', 'payments',
  ]
  const counts: CleanupCounts = {}

  for (const table of tables) {
    const { count } = await supabaseAdmin
      .from(table as never)
      .select('id', { count: 'exact', head: true })
      .eq('is_test', true)
    counts[table] = count ?? 0
  }

  // account_contacts: count links where either side is test
  const { count: acCount } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id', { count: 'exact', head: true })
    .in('account_id', (
      await supabaseAdmin.from('accounts').select('id').eq('is_test', true)
    ).data?.map(r => r.id) || ['00000000-0000-0000-0000-000000000000'])
  counts['account_contacts'] = acCount ?? 0

  return counts
}

export async function deleteTestRecords(): Promise<CleanupCounts> {
  const deleted: CleanupCounts = {}

  // Get test account IDs for junction cleanup
  const { data: testAccounts } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('is_test', true)
  const testAccountIds = testAccounts?.map(r => r.id) || []

  // Get test contact IDs for junction cleanup
  const { data: testContacts } = await supabaseAdmin
    .from('contacts')
    .select('id')
    .eq('is_test', true)
  const _testContactIds = testContacts?.map(r => r.id) || []

  // Delete in dependency order (children first)

  // 1. account_contacts (junction — no is_test column)
  if (testAccountIds.length > 0) {
    const { count } = await supabaseAdmin
      .from('account_contacts')
      .delete({ count: 'exact' })
      .in('account_id', testAccountIds)
    deleted['account_contacts'] = count ?? 0
  }

  // 2. Tasks linked to test accounts/contacts
  if (testAccountIds.length > 0) {
    const { count } = await supabaseAdmin
      .from('tasks')
      .delete({ count: 'exact' })
      .in('account_id', testAccountIds)
    deleted['tasks (by account)'] = count ?? 0
  }

  // 3. Tax returns linked to test accounts
  if (testAccountIds.length > 0) {
    const { count } = await supabaseAdmin
      .from('tax_returns')
      .delete({ count: 'exact' })
      .in('account_id', testAccountIds)
    deleted['tax_returns'] = count ?? 0
  }

  // 4. Tables with is_test column (reverse dependency order)
  const testTables = ['payments', 'service_deliveries', 'accounts', 'contacts', 'leads']
  for (const table of testTables) {
    const { count } = await supabaseAdmin
      .from(table as never)
      .delete({ count: 'exact' })
      .eq('is_test', true)
    deleted[table] = count ?? 0
  }

  return deleted
}

// ─── MCP Tool Registration ────────────────────────────────────

export function registerTestingTools(server: McpServer) {

  server.tool(
    "test_setup",
    `Create test data for a specific scenario. Inserts records DIRECTLY into tables at the desired pipeline state. NO side effects: no emails, no QB invoices, no Auth users, no webhooks. All records get is_test=true and "TEST -" prefix.

Available scenarios:
- lead_new: Lead only (test offer creation)
- lead_offer_sent: Lead with signed offer (test payment confirmation)
- formation_stage_1: Lead+Contact+SD stage 1 (test wizard data collection)
- formation_stage_2: +Account (test state filing)
- formation_stage_3: +formation_date (test SS-4 generation)
- formation_stage_4: +EIN (test welcome package, OA, Lease, Banking)
- formation_completed: Everything done (test portal as active client)
- onboarding_paid: Lead+Contact, no account (test onboarding wizard)
- onboarding_completed: Contact+Account+services done (test document signing)
- tax_annual: Contact+Account+tax_return (test tax wizard, send to India)
- itin_individual: Contact only, no account (test ITIN wizard without LLC)`,
    {
      scenario: z.enum(SCENARIOS).describe("Test scenario to create"),
    },
    async ({ scenario }) => {
      try {
        // Check for existing test data
        const existingCounts = await countTestRecords()
        const totalExisting = Object.values(existingCounts).reduce((a, b) => a + b, 0)
        if (totalExisting > 0) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Existing test data found (${totalExisting} records). Run test_cleanup first to avoid duplicates.\n\nExisting: ${JSON.stringify(existingCounts, null, 2)}`,
            }],
          }
        }

        const result = await runScenario(scenario)

        const lines = [
          `✅ Test scenario "${scenario}" created successfully`,
          '',
          '--- Records Created ---',
          ...result.summary,
          '',
          '--- IDs ---',
          result.lead_id ? `Lead: ${result.lead_id}` : null,
          result.contact_id ? `Contact: ${result.contact_id}` : null,
          result.account_id ? `Account: ${result.account_id}` : null,
          result.sd_id ? `Service Delivery: ${result.sd_id}` : null,
          result.payment_id ? `Payment: ${result.payment_id}` : null,
          '',
          'All records have is_test=true. Use test_cleanup to remove.',
        ].filter(Boolean)

        return {
          content: [{ type: "text" as const, text: lines.join('\n') }],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ test_setup failed: ${msg}` }],
        }
      }
    }
  )

  server.tool(
    "test_cleanup",
    "Remove all test data (is_test=true records) from the database. Shows a safety summary of what will be deleted before proceeding. Use confirm=true to actually delete. Without confirm, shows count only (dry run).",
    {
      confirm: z.boolean().default(false).describe("Set to true to actually delete. False = dry run (show counts only)."),
    },
    async ({ confirm }) => {
      try {
        const counts = await countTestRecords()
        const total = Object.values(counts).reduce((a, b) => a + b, 0)

        if (total === 0) {
          return {
            content: [{ type: "text" as const, text: '✅ No test data found. Nothing to clean up.' }],
          }
        }

        if (!confirm) {
          const lines = [
            `🔍 Test data found (${total} records). Review before deleting:`,
            '',
            ...Object.entries(counts)
              .filter(([, c]) => c > 0)
              .map(([table, count]) => `  ${table}: ${count} records`),
            '',
            'Run test_cleanup with confirm=true to delete all test records.',
          ]
          return {
            content: [{ type: "text" as const, text: lines.join('\n') }],
          }
        }

        // Actually delete
        const deleted = await deleteTestRecords()
        const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0)

        const lines = [
          `🧹 Test cleanup complete. Removed ${totalDeleted} records:`,
          '',
          ...Object.entries(deleted)
            .filter(([, c]) => c > 0)
            .map(([table, count]) => `  ${table}: ${count} deleted`),
        ]

        return {
          content: [{ type: "text" as const, text: lines.join('\n') }],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ test_cleanup failed: ${msg}` }],
        }
      }
    }
  )
}
