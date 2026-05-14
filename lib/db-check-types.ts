/**
 * Auto-generated CHECK constraint types from Supabase public schema.
 * Source: scripts/gen-check-types.ts
 * DO NOT EDIT — regenerate with: npx tsx scripts/gen-check-types.ts
 */

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

/** catalog_decision_log.action — CHECK constraint */
export type CatalogDecisionLogAction = "added" | "renamed" | "deprecated" | "restored" | "tagged" | "metadata_changed" | "translation_added" | "translation_changed"

/** catalog_decision_log.actor_kind — CHECK constraint */
export type CatalogDecisionLogActorKind = "chat" | "ui" | "migration" | "admin_api"

/** catalog_entries.status — CHECK constraint */
export type CatalogEntriesStatus = "active" | "deprecated" | "exception_only"

/** catalog_pending_review.source — CHECK constraint */
export type CatalogPendingReviewSource = "whop_webhook" | "stripe_webhook" | "plaid_webhook" | "manual_form" | "admin_input" | "mcp_tool"

/** catalog_pending_review.status — CHECK constraint */
export type CatalogPendingReviewStatus = "pending" | "approved_added" | "approved_aliased" | "rejected"

/** contact_request_forms.form_type — CHECK constraint */
export type ContactRequestFormsFormType = "add_new" | "update_existing"

/** contact_request_forms.status — CHECK constraint */
export type ContactRequestFormsStatus = "pending" | "submitted" | "cancelled"

/** contacts.portal_tier — CHECK constraint */
export type ContactsPortalTier = "lead" | "formation" | "onboarding" | "active"

/** member_info_requests.status — CHECK constraint */
export type MemberInfoRequestsStatus = "pending" | "submitted"

/** members.member_type — CHECK constraint */
export type MembersMemberType = "individual" | "company"

/** payments.installment — CHECK constraint */
export type PaymentsInstallment = "Setup Fee" | "Installment 1 (Jan)" | "Installment 2 (Jun)" | "Annual Payment" | "One-Time Service" | "Custom" | "One-Time" | "One-time" | "ITIN"

/** portal_announcements.type — CHECK constraint */
export type PortalAnnouncementsType = "info" | "warning" | "success"

/** portal_messages.sender_context — CHECK constraint */
export type PortalMessagesSenderContext = "person" | "company"

/** service_catalog.default_service_context — CHECK constraint */
export type ServiceCatalogDefaultServiceContext = "individual" | "business" | "ask"
