/**
 * Auto-generated CHECK constraint types from Supabase public schema.
 * Source: scripts/gen-check-types.ts
 * DO NOT EDIT — regenerate with: npx tsx scripts/gen-check-types.ts
 */

/** account_bank_balances.source — CHECK constraint */
export type AccountBankBalancesSource = "client" | "staff"

/** account_location_policies.choice — CHECK constraint */
export type AccountLocationPoliciesChoice = "business" | "personal"

/** accounts.member_structure — CHECK constraint */
export type AccountsMemberStructure = "single_member" | "multi_member"

/** addresses.kind — CHECK constraint */
export type AddressesKind = "business_legal" | "business_mailing" | "registered_agent" | "shipping"

/** annual_agreements.status — CHECK constraint */
export type AnnualAgreementsStatus = "draft" | "signed" | "completed" | "expired"

/** audit_flags.entity_type — CHECK constraint */
export type AuditFlagsEntityType = "account" | "contact" | "service"

/** audit_flags.flag_type — CHECK constraint */
export type AuditFlagsFlagType = "na" | "follow_up"

/** bank_categorization_rules.category — CHECK constraint */
export type BankCategorizationRulesCategory = "income" | "cogs" | "expense" | "distribution" | "contribution" | "fee" | "conversion" | "refund" | "uncategorized"

/** bank_categorization_rules.direction — CHECK constraint */
export type BankCategorizationRulesDirection = "in" | "out" | "any"

/** bank_categorization_rules.match_type — CHECK constraint */
export type BankCategorizationRulesMatchType = "regex" | "contains" | "exact"

/** bank_categorization_rules.source — CHECK constraint */
export type BankCategorizationRulesSource = "manual" | "learned" | "seed"

/** bank_transactions.category — CHECK constraint */
export type BankTransactionsCategory = "income" | "cogs" | "expense" | "distribution" | "contribution" | "fee" | "conversion" | "refund" | "uncategorized"

/** bofa_intake_requests.status — CHECK constraint */
export type BofaIntakeRequestsStatus = "pending" | "opened" | "completed" | "revoked"

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

/** chart_of_accounts.normal_balance — CHECK constraint */
export type ChartOfAccountsNormalBalance = "debit" | "credit"

/** chart_of_accounts.type — CHECK constraint */
export type ChartOfAccountsType = "asset" | "liability" | "equity" | "income" | "expense"

/** client_decision_requests.request_type — CHECK constraint */
export type ClientDecisionRequestsRequestType = "approval" | "choice" | "text_input"

/** client_decision_requests.status — CHECK constraint */
export type ClientDecisionRequestsStatus = "pending" | "approved" | "rejected" | "responded" | "expired" | "cancelled"

/** client_threads.source_kind — CHECK constraint */
export type ClientThreadsSourceKind = "auto" | "manual"

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

/** documents.status — CHECK constraint */
export type DocumentsStatus = "pending" | "processed" | "classified" | "unclassified" | "error" | "archived"

/** email_message_content.capture_status — CHECK constraint */
export type EmailMessageContentCaptureStatus = "pending" | "complete" | "error"

/** esign_envelopes.origin — CHECK constraint */
export type EsignEnvelopesOrigin = "staff" | "client"

/** esign_envelopes.routing_order — CHECK constraint */
export type EsignEnvelopesRoutingOrder = "parallel" | "sequential"

/** esign_envelopes.status — CHECK constraint */
export type EsignEnvelopesStatus = "draft" | "sent" | "in_progress" | "completed" | "declined" | "voided" | "expired"

/** esign_events.event_type — CHECK constraint */
export type EsignEventsEventType = "created" | "sent" | "viewed" | "signed" | "declined" | "completed" | "voided" | "reminder_sent" | "consent_accepted" | "expired" | "reopened" | "deadline_changed"

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

/** incoming_payment_resolutions.resolution — CHECK constraint */
export type IncomingPaymentResolutionsResolution = "paid_call" | "paid_call_already_deducted" | "recorded_elsewhere" | "marketing_sale" | "invoice_paid"

/** internal_thread_state.status — CHECK constraint */
export type InternalThreadStateStatus = "todo" | "in_progress" | "waiting" | "handled"

/** internal_threads.thread_type — CHECK constraint */
export type InternalThreadsThreadType = "general" | "channel" | "discussion" | "dm" | "group"

/** internal_threads.work_status — CHECK constraint */
export type InternalThreadsWorkStatus = "todo" | "in_progress" | "waiting" | "handled"

/** invoice_reminder_log.source — CHECK constraint */
export type InvoiceReminderLogSource = "auto" | "manual"

/** journal_entries.status — CHECK constraint */
export type JournalEntriesStatus = "draft" | "posted" | "void"

/** marketing_commission_terms.basis — CHECK constraint */
export type MarketingCommissionTermsBasis = "amount_paid" | "net_of_fees"

/** marketing_invites.member_role — CHECK constraint */
export type MarketingInvitesMemberRole = "owner" | "member"

/** marketing_leadgen_events.source — CHECK constraint */
export type MarketingLeadgenEventsSource = "webhook" | "reconcile"

/** marketing_leadgen_events.status — CHECK constraint */
export type MarketingLeadgenEventsStatus = "pending" | "done" | "failed" | "gave_up"

/** marketing_sales.status — CHECK constraint */
export type MarketingSalesStatus = "link_created" | "paid" | "refunded" | "partly_refunded" | "failed" | "expired"

/** marketing_team_members.member_role — CHECK constraint */
export type MarketingTeamMembersMemberRole = "owner" | "member"

/** marketing_team_members.status — CHECK constraint */
export type MarketingTeamMembersStatus = "active" | "paused" | "removed"

/** marketing_teams.status — CHECK constraint */
export type MarketingTeamsStatus = "draft" | "active" | "paused"

/** member_info_requests.status — CHECK constraint */
export type MemberInfoRequestsStatus = "pending" | "submitted" | "applied" | "dismissed"

/** members.member_type — CHECK constraint */
export type MembersMemberType = "individual" | "company"

/** message_actions.priority — CHECK constraint */
export type MessageActionsPriority = "normal" | "high" | "urgent"

/** messages.content_type — CHECK constraint */
export type MessagesContentType = "text" | "image" | "document" | "voice" | "video" | "location" | "contact" | "sticker" | "other"

/** messages.direction — CHECK constraint */
export type MessagesDirection = "inbound" | "outbound"

/** messages.status — CHECK constraint */
export type MessagesStatus = "new" | "read" | "draft_ready" | "responded" | "archived" | "ignored"

/** messaging_channels.provider — CHECK constraint */
export type MessagingChannelsProvider = "wassenger" | "telegram_bot_api" | "meta" | "twilio" | "twochat" | "wabridge"

/** messaging_groups.group_type — CHECK constraint */
export type MessagingGroupsGroupType = "support_group" | "lead_chat" | "internal" | "other"

/** offer_narrative_turns.role — CHECK constraint */
export type OfferNarrativeTurnsRole = "user" | "assistant"

/** onboarding_submissions.entity_type — CHECK constraint */
export type OnboardingSubmissionsEntityType = "SMLLC" | "MMLLC"

/** onboarding_submissions.language — CHECK constraint */
export type OnboardingSubmissionsLanguage = "en" | "it"

/** onboarding_submissions.status — CHECK constraint */
export type OnboardingSubmissionsStatus = "pending" | "sent" | "opened" | "completed" | "reviewed"

/** payer_client_map.key_type — CHECK constraint */
export type PayerClientMapKeyType = "descriptor" | "counterparty_id"

/** payment_items.item_type — CHECK constraint */
export type PaymentItemsItemType = "service" | "fee"

/** pnl_period_answers.actor_role — CHECK constraint */
export type PnlPeriodAnswersActorRole = "staff" | "client" | "system"

/** pnl_period_answers.choice — CHECK constraint */
export type PnlPeriodAnswersChoice = "business" | "personal"

/** pnl_workspace_members.member_type — CHECK constraint */
export type PnlWorkspaceMembersMemberType = "individual" | "company"

/** pnl_workspaces.status — CHECK constraint */
export type PnlWorkspacesStatus = "active" | "archived"

/** portal_announcements.type — CHECK constraint */
export type PortalAnnouncementsType = "info" | "warning" | "success"

/** portal_messages.sender_type — CHECK constraint */
export type PortalMessagesSenderType = "client" | "admin" | "system"

/** portal_team_members.status — CHECK constraint */
export type PortalTeamMembersStatus = "active" | "revoked"

/** portal_translations.status — CHECK constraint */
export type PortalTranslationsStatus = "pending" | "generating" | "done"

/** pwa_events.device — CHECK constraint */
export type PwaEventsDevice = "android" | "ios" | "desktop"

/** pwa_events.event — CHECK constraint */
export type PwaEventsEvent = "page_view" | "installed" | "standalone_launch" | "standalone_authenticated"

/** pwa_events.src — CHECK constraint */
export type PwaEventsSrc = "qr-print" | "qr-desktop" | "email-sig" | "chat" | "fallback-email" | "onboarding" | "campaign" | "guide" | "portal-nudge"

/** recurring_invoice_templates.currency — CHECK constraint */
export type RecurringInvoiceTemplatesCurrency = "USD" | "EUR"

/** recurring_invoice_templates.frequency — CHECK constraint */
export type RecurringInvoiceTemplatesFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly"

/** service_settings_history.op — CHECK constraint */
export type ServiceSettingsHistoryOp = "INSERT" | "UPDATE" | "DELETE"

/** staff_alert_state.kind — CHECK constraint */
export type StaffAlertStateKind = "note_reply" | "note_update" | "note_snooze_due"

/** staff_notes.visibility — CHECK constraint */
export type StaffNotesVisibility = "private" | "shared" | "team"

/** statement_format_mappings.status — CHECK constraint */
export type StatementFormatMappingsStatus = "proposed" | "verified_auto" | "staff_confirmed" | "rejected"

/** storage_app_tokens.kind — CHECK constraint */
export type StorageAppTokensKind = "access" | "refresh"

/** storage_check_notes.kind — CHECK constraint */
export type StorageCheckNotesKind = "left" | "dismissed"

/** store_change_log.item_kind — CHECK constraint */
export type StoreChangeLogItemKind = "file" | "folder" | "owner"

/** store_change_log.op — CHECK constraint */
export type StoreChangeLogOp = "upsert" | "delete"

/** store_exit_invitations.status — CHECK constraint */
export type StoreExitInvitationsStatus = "queued" | "sent" | "cancelled"

/** store_external_refs.direction — CHECK constraint */
export type StoreExternalRefsDirection = "import" | "backup"

/** store_external_refs.object_kind — CHECK constraint */
export type StoreExternalRefsObjectKind = "folder" | "file" | "file_version"

/** store_file_facts.source — CHECK constraint */
export type StoreFileFactsSource = "human" | "rule" | "ai"

/** store_file_subjects.subject_kind — CHECK constraint */
export type StoreFileSubjectsSubjectKind = "person" | "company"

/** store_file_tags.source — CHECK constraint */
export type StoreFileTagsSource = "human" | "rule" | "ai"

/** store_files.filing_status — CHECK constraint */
export type StoreFilesFilingStatus = "none" | "draft" | "filed" | "amended"

/** store_files.state — CHECK constraint */
export type StoreFilesState = "live" | "trashed" | "purged"

/** store_import_items.source — CHECK constraint */
export type StoreImportItemsSource = "drive" | "storage"

/** store_import_items.status — CHECK constraint */
export type StoreImportItemsStatus = "pending" | "working" | "done" | "merged" | "skipped" | "failed"

/** store_import_runs.mode — CHECK constraint */
export type StoreImportRunsMode = "move" | "copy"

/** store_import_runs.status — CHECK constraint */
export type StoreImportRunsStatus = "scanning" | "moving" | "undoing" | "done" | "incomplete" | "failed" | "rolled_back"

/** store_owners.kind — CHECK constraint */
export type StoreOwnersKind = "company" | "person" | "formation" | "unfiled" | "business" | "private"

/** store_owners.lifecycle_override — CHECK constraint */
export type StoreOwnersLifecycleOverride = "in_formation" | "in_onboarding" | "archived"

/** system_errors.source — CHECK constraint */
export type SystemErrorsSource = "client" | "server"

/** system_errors.status — CHECK constraint */
export type SystemErrorsStatus = "open" | "diagnosed" | "resolved" | "ignored"

/** task_action_log.status — CHECK constraint */
export type TaskActionLogStatus = "pending" | "success" | "failed" | "partial"

/** td_bank_feeds.match_confidence — CHECK constraint */
export type TdBankFeedsMatchConfidence = "exact" | "high" | "medium" | "low" | "manual" | "partial" | "retroactive"

/** td_bank_feeds.source — CHECK constraint */
export type TdBankFeedsSource = "relay" | "mercury" | "mercury_api" | "banking_circle" | "qb_deposit" | "airwallex_email" | "airwallex_api" | "manual" | "stripe" | "chase" | "revolut"

/** td_bank_feeds.status — CHECK constraint */
export type TdBankFeedsStatus = "unmatched" | "matched" | "ignored" | "duplicate" | "outgoing" | "needs_review" | "activation_crashed" | "owner_ledger"

/** td_books_accounts.account_type — CHECK constraint */
export type TdBooksAccountsAccountType = "checking" | "savings" | "credit_card" | "loan" | "processor"

/** td_books_accounts.closing_source — CHECK constraint */
export type TdBooksAccountsClosingSource = "statement" | "derived" | "provider_report" | "unknown"

/** td_books_accounts.sign_convention — CHECK constraint */
export type TdBooksAccountsSignConvention = "normal" | "inverted"

/** td_books_transactions.category — CHECK constraint */
export type TdBooksTransactionsCategory = "income" | "cogs" | "expense" | "distribution" | "contribution" | "fee" | "conversion" | "refund" | "transfer" | "uncategorized"

/** td_comm_deliverables.type — CHECK constraint */
export type TdCommDeliverablesType = "logo_draft" | "logo_final" | "landing_page" | "brand_guide" | "business_card" | "other" | "mockup" | "asset_kit" | "social_kit" | "geometry"

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

/** wa_bridge_state.send_mode — CHECK constraint */
export type WaBridgeStateSendMode = "paused" | "shadow" | "live"

/** wa_outbox.status — CHECK constraint */
export type WaOutboxStatus = "shadow" | "queued" | "sent" | "failed" | "unknown"

/** worker_prepared_sends.kind — CHECK constraint */
export type WorkerPreparedSendsKind = "email" | "portal"

/** worker_prepared_sends.status — CHECK constraint */
export type WorkerPreparedSendsStatus = "pending" | "sent" | "cancelled"

/** workflow_dispatch_log.outcome — CHECK constraint */
export type WorkflowDispatchLogOutcome = "spawned" | "no_trigger_match" | "ambiguous" | "snapshot_invalid" | "meta_invalid" | "spawn_failed" | "already_spawned"

/** workflow_dispatch_log.trigger_source — CHECK constraint */
export type WorkflowDispatchLogTriggerSource = "form_submission" | "sd_created" | "chain"
