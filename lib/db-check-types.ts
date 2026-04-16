/**
 * Auto-generated CHECK constraint types from Supabase public schema.
 * Generated: 2026-04-16T01:25:32.334Z
 * Source: scripts/gen-check-types.ts
 * DO NOT EDIT — regenerate with: npx tsx scripts/gen-check-types.ts
 */

/** accounts.account_type — CHECK constraint */
export type AccountsAccountType = "Client" | "One-Time" | "Partner"

/** accounts.payment_gateway — CHECK constraint */
export type AccountsPaymentGateway = "whop" | "stripe" | "paypal"

/** accounts.portal_tier — CHECK constraint */
export type AccountsPortalTier = "lead" | "onboarding" | "active" | "suspended" | "inactive"

/** ai_delegations.status — CHECK constraint */
export type AiDelegationsStatus = "analyzing" | "analyzed" | "approved" | "executing" | "completed" | "rejected" | "failed"

/** ai_facts.category — CHECK constraint */
export type AiFactsCategory = "decision" | "preference" | "correction" | "request" | "bug" | "feature" | "transition" | "client_note"

/** ai_facts.status — CHECK constraint */
export type AiFactsStatus = "active" | "superseded" | "completed"

/** ai_messages.role — CHECK constraint */
export type AiMessagesRole = "user" | "assistant" | "system" | "tool"

/** ai_notifications.channel — CHECK constraint */
export type AiNotificationsChannel = "push" | "in_app" | "digest" | "email"

/** ai_notifications.priority — CHECK constraint */
export type AiNotificationsPriority = "urgent" | "normal" | "low"

/** ai_notifications.status — CHECK constraint */
export type AiNotificationsStatus = "pending" | "pushed" | "read" | "dismissed"

/** bank_transactions.category — CHECK constraint */
export type BankTransactionsCategory = "income" | "cogs" | "expense" | "distribution" | "fee" | "conversion" | "refund" | "uncategorized"

/** banking_submissions.language — CHECK constraint */
export type BankingSubmissionsLanguage = "en" | "it"

/** banking_submissions.status — CHECK constraint */
export type BankingSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** billing_entities.currency — CHECK constraint */
export type BillingEntitiesCurrency = "EUR" | "USD" | "GBP" | "CHF"

/** billing_entities.entity_type — CHECK constraint */
export type BillingEntitiesEntityType = "SRL" | "SRLS" | "SPA" | "ditta_individuale" | "persona_fisica" | "GmbH" | "Ltd" | "other"

/** client_bank_accounts.currency — CHECK constraint */
export type ClientBankAccountsCurrency = "USD" | "EUR"

/** client_credit_notes.status — CHECK constraint */
export type ClientCreditNotesStatus = "issued" | "applied" | "voided"

/** client_expenses.category — CHECK constraint */
export type ClientExpensesCategory = "General" | "Services" | "Software" | "Office" | "Professional" | "Tax" | "Legal" | "Other"

/** client_expenses.ocr_confidence — CHECK constraint */
export type ClientExpensesOcrConfidence = "high" | "medium" | "low"

/** client_expenses.source — CHECK constraint */
export type ClientExpensesSource = "td_invoice" | "upload" | "manual"

/** client_expenses.status — CHECK constraint */
export type ClientExpensesStatus = "Pending" | "Paid" | "Overdue" | "Cancelled"

/** client_interactions.direction — CHECK constraint */
export type ClientInteractionsDirection = "Inbound" | "Outbound"

/** client_invoice_documents.direction — CHECK constraint */
export type ClientInvoiceDocumentsDirection = "sales" | "expense"

/** client_invoice_templates.currency — CHECK constraint */
export type ClientInvoiceTemplatesCurrency = "USD" | "EUR"

/** client_invoices.currency — CHECK constraint */
export type ClientInvoicesCurrency = "USD" | "EUR"

/** client_invoices.recurring_frequency — CHECK constraint */
export type ClientInvoicesRecurringFrequency = "monthly" | "quarterly" | "yearly"

/** client_invoices.status — CHECK constraint */
export type ClientInvoicesStatus = "Draft" | "Sent" | "Paid" | "Partial" | "Overdue" | "Cancelled"

/** closure_submissions.status — CHECK constraint */
export type ClosureSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** contacts.gender — CHECK constraint */
export type ContactsGender = "M" | "F"

/** contacts.portal_role — CHECK constraint */
export type ContactsPortalRole = "client" | "partner"

/** contacts.portal_tier — CHECK constraint */
export type ContactsPortalTier = "lead" | "onboarding" | "active"

/** contacts.referrer_type — CHECK constraint */
export type ContactsReferrerType = "client" | "partner"

/** contracts.status — CHECK constraint */
export type ContractsStatus = "pending" | "signed" | "completed"

/** conversations.direction — CHECK constraint */
export type ConversationsDirection = "Inbound" | "Outbound"

/** cron_log.status — CHECK constraint */
export type CronLogStatus = "success" | "error"

/** deadlines.status — CHECK constraint */
export type DeadlinesStatus = "Pending" | "Completed" | "Filed" | "Not Started" | "Overdue" | "Cancelled"

/** documents.confidence — CHECK constraint */
export type DocumentsConfidence = "high" | "medium" | "low"

/** documents.status — CHECK constraint */
export type DocumentsStatus = "pending" | "processed" | "classified" | "unclassified" | "error"

/** email_queue.created_by — CHECK constraint */
export type EmailQueueCreatedBy = "Antonio" | "Luca" | "System"

/** formation_submissions.entity_type — CHECK constraint */
export type FormationSubmissionsEntityType = "SMLLC" | "MMLLC"

/** formation_submissions.language — CHECK constraint */
export type FormationSubmissionsLanguage = "en" | "it"

/** formation_submissions.status — CHECK constraint */
export type FormationSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** itin_submissions.language — CHECK constraint */
export type ItinSubmissionsLanguage = "en" | "it"

/** itin_submissions.status — CHECK constraint */
export type ItinSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** job_queue.status — CHECK constraint */
export type JobQueueStatus = "pending" | "processing" | "completed" | "completed_with_errors" | "failed" | "cancelled"

/** lease_agreements.status — CHECK constraint */
export type LeaseAgreementsStatus = "draft" | "sent" | "viewed" | "signed"

/** message_actions.action_type — CHECK constraint */
export type MessageActionsActionType = "action_needed" | "in_progress" | "waiting_on_client" | "done"

/** message_responses.sent_via — CHECK constraint */
export type MessageResponsesSentVia = "wassenger" | "telegram_bot_api" | "manual"

/** message_responses.status — CHECK constraint */
export type MessageResponsesStatus = "draft" | "approved" | "sent" | "failed"

/** messages.content_type — CHECK constraint */
export type MessagesContentType = "text" | "image" | "document" | "voice" | "video" | "location" | "contact" | "sticker" | "other"

/** messages.direction — CHECK constraint */
export type MessagesDirection = "inbound" | "outbound"

/** messages.status — CHECK constraint */
export type MessagesStatus = "new" | "read" | "draft_ready" | "responded" | "archived" | "ignored"

/** messaging_channels.platform — CHECK constraint */
export type MessagingChannelsPlatform = "whatsapp" | "telegram"

/** messaging_channels.provider — CHECK constraint */
export type MessagingChannelsProvider = "periskope" | "wassenger" | "telegram_bot_api"

/** messaging_groups.group_type — CHECK constraint */
export type MessagingGroupsGroupType = "support_group" | "lead_chat" | "internal" | "other"

/** oa_agreements.status — CHECK constraint */
export type OaAgreementsStatus = "draft" | "sent" | "viewed" | "partially_signed" | "signed"

/** oa_signatures.status — CHECK constraint */
export type OaSignaturesStatus = "pending" | "sent" | "viewed" | "signed"

/** offers.payment_type — CHECK constraint */
export type OffersPaymentType = "none" | "checkout" | "bank_transfer"

/** offers.status — CHECK constraint */
export type OffersStatus = "draft" | "sent" | "viewed" | "accepted" | "signed" | "completed" | "expired"

/** onboarding_submissions.entity_type — CHECK constraint */
export type OnboardingSubmissionsEntityType = "SMLLC" | "MMLLC"

/** onboarding_submissions.language — CHECK constraint */
export type OnboardingSubmissionsLanguage = "en" | "it"

/** onboarding_submissions.status — CHECK constraint */
export type OnboardingSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** payment_links.gateway — CHECK constraint */
export type PaymentLinksGateway = "stripe" | "paypal" | "whop" | "other"

/** payments.bank_preference — CHECK constraint */
export type PaymentsBankPreference = "auto" | "relay" | "mercury" | "revolut" | "airwallex"

/** pending_activations.confirmation_mode — CHECK constraint */
export type PendingActivationsConfirmationMode = "supervised" | "auto"

/** pending_activations.status — CHECK constraint */
export type PendingActivationsStatus = "awaiting_payment" | "payment_confirmed" | "activated" | "expired" | "cancelled"

/** portal_issues.status — CHECK constraint */
export type PortalIssuesStatus = "open" | "resolved" | "dismissed"

/** portal_messages.sender_type — CHECK constraint */
export type PortalMessagesSenderType = "client" | "admin"

/** referral_payouts.payout_type — CHECK constraint */
export type ReferralPayoutsPayoutType = "credit_note" | "bank_transfer" | "invoice_deduction"

/** referrals.commission_type — CHECK constraint */
export type ReferralsCommissionType = "percentage" | "price_difference" | "credit_note"

/** referrals.referrer_type — CHECK constraint */
export type ReferralsReferrerType = "client" | "partner"

/** referrals.status — CHECK constraint */
export type ReferralsStatus = "pending" | "converted" | "credited" | "paid" | "cancelled"

/** service_catalog.category — CHECK constraint */
export type ServiceCatalogCategory = "primary" | "standalone" | "addon"

/** service_deliveries.service_type — CHECK constraint */
export type ServiceDeliveriesServiceType = "Company Formation" | "Client Onboarding" | "Tax Return" | "State RA Renewal" | "CMRA Mailing Address" | "Shipping" | "Public Notary" | "Banking Fintech" | "Banking Physical" | "ITIN" | "Company Closure" | "Client Offboarding" | "State Annual Report" | "EIN" | "EIN Application" | "Support" | "Annual Renewal" | "CMRA"

/** service_deliveries.status — CHECK constraint */
export type ServiceDeliveriesStatus = "active" | "blocked" | "completed" | "cancelled"

/** session_checkpoints.session_type — CHECK constraint */
export type SessionCheckpointsSessionType = "dev" | "ops"

/** signature_requests.status — CHECK constraint */
export type SignatureRequestsStatus = "draft" | "awaiting_signature" | "signed"

/** ss4_applications.status — CHECK constraint */
export type Ss4ApplicationsStatus = "draft" | "awaiting_signature" | "signed" | "submitted" | "done" | "fax_failed"

/** tasks.assigned_to — CHECK constraint */
export type TasksAssignedTo = "Antonio" | "Luca" | "India Tax Team" | "Claude"

/** tasks.created_by — CHECK constraint */
export type TasksCreatedBy = "Antonio" | "Luca" | "System" | "Claude"

/** tax_quote_submissions.llc_type — CHECK constraint */
export type TaxQuoteSubmissionsLlcType = "single_member" | "multi_member" | "c_corp"

/** tax_quote_submissions.status — CHECK constraint */
export type TaxQuoteSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "processed"

/** tax_return_submissions.status — CHECK constraint */
export type TaxReturnSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** td_bank_feeds.match_confidence — CHECK constraint */
export type TdBankFeedsMatchConfidence = "exact" | "high" | "medium" | "low" | "manual" | "partial" | "retroactive"

/** td_bank_feeds.source — CHECK constraint */
export type TdBankFeedsSource = "relay" | "mercury" | "mercury_api" | "banking_circle" | "qb_deposit" | "airwallex_email" | "airwallex_api" | "manual" | "stripe" | "chase"

/** td_bank_feeds.status — CHECK constraint */
export type TdBankFeedsStatus = "unmatched" | "matched" | "ignored" | "duplicate" | "outgoing"

/** td_expenses.category — CHECK constraint */
export type TdExpensesCategory = "Operations" | "Legal" | "Accounting" | "Software" | "Filing Fees" | "Shipping" | "Registered Agent" | "Office" | "Marketing" | "Other"

/** td_expenses.status — CHECK constraint */
export type TdExpensesStatus = "Pending" | "Paid" | "Overdue" | "Cancelled"

/** wizard_progress.status — CHECK constraint */
export type WizardProgressStatus = "in_progress" | "submitted" | "reviewed"

/** wizard_progress.wizard_type — CHECK constraint */
export type WizardProgressWizardType = "formation" | "onboarding" | "tax" | "itin" | "banking_payset" | "banking_relay" | "closure"

/** write_buffer.action — CHECK constraint */
export type WriteBufferAction = "CREATE" | "UPDATE" | "DELETE"

/** write_buffer.status — CHECK constraint */
export type WriteBufferStatus = "Pending" | "Synced" | "Failed"
