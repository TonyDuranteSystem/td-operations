/**
 * Auto-generated CHECK constraint types from Supabase public schema.
 * Source: scripts/gen-check-types.ts
 * DO NOT EDIT — regenerate with: npx tsx scripts/gen-check-types.ts
 */

/** _service_catalog_archive_20260601.category — CHECK constraint */
export type ServiceCatalogArchive20260601Category = "primary" | "standalone" | "addon"

/** _service_catalog_archive_20260601.default_service_context — CHECK constraint */
export type ServiceCatalogArchive20260601DefaultServiceContext = "individual" | "business" | "ask"

/** account_location_policies.choice — CHECK constraint */
export type AccountLocationPoliciesChoice = "business" | "personal"

/** accounts.account_type — CHECK constraint */
export type AccountsAccountType = "Client" | "One-Time" | "Partner"

/** accounts.member_structure — CHECK constraint */
export type AccountsMemberStructure = "single_member" | "multi_member"

/** accounts.payment_gateway — CHECK constraint */
export type AccountsPaymentGateway = "whop" | "stripe" | "paypal"

/** accounts.portal_tier — CHECK constraint */
export type AccountsPortalTier = "lead" | "formation" | "onboarding" | "active" | "suspended" | "inactive"

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

/** annual_agreements.status — CHECK constraint */
export type AnnualAgreementsStatus = "draft" | "signed" | "completed" | "expired"

/** bank_categorization_rules.category — CHECK constraint */
export type BankCategorizationRulesCategory = "income" | "cogs" | "expense" | "distribution" | "contribution" | "fee" | "conversion" | "refund" | "uncategorized"

/** bank_categorization_rules.direction — CHECK constraint */
export type BankCategorizationRulesDirection = "in" | "out" | "any"

/** bank_categorization_rules.match_type — CHECK constraint */
export type BankCategorizationRulesMatchType = "regex" | "contains" | "exact"

/** bank_categorization_rules.source — CHECK constraint */
export type BankCategorizationRulesSource = "manual" | "learned" | "seed"

/** bank_transactions.ai_lean — CHECK constraint */
export type BankTransactionsAiLean = "business" | "personal" | "unsure"

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

/** catalog_decision_log.action — CHECK constraint */
export type CatalogDecisionLogAction = "added" | "renamed" | "deprecated" | "restored" | "tagged" | "metadata_changed" | "translation_added" | "translation_changed"

/** catalog_decision_log.actor_kind — CHECK constraint */
export type CatalogDecisionLogActorKind = "chat" | "ui" | "migration" | "admin_api"

/** catalog_entries.status — CHECK constraint */
export type CatalogEntriesStatus = "active" | "deprecated" | "exception_only" | "draft"

/** catalog_pending_review.source — CHECK constraint */
export type CatalogPendingReviewSource = "whop_webhook" | "stripe_webhook" | "plaid_webhook" | "manual_form" | "admin_input" | "mcp_tool"

/** catalog_pending_review.status — CHECK constraint */
export type CatalogPendingReviewStatus = "pending" | "approved_added" | "approved_aliased" | "rejected"

/** client_bank_accounts.currency — CHECK constraint */
export type ClientBankAccountsCurrency = "USD" | "EUR"

/** client_credit_notes.status — CHECK constraint */
export type ClientCreditNotesStatus = "issued" | "applied" | "voided"

/** client_decision_requests.request_type — CHECK constraint */
export type ClientDecisionRequestsRequestType = "approval" | "choice" | "text_input"

/** client_decision_requests.status — CHECK constraint */
export type ClientDecisionRequestsStatus = "pending" | "approved" | "rejected" | "responded" | "expired" | "cancelled"

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

/** client_threads.source_kind — CHECK constraint */
export type ClientThreadsSourceKind = "auto" | "manual"

/** closure_submissions.status — CHECK constraint */
export type ClosureSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** comm_conversations.created_by_type — CHECK constraint */
export type CommConversationsCreatedByType = "staff" | "partner"

/** comm_conversations.status — CHECK constraint */
export type CommConversationsStatus = "open" | "closed" | "archived"

/** comm_messages.pinned_by_type — CHECK constraint */
export type CommMessagesPinnedByType = "staff" | "partner"

/** comm_messages.sender_type — CHECK constraint */
export type CommMessagesSenderType = "staff" | "partner"

/** comm_participants.participant_type — CHECK constraint */
export type CommParticipantsParticipantType = "staff" | "partner"

/** contact_request_forms.form_type — CHECK constraint */
export type ContactRequestFormsFormType = "add_new" | "update_existing"

/** contact_request_forms.status — CHECK constraint */
export type ContactRequestFormsStatus = "pending" | "submitted" | "cancelled"

/** contacts.gender — CHECK constraint */
export type ContactsGender = "M" | "F"

/** contacts.portal_role — CHECK constraint */
export type ContactsPortalRole = "client" | "partner"

/** contacts.portal_tier — CHECK constraint */
export type ContactsPortalTier = "lead" | "formation" | "onboarding" | "active"

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

/** esign_envelopes.origin — CHECK constraint */
export type EsignEnvelopesOrigin = "staff" | "client"

/** esign_envelopes.routing_order — CHECK constraint */
export type EsignEnvelopesRoutingOrder = "parallel" | "sequential"

/** esign_envelopes.status — CHECK constraint */
export type EsignEnvelopesStatus = "draft" | "sent" | "in_progress" | "completed" | "declined" | "voided" | "expired"

/** esign_events.event_type — CHECK constraint */
export type EsignEventsEventType = "created" | "sent" | "viewed" | "signed" | "declined" | "completed" | "voided" | "reminder_sent" | "consent_accepted"

/** esign_fields.field_type — CHECK constraint */
export type EsignFieldsFieldType = "signature" | "initials" | "date" | "text" | "checkbox"

/** esign_signers.delivery_channel — CHECK constraint */
export type EsignSignersDeliveryChannel = "email" | "portal" | "none"

/** esign_signers.status — CHECK constraint */
export type EsignSignersStatus = "pending" | "sent" | "viewed" | "signed" | "declined"

/** esign_template_fields.field_type — CHECK constraint */
export type EsignTemplateFieldsFieldType = "signature" | "initials" | "date" | "text" | "checkbox"

/** esign_templates.status — CHECK constraint */
export type EsignTemplatesStatus = "active" | "archived"

/** formation_submissions.entity_type — CHECK constraint */
export type FormationSubmissionsEntityType = "SMLLC" | "MMLLC"

/** formation_submissions.language — CHECK constraint */
export type FormationSubmissionsLanguage = "en" | "it"

/** formation_submissions.status — CHECK constraint */
export type FormationSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** invoice_reminder_log.source — CHECK constraint */
export type InvoiceReminderLogSource = "auto" | "manual"

/** itin_submissions.language — CHECK constraint */
export type ItinSubmissionsLanguage = "en" | "it"

/** itin_submissions.status — CHECK constraint */
export type ItinSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** job_queue.status — CHECK constraint */
export type JobQueueStatus = "pending" | "processing" | "completed" | "completed_with_errors" | "failed" | "cancelled"

/** lease_agreements.status — CHECK constraint */
export type LeaseAgreementsStatus = "draft" | "sent" | "viewed" | "signed"

/** member_info_requests.status — CHECK constraint */
export type MemberInfoRequestsStatus = "pending" | "submitted" | "expired"

/** members.member_type — CHECK constraint */
export type MembersMemberType = "individual" | "company"

/** message_actions.priority — CHECK constraint */
export type MessageActionsPriority = "normal" | "high" | "urgent"

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
export type MessagingChannelsProvider = "wassenger" | "telegram_bot_api" | "meta" | "twilio"

/** messaging_groups.group_type — CHECK constraint */
export type MessagingGroupsGroupType = "support_group" | "lead_chat" | "internal" | "other"

/** oa_agreements.status — CHECK constraint */
export type OaAgreementsStatus = "draft" | "sent" | "viewed" | "partially_signed" | "signed" | "voided"

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

/** payments.payment_category — CHECK constraint */
export type PaymentsPaymentCategory = "setup_fee" | "installment_1" | "installment_2" | "annual_renewal" | "one_time" | "itin" | "custom" | "credit" | "other" | "td_communication"

/** pending_activations.confirmation_mode — CHECK constraint */
export type PendingActivationsConfirmationMode = "supervised" | "auto"

/** pending_activations.status — CHECK constraint */
export type PendingActivationsStatus = "awaiting_payment" | "payment_confirmed" | "activated" | "expired" | "cancelled"

/** pnl_period_answers.actor_role — CHECK constraint */
export type PnlPeriodAnswersActorRole = "staff" | "client" | "system"

/** pnl_period_answers.choice — CHECK constraint */
export type PnlPeriodAnswersChoice = "business" | "personal"

/** pnl_workspace_members.member_type — CHECK constraint */
export type PnlWorkspaceMembersMemberType = "individual" | "company"

/** pnl_workspace_transactions.loc_confidence — CHECK constraint */
export type PnlWorkspaceTransactionsLocConfidence = "high" | "medium"

/** pnl_workspace_transactions.loc_source — CHECK constraint */
export type PnlWorkspaceTransactionsLocSource = "text" | "map" | "ai"

/** pnl_workspaces.status — CHECK constraint */
export type PnlWorkspacesStatus = "active" | "archived"

/** portal_announcements.type — CHECK constraint */
export type PortalAnnouncementsType = "info" | "warning" | "success"

/** portal_issues.status — CHECK constraint */
export type PortalIssuesStatus = "open" | "resolved" | "dismissed"

/** portal_messages.sender_context — CHECK constraint */
export type PortalMessagesSenderContext = "person" | "company"

/** portal_messages.sender_type — CHECK constraint */
export type PortalMessagesSenderType = "client" | "admin" | "system"

/** portal_team_members.status — CHECK constraint */
export type PortalTeamMembersStatus = "active" | "revoked"

/** referral_payouts.payout_type — CHECK constraint */
export type ReferralPayoutsPayoutType = "credit_note" | "bank_transfer" | "invoice_deduction"

/** referrals.commission_type — CHECK constraint */
export type ReferralsCommissionType = "percentage" | "price_difference" | "credit_note"

/** referrals.referrer_type — CHECK constraint */
export type ReferralsReferrerType = "client" | "partner"

/** referrals.status — CHECK constraint */
export type ReferralsStatus = "pending" | "converted" | "credited" | "paid" | "cancelled"

/** service_deliveries.status — CHECK constraint */
export type ServiceDeliveriesStatus = "active" | "blocked" | "completed" | "cancelled" | "on_hold"

/** session_checkpoints.session_type — CHECK constraint */
export type SessionCheckpointsSessionType = "dev" | "ops"

/** signature_requests.status — CHECK constraint */
export type SignatureRequestsStatus = "draft" | "awaiting_signature" | "signed"

/** ss4_applications.status — CHECK constraint */
export type Ss4ApplicationsStatus = "draft" | "awaiting_signature" | "signed" | "submitted" | "done" | "fax_failed"

/** task_action_log.status — CHECK constraint */
export type TaskActionLogStatus = "pending" | "success" | "failed" | "partial"

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

/** td_comm_deliverables.type — CHECK constraint */
export type TdCommDeliverablesType = "logo_draft" | "logo_final" | "landing_page" | "brand_guide" | "business_card" | "other" | "mockup" | "asset_kit" | "social_kit"

/** td_comm_disclaimers.method — CHECK constraint */
export type TdCommDisclaimersMethod = "click" | "docusign"

/** td_comm_enrollments.client_type — CHECK constraint */
export type TdCommEnrollmentsClientType = "new_brand" | "rebrand"

/** td_comm_enrollments.status — CHECK constraint */
export type TdCommEnrollmentsStatus = "enrolled" | "form_submitted" | "in_progress" | "concept_ready" | "approved" | "revision" | "delivered" | "cancelled"

/** td_comm_packages.payment_timing — CHECK constraint */
export type TdCommPackagesPaymentTiming = "upfront" | "on_approval"

/** td_comm_portfolio.consent_source — CHECK constraint */
export type TdCommPortfolioConsentSource = "client_optin" | "written_on_file" | "none"

/** td_comm_questions.audience — CHECK constraint */
export type TdCommQuestionsAudience = "new_brand" | "rebrand" | "both"

/** td_comm_questions.type — CHECK constraint */
export type TdCommQuestionsType = "text" | "textarea" | "select" | "number" | "file"

/** td_comm_showcase_consents.method — CHECK constraint */
export type TdCommShowcaseConsentsMethod = "click" | "docusign"

/** td_expenses.category — CHECK constraint */
export type TdExpensesCategory = "Operations" | "Legal" | "Accounting" | "Software" | "Filing Fees" | "Shipping" | "Registered Agent" | "Office" | "Marketing" | "Other"

/** td_expenses.status — CHECK constraint */
export type TdExpensesStatus = "Pending" | "Paid" | "Overdue" | "Cancelled"

/** wizard_progress.status — CHECK constraint */
export type WizardProgressStatus = "in_progress" | "submitted" | "reviewed"

/** wizard_progress.wizard_type — CHECK constraint */
export type WizardProgressWizardType = "formation" | "onboarding" | "tax" | "itin" | "banking_payset" | "banking_relay" | "closure"

/** workflow_dispatch_log.outcome — CHECK constraint */
export type WorkflowDispatchLogOutcome = "spawned" | "no_trigger_match" | "ambiguous" | "snapshot_invalid" | "meta_invalid" | "spawn_failed" | "already_spawned"

/** workflow_dispatch_log.trigger_source — CHECK constraint */
export type WorkflowDispatchLogTriggerSource = "form_submission" | "sd_created" | "chain"

/** write_buffer.action — CHECK constraint */
export type WriteBufferAction = "CREATE" | "UPDATE" | "DELETE"

/** write_buffer.status — CHECK constraint */
export type WriteBufferStatus = "Pending" | "Synced" | "Failed"
