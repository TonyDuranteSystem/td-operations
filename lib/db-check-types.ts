/**
 * Auto-generated CHECK constraint types from Supabase public schema.
 * Source: scripts/gen-check-types.ts
 * DO NOT EDIT — regenerate with: npx tsx scripts/gen-check-types.ts
 */

/** _bp_constraint_test.v — CHECK constraint */
export type BpConstraintTestV = "auto" | "relay" | "mercury" | "revolut" | "airwallex"

/** _service_catalog_archive_20260601.default_service_context — CHECK constraint */
export type ServiceCatalogArchive20260601DefaultServiceContext = "individual" | "business" | "ask"

/** accounts.member_structure — CHECK constraint */
export type AccountsMemberStructure = "single_member" | "multi_member"

/** accounts.portal_tier — CHECK constraint */
export type AccountsPortalTier = "lead" | "formation" | "onboarding" | "active" | "suspended" | "inactive"

/** addresses.kind — CHECK constraint */
export type AddressesKind = "business_legal" | "business_mailing" | "registered_agent"

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

/** bank_transactions.ai_lean — CHECK constraint */
export type BankTransactionsAiLean = "business" | "personal" | "unsure"

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

/** contacts.portal_tier — CHECK constraint */
export type ContactsPortalTier = "lead" | "formation" | "onboarding" | "active"

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

/** esign_signers.status — CHECK constraint */
export type EsignSignersStatus = "pending" | "sent" | "viewed" | "signed" | "declined"

/** esign_template_fields.field_type — CHECK constraint */
export type EsignTemplateFieldsFieldType = "signature" | "initials" | "date" | "text" | "checkbox"

/** esign_templates.status — CHECK constraint */
export type EsignTemplatesStatus = "active" | "archived"

/** invoice_reminder_log.source — CHECK constraint */
export type InvoiceReminderLogSource = "auto" | "manual"

/** member_info_requests.status — CHECK constraint */
export type MemberInfoRequestsStatus = "pending" | "submitted"

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
export type MessagingChannelsProvider = "wassenger" | "telegram_bot_api" | "meta" | "twilio"

/** messaging_groups.group_type — CHECK constraint */
export type MessagingGroupsGroupType = "support_group" | "lead_chat" | "internal" | "other"

/** payments.bank_preference — CHECK constraint */
export type PaymentsBankPreference = "auto" | "relay" | "mercury" | "revolut" | "airwallex"

/** payments.installment — CHECK constraint */
export type PaymentsInstallment = "Setup Fee" | "Installment 1 (Jan)" | "Installment 2 (Jun)" | "Annual Payment" | "One-Time Service" | "Custom" | "One-Time" | "One-time" | "ITIN"

/** payments.payment_category — CHECK constraint */
export type PaymentsPaymentCategory = "setup_fee" | "installment_1" | "installment_2" | "annual_renewal" | "one_time" | "itin" | "custom" | "credit" | "other"

/** portal_announcements.type — CHECK constraint */
export type PortalAnnouncementsType = "info" | "warning" | "success"

/** portal_messages.sender_context — CHECK constraint */
export type PortalMessagesSenderContext = "person" | "company"

/** portal_messages.sender_type — CHECK constraint */
export type PortalMessagesSenderType = "client" | "admin" | "system"

/** portal_team_members.status — CHECK constraint */
export type PortalTeamMembersStatus = "active" | "revoked"

/** task_action_log.status — CHECK constraint */
export type TaskActionLogStatus = "pending" | "success" | "failed" | "partial"

/** workflow_dispatch_log.outcome — CHECK constraint */
export type WorkflowDispatchLogOutcome = "spawned" | "no_trigger_match" | "ambiguous" | "snapshot_invalid" | "meta_invalid" | "spawn_failed" | "already_spawned"

/** workflow_dispatch_log.trigger_source — CHECK constraint */
export type WorkflowDispatchLogTriggerSource = "form_submission" | "sd_created" | "chain"
