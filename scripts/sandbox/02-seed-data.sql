-- ============================================================
-- TD Operations - Sandbox Seed Data
-- Reference tables: pipeline_stages, knowledge_articles, sop_runbooks,
--                   approved_responses, email_templates
-- system_docs excluded (contains session state + credentials)
-- ============================================================

-- pipeline_stages: 56 rows
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('c88d1e5c-346b-4e7e-a4f1-216138c310ad', 'Tax Return', -1, 'Company Data Pending', NULL, '[]', '[]', NULL, FALSE, '2026-04-13T01:41:34.671768+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('d2ba1247-5428-44df-935d-fea1ac5519da', 'Tax Return', 0, 'Paid - Awaiting Data', NULL, '[]', '[]', NULL, FALSE, '2026-04-13T01:41:34.671768+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('0b2581c7-1719-4f3c-b26e-f3fe523e661d', 'ITIN', 1, 'Data Collection', 'Send ITIN form to client, collect personal info + passport', '[{"title": "Verify ITIN wizard available in portal", "category": "Document", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'We need your personal information and passport to start.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('1dee84b8-7a1b-4627-8624-48cd97e88c73', 'Banking Physical', 1, 'Scheduling', 'Schedule in-person bank appointment', '[]', '[]', 7, FALSE, '2026-03-18T18:29:27.25257+00:00', TRUE, 'We are scheduling your bank appointment.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('7732edf9-59ea-4e92-90ce-dcfe49505b3e', 'Company Closure', 1, 'Data Collection', 'Standalone clients: send closure form to collect LLC details (name, state, EIN, formation date, RA info, tax history). Existing clients: skip this stage — data already in CRM.', '[{"title": "Send closure data collection form to client", "category": "Client Communication", "assigned_to": "Luca"}, {"title": "Review submitted closure form data", "category": "Document", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-16T20:02:56.231933+00:00', TRUE, 'Collecting your company details for the dissolution process.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('4747b067-2f6b-4f1d-b313-b89bc6c45a36', 'Company Formation', 1, 'Data Collection', 'Send formation form (formation_form_create) to client. Client fills personal info, LLC name preferences, address, passport. Review data (formation_form_review). Create Contact (NO Account yet). Task Luca: create WhatsApp group.', '[{"title": "Verify wizard data and passport uploaded", "category": "Document", "assigned_to": "Luca"}, {"title": "Check LLC name availability on state portal", "category": "Filing", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-11T19:29:46.031014+00:00', TRUE, 'We are collecting your information to start the formation process.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('88745cdf-0930-4d35-90d2-c5db3587c32a', 'State RA Renewal', 1, 'Upcoming', 'Auto-creato 30gg prima della scadenza ra_renewal_date. NON-POSTPONABILE.', '[{"title": "Verify account is active and not offboarding", "category": "Internal", "assigned_to": "Luca"}, {"title": "If active: proceed with renewal (non-postponable)", "category": "Filing", "assigned_to": "Luca"}]', '[]', 10, FALSE, '2026-03-15T14:12:06.872434+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('7ee2843d-2098-4662-a68b-ef5a8730fb6a', 'Annual Renewal', 1, 'Invoice Sent', 'Annual renewal invoice sent to client', '[{"title": "Create and send CRM invoice for annual renewal", "category": "Payment", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-18T18:29:40.597289+00:00', TRUE, 'Your annual renewal invoice has been sent.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('266ddc22-bcb5-444a-a44d-2ae3f4de02c4', 'EIN', 1, 'SS-4 Preparation', 'Prepare Form SS-4 with client data', '[]', '[]', 3, FALSE, '2026-03-18T18:28:57.505387+00:00', TRUE, 'We are preparing your EIN application form.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('c1facd3a-3e25-4358-a778-f3a3b64393b2', 'State Annual Report', 1, 'Upcoming', 'Auto-creato 45gg prima della deadline. Verifica account attivo e pagamento.', '[{"title": "Verify account active and payment current", "category": "Internal", "assigned_to": "Luca"}, {"title": "Create task with state deadline", "category": "Filing", "assigned_to": "Luca"}]', '[]', 15, FALSE, '2026-03-15T14:12:06.872434+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('456ae784-8c4b-405e-bb26-9b9a390c3ef0', 'CMRA Mailing Address', 1, 'Lease Created', 'Lease agreement created and sent for signature', '[{"title": "Verify lease auto-generated in portal", "category": "Document", "assigned_to": "Luca"}]', '[]', 3, FALSE, '2026-03-18T18:29:37.761557+00:00', TRUE, 'Your lease agreement has been prepared and sent for signature.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('c66efd48-9a58-4e36-a88e-a37e985a1501', 'Tax Return', 1, '1st Installment Paid', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('c63577b7-616f-4817-8734-5a0ee83446f6', 'Client Onboarding', 1, 'Data Collection', 'Send onboarding form (onboarding_form_create) to client. Client fills personal info, LLC details, passport, Articles, EIN letter. Uploads documents to Supabase Storage.', '[{"title": "Verify portal wizard available for client", "category": "Document", "assigned_to": "Luca"}, {"title": "Follow up if wizard not completed within 5 days", "category": "Follow-up", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-12T02:34:03.963121+00:00', TRUE, 'We are collecting your company details and documents.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('ff96fd06-5fe1-4400-9c9b-7d335c0cd29d', 'Banking Fintech', 1, 'Data Collection', 'Banking form sent to client', '[{"title": "Verify banking wizard available in portal", "category": "Document", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-18T18:28:41.913139+00:00', TRUE, 'We need your banking information to proceed with the application.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('5e4c5591-b662-42ad-88c0-3a1b004ce09c', 'EIN', 2, 'SS-4 Submitted', 'SS-4 faxed or mailed to IRS', '[]', '[]', 1, FALSE, '2026-03-18T18:28:58.629961+00:00', TRUE, 'Your EIN application has been submitted to the IRS.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('249bbeaf-0a69-4cad-8db5-ffb3ed6c2303', 'Annual Renewal', 2, 'Payment Received', 'Client paid annual renewal', '[{"title": "Create 4 recurring SDs: RA Renewal, Annual Report, CMRA, Tax Return", "category": "CRM Update", "assigned_to": "Luca"}]', '[]', 30, FALSE, '2026-03-18T18:29:41.636225+00:00', TRUE, 'Payment received — thank you!') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('f612e862-0e6e-46e5-9302-3480ed73b3e4', 'State RA Renewal', 2, 'Renewal', 'Accedere a Harbor Compliance e autorizzare il rinnovo.', '[{"title": "Log into Harbor Compliance and authorize renewal", "category": "Filing", "assigned_to": "Luca"}, {"title": "Confirm payment $35 and download confirmation", "category": "Payment", "assigned_to": "Luca"}, {"title": "Save confirmation to Drive and update ra_renewal_date", "category": "Document", "assigned_to": "Luca"}]', '[]', 10, FALSE, '2026-03-15T14:12:06.872434+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('cc6dfdd6-9e79-4bd2-a388-fcf34568c1f6', 'State Annual Report', 2, 'In Progress', 'Filing annual report sul portale dello stato.', '[{"title": "Access state portal and submit Annual Report", "category": "Filing", "assigned_to": "Luca"}, {"title": "Pay state fee and download confirmation", "category": "Payment", "assigned_to": "Luca"}, {"title": "Save to Drive and update CRM", "category": "Document", "assigned_to": "Luca"}]', '[]', 15, FALSE, '2026-03-15T14:12:06.872434+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('9d433526-4a3d-466d-9a85-a348583c309e', 'Tax Return', 2, 'Extension Filed', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('ab6e87c6-29c8-47e7-9e97-b5695fb88c48', 'ITIN', 2, 'Document Preparation', 'Generate W-7, 1040-NR, Schedule OI from submitted data', '[{"title": "Generate ITIN documents (W-7 + 1040-NR + Schedule OI)", "category": "Document", "assigned_to": "Luca"}]', '[]', 3, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'Preparing your W-7 and tax forms.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('41b9fc1a-3b3e-46a4-9274-b50cff026ced', 'Company Formation', 2, 'State Filing', 'Agree state with client (NM/WY/FL). Verify name availability on SOS portal. File Articles of Organization. WY: immediate. FL/NM: wait for SOS confirmation. Once LLC confirmed: create Account (company_name, state, formation_date), link Contact to Account, create Drive folder Companies/{State}/{Company}/, upload Articles, activate Registered Agent on Harbor Compliance.', '[{"title": "File Articles of Organization with state", "category": "Filing", "assigned_to": "Luca"}, {"title": "Run formation_confirm after SOS confirmation", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Activate Registered Agent on Harbor Compliance", "category": "Filing", "assigned_to": "Luca"}, {"title": "Upload Articles to portal Documents", "category": "Document", "assigned_to": "Luca"}]', '[]', 14, FALSE, '2026-03-11T19:29:46.031014+00:00', FALSE, 'Your LLC is being filed with the state. We will notify you once confirmed.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('e20077fa-12a9-4629-bb40-1bc8f5f18d30', 'Banking Fintech', 2, 'Application Submitted', 'Banking application submitted to provider', '[{"title": "Submit banking application", "category": "Filing", "assigned_to": "Luca"}]', '[]', 3, FALSE, '2026-03-18T18:28:41.913139+00:00', TRUE, 'Your banking application has been submitted.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('14e70237-4f0e-4d0e-a240-3e634de648a4', 'Banking Physical', 2, 'Application Prepared', 'Prepare documents for bank visit', '[]', '[]', 3, FALSE, '2026-03-18T18:29:28.312154+00:00', TRUE, 'Preparing the documents for your bank visit.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('a3b63d34-90ad-458c-ae35-6ae027846856', 'CMRA Mailing Address', 2, 'Lease Signed', 'Client signed lease agreement', '[{"title": "Activate CMRA address and update account", "category": "CRM Update", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-18T18:29:38.72891+00:00', TRUE, 'Lease signed — setting up your mailing address.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('a89682f1-dd4c-4e3c-9042-9a7df2b349fc', 'Company Closure', 2, 'State Compliance Check', 'Verify state requirements before dissolution: check outstanding taxes, unpaid fees, annual report status. Resolve any outstanding obligations before filing.', '[{"title": "Check outstanding state taxes and fees", "category": "Filing", "assigned_to": "Luca"}, {"title": "Verify annual reports are up to date", "category": "Filing", "assigned_to": "Luca"}, {"title": "Resolve any outstanding obligations with the state", "category": "Filing", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-16T20:03:07.210298+00:00', TRUE, 'Verifying all state obligations are met before filing.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('b856f9b4-1a8d-4f39-99e1-67d727dbfdba', 'Client Onboarding', 2, 'Review & CRM Setup', 'Magic Button: onboarding_form_review(token, apply_changes=true). Auto: find/create/update Contact and Account, link them, create Drive folder + copy documents, auto-create Lease Agreement (draft, auto-suite 3D-XXX), mark lead as Converted. Auto-tasks created: WhatsApp group (Luca), review and send lease (Antonio), RA change on Harbor Compliance (Luca). If tax return needed: create Tax Return service delivery.', '[{"title": "Change Registered Agent on Harbor Compliance", "category": "Filing", "assigned_to": "Luca"}, {"title": "Process uploaded documents: doc_bulk_process", "category": "Document", "assigned_to": "Luca"}, {"title": "Verify OA + Lease auto-generated in portal for signing", "category": "Document", "assigned_to": "Luca"}]', '[]', 3, FALSE, '2026-03-12T02:34:03.963121+00:00', TRUE, 'We are reviewing your information and setting up your account.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('aa9e38f8-6138-4d4a-8be0-cbefcf14f29b', 'Annual Renewal', 3, 'Services Renewed', 'All annual services renewed (RA, CMRA, Annual Report)', '[{"title": "Verify all annual SDs created and active", "category": "CRM Update", "assigned_to": "Luca"}]', '[]', NULL, FALSE, '2026-03-18T18:29:42.881955+00:00', TRUE, 'All your annual services have been renewed.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('a0fa9529-98c4-4e46-819a-cd920414cda5', 'Company Formation', 3, 'EIN Application', 'Prepare SS-4 form. Send SS-4 to client for digital signature (email only). Fax SS-4 to IRS. Follow up IRS if no response after 7 days. EIN received: save to Drive, update Account (ein_number), email client with confirmation.', '[{"title": "Generate SS-4 for portal signing", "category": "Document", "assigned_to": "Luca"}, {"title": "Fax signed SS-4 to IRS", "category": "Filing", "assigned_to": "Luca"}]', '[]', 14, FALSE, '2026-03-11T19:29:46.031014+00:00', FALSE, 'Your EIN application has been submitted to the IRS. Typically takes 5-7 business days.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('671e5bc7-a64b-4646-80e2-bad06afd6f19', 'State Annual Report', 3, 'Completed', 'Filing completato. NON notificare il cliente.', '[{"title": "Close service delivery", "category": "CRM Update", "assigned_to": "Luca"}]', '[]', NULL, FALSE, '2026-03-15T14:12:06.872434+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('b8bda4b4-9581-45d4-a17d-a79fb2d2c851', 'Client Onboarding', 3, 'Post-Review & Closing', 'Start RA change process on Harbor Compliance. Classify documents in Drive (doc_bulk_process). Activate client portal. Upload documents to portal. Send welcome email + WhatsApp/Telegram group invite. Send review request (Google + Trustpilot).', '[{"title": "Verify RA change completed on Harbor", "category": "Filing", "assigned_to": "Luca"}, {"title": "Verify all portal items signed (OA, Lease, Banking)", "category": "Document", "assigned_to": "Luca"}, {"title": "Create annual SDs: RA Renewal, Annual Report, CMRA", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Send review request (Google + Trustpilot)", "category": "Client Communication", "assigned_to": "Antonio"}]', '[]', 7, FALSE, '2026-03-12T02:34:03.963121+00:00', FALSE, 'Finalizing your setup — documents, portal access, and welcome package.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('d47cfe67-26a5-4b97-9cf7-94380d5338b5', 'Banking Fintech', 3, 'Awaiting Verification', 'Provider reviewing application, KYC in progress', '[]', '[]', 14, FALSE, '2026-03-18T18:28:41.913139+00:00', TRUE, 'The bank is reviewing your application. This may take a few days.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('f54d5307-b6a5-400f-97a2-c49d408e182a', 'State RA Renewal', 3, 'Completed', 'Rinnovo completato. NON notificare il cliente.', '[{"title": "Close service delivery", "category": "CRM Update", "assigned_to": "Luca"}]', '[]', NULL, FALSE, '2026-03-15T14:12:06.872434+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('234ea667-d6ab-4af2-a292-b93466fa6ab6', 'EIN', 3, 'Awaiting EIN', 'Waiting for IRS to assign EIN', '[]', '[]', 42, FALSE, '2026-03-18T18:28:59.591753+00:00', TRUE, 'Waiting for the IRS to assign your EIN. Typically 5-7 business days.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('f2aadc20-a379-454b-a067-8338893168ba', 'Company Closure', 3, 'State Dissolution Filing', 'Fill out Articles of Dissolution document, print, prepare shipping label for the state, and mail. Physical mail — not an online portal. Wait for state confirmation.', '[{"title": "Fill out Articles of Dissolution form with LLC data", "category": "Document", "assigned_to": "Luca"}, {"title": "Print Articles of Dissolution", "category": "Document", "assigned_to": "Luca"}, {"title": "Prepare shipping label and mail to state", "category": "Shipping", "assigned_to": "Luca"}, {"title": "Save tracking number in CRM", "category": "Filing", "assigned_to": "Luca"}, {"title": "Wait for state confirmation of dissolution", "category": "Filing", "assigned_to": "Luca"}]', '[]', 14, FALSE, '2026-03-16T20:03:12.973435+00:00', TRUE, 'Dissolution papers have been filed with the state.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('75a78d1b-4695-4ca8-b11f-3f8a54c9534b', 'Banking Physical', 3, 'Bank Visit', 'In-person visit to bank with client', '[]', '[]', NULL, FALSE, '2026-03-18T18:29:29.118813+00:00', TRUE, 'Your bank appointment is scheduled.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('1be99274-e264-4508-abc0-d7884e7b21e6', 'CMRA Mailing Address', 3, 'CMRA Active', 'Mail forwarding active, address assigned', '[]', '[]', NULL, FALSE, '2026-03-18T18:29:39.75125+00:00', TRUE, 'Your mailing address is active and ready to receive mail!') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('2697603e-5a23-4547-98f4-4d79b60353ab', 'ITIN', 3, 'Client Signing', 'Email documents to client for wet ink signature + mailing', '[{"title": "Upload W-7 + 1040-NR to portal for client signature", "category": "Document", "assigned_to": "Luca"}]', '[]', 14, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'Please sign and mail back the documents we sent you.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('41cf6bb8-c83a-42bf-a9f0-4aea10d5db30', 'Tax Return', 3, 'Data Received', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('a5368937-6cfd-478d-8334-9ab9a7dc7c01', 'Tax Return', 4, 'Awaiting 2nd Payment', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('87b8b8bc-faf6-4e60-86d1-24c7f2629799', 'Banking Fintech', 4, 'Account Opened', 'Account approved and active', '[{"title": "Notify client of account opening", "category": "Client Communication", "assigned_to": "Luca"}]', '[]', NULL, FALSE, '2026-03-18T18:28:41.913139+00:00', TRUE, 'Your bank account is now open and ready to use!') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('e2ad4c47-668c-4633-9506-6f43e262794c', 'Company Closure', 4, 'IRS Closure', 'Fill out EIN closure form, print, prepare shipping label for IRS, and mail. If final tax return needed, India prepares it and we mail it together with the closure form.', '[{"title": "Fill out EIN closure form", "category": "Document", "assigned_to": "Luca"}, {"title": "If final tax return needed: send data to India team", "category": "Filing", "assigned_to": "Luca"}, {"title": "Print EIN closure form (+ final tax return if applicable)", "category": "Document", "assigned_to": "Luca"}, {"title": "Prepare shipping label and mail to IRS", "category": "Shipping", "assigned_to": "Luca"}, {"title": "Save tracking number in CRM", "category": "Filing", "assigned_to": "Luca"}]', '[]', 14, FALSE, '2026-03-16T20:03:19.314791+00:00', TRUE, 'Closing your EIN with the IRS.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('c69371a4-ad92-4b06-b202-3387401ec209', 'EIN', 4, 'EIN Received', 'EIN assigned and saved to CRM', '[]', '[]', NULL, FALSE, '2026-03-18T18:29:20.156401+00:00', TRUE, 'Your EIN has been assigned! Check your documents for the confirmation letter.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('b926c4e5-4b5e-4a6d-b623-b9d06beb6a93', 'Company Formation', 4, 'EIN Submitted', 'SS-4 faxed to IRS, awaiting EIN letter.', '[{"title": "Follow up IRS if no response after 7 days", "category": "Follow-up", "assigned_to": "Luca"}, {"title": "Upload EIN letter to portal", "category": "Document", "assigned_to": "Luca"}]', '[]', NULL, FALSE, '2026-03-30T13:41:01.153407+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('1e7cd746-5104-4381-9010-4dc523b82eb6', 'ITIN', 4, 'Documents Received', 'Signed documents received from client via mail', '[{"title": "Verify signed documents received", "category": "Document", "assigned_to": "Antonio"}]', '[]', 21, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'We received your signed documents.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('179ac365-f5fe-45e8-8348-44c8634ee827', 'Banking Physical', 4, 'Account Opened', 'Account approved and active', '[]', '[]', NULL, FALSE, '2026-03-18T18:29:29.978281+00:00', TRUE, 'Your bank account is now open and ready to use!') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('9a1bb712-97c2-4775-a117-47fc695ee627', 'Company Closure', 5, 'Closing', 'All closure steps complete. Cancel Registered Agent on Harbor Compliance. Cancel CMRA/lease if active. Remove from Annual Renewal pipeline. Update account status to Inactive. Notify client that closure is complete.', '[{"title": "Cancel Registered Agent on Harbor Compliance", "category": "Filing", "assigned_to": "Luca"}, {"title": "Cancel CMRA/lease if active", "category": "Filing", "assigned_to": "Luca"}, {"title": "Remove from Annual Renewal pipeline", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Update account status to Inactive", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Notify client that closure is complete", "category": "Client Communication", "assigned_to": "Luca"}]', '[]', 3, FALSE, '2026-03-16T20:03:29.733814+00:00', TRUE, 'All closure steps complete. Your company is officially dissolved.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('f81c0b6e-2603-4398-8fa2-b05082658398', 'Company Formation', 5, 'Post-Formation + Banking', 'Create lease agreement (lease_create) and send to client (lease_send). Send Relay Bank form. Send Payset Bank form. Quality check: doc_compliance_check(account_id). Welcome email with all links (welcome_package_prepare).', '[{"title": "Verify OA auto-generated in portal for signing", "category": "Document", "assigned_to": "Luca"}, {"title": "Verify Lease auto-generated in portal for signing", "category": "Document", "assigned_to": "Luca"}, {"title": "Verify banking wizard available in portal", "category": "Document", "assigned_to": "Luca"}, {"title": "Run document compliance check", "category": "Document", "assigned_to": "Luca"}]', '[]', 10, FALSE, '2026-03-11T19:29:46.031014+00:00', TRUE, 'Setting up your lease agreement and bank accounts.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('5dde8f4c-fab9-4034-851b-ab7a56d72592', 'ITIN', 5, 'CAA Review', 'Certified Acceptance Agent reviews and certifies passport copies', '[{"title": "CAA review and passport certification", "category": "KYC", "assigned_to": "Antonio"}]', '[]', 3, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'Your documents are being reviewed and certified.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('ff36c06a-d370-4255-9d3c-66de770bc611', 'Tax Return', 5, 'Preparation', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('f3ca4186-d488-4a63-b3f3-869e8ab4f929', 'ITIN', 6, 'Submitted to IRS', 'Complete ITIN package mailed to IRS Austin Processing Center', '[{"title": "Mail ITIN package to IRS Austin", "category": "Filing", "assigned_to": "Luca"}]', '[]', 7, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'Your ITIN application has been mailed to the IRS.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('dcfb2359-103c-4993-8319-fbe81ebf605e', 'Company Formation', 6, 'Closing', 'Banks opened / process completed. Send email requesting Google + Trustpilot review.', '[{"title": "Verify all portal items signed (OA, Lease)", "category": "Document", "assigned_to": "Luca"}, {"title": "Create annual SDs: RA Renewal, Annual Report, CMRA", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Send review request (Google + Trustpilot)", "category": "Client Communication", "assigned_to": "Antonio"}]', '[]', 7, FALSE, '2026-03-11T19:29:46.031014+00:00', FALSE, 'Final checks and delivery of all your documents.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('859b54c1-b510-4aed-a9f9-354cda465234', 'Tax Return', 6, 'TR Completed', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('b89e8bf7-9ec1-4bdc-8815-7c0cc755b279', 'ITIN', 7, 'IRS Processing', 'Waiting for IRS to process (7-11 weeks typical)', '[]', '[]', 77, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'The IRS is processing your application. This takes 7-11 weeks.') ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('ea3d9dbb-93bf-4702-b2c5-386f5ad3c3ec', 'Tax Return', 7, 'TR Filed', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('02fd6ae9-e27c-47ac-bbb8-ba9cebbdcb36', 'Tax Return', 8, 'Terminated - Non Payment', NULL, '[]', '[]', NULL, FALSE, '2026-04-09T00:31:06.13741+00:00', TRUE, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO pipeline_stages (id, service_type, stage_order, stage_name, stage_description, auto_tasks, auto_actions, sla_days, requires_approval, created_at, auto_advance, client_description) VALUES ('b106333d-30f9-40d3-8e51-1672017a66b4', 'ITIN', 8, 'ITIN Approved', 'ITIN number received from IRS, notify client', '[{"title": "Upload ITIN letter to portal + update contact.itin_number", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Notify client via portal notification", "category": "Client Communication", "assigned_to": "Luca"}]', '[]', NULL, FALSE, '2026-03-18T16:47:00.090646+00:00', TRUE, 'Your ITIN has been approved! You will receive it by mail.') ON CONFLICT (id) DO NOTHING;

-- knowledge_articles: 117 rows
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('af1d4987-8844-45ca-bb53-0d575a33264f', 'Late-pay Assistance Fee ($500)', 'LATE-PAY ASSISTANCE FEE ($500)

When a client pays late (after the tax deadline or state renewal deadline) and IRS penalties or state penalties/notices occur as a result:

RULE: Apply a $500 assistance fee for handling penalties and IRS/state notices.

PROCESS:
1. Client pays late (after applicable deadline)
2. If penalties or IRS/state notices are generated due to the late filing:
   - Send IRS-penalty disclaimer for client signature
   - Record signed disclaimer in Deal/Account
   - Apply $500 assistance fee
3. The fee covers the additional work of:
   - Responding to IRS/state notices
   - Filing amended returns if needed
   - Penalty abatement requests
   - Additional correspondence with tax authorities

IMPORTANT:
- This fee is separate from the regular annual service fees
- Client must sign the disclaimer acknowledging they understand the consequences of late payment
- The fee applies per incident/notice, not per year
- For state renewals: late filing may result in state penalties and reinstatement fees that are the client''s responsibility', 'Pricing', NULL, NULL, '[Migrated] Applies To: Tax Return, State Renewal | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'rec1K5fRWE147L4qc', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('726aab71-b7c1-475c-b071-88416268d58b', 'Pacific National Bank — Account Details (International Clients)', 'Contact: Guillermo Ruiz — GRuiz@pnb.com — 305.539.7678
Address: 1390 Brickell Avenue, Miami, FL 33131
Use for: Non-resident account openings (business and personal).
Online banking support: 305.539.7609 / onlinebankingsupport@pnb.com

BUSINESS CHECKING (DDA — Foreign Customers):
- Minimum daily balance: $5,000 to avoid monthly maintenance charge of $50
- 30 transactions/month free, excess $1.00 each
- Online banking free
- Debit card available
- Requirements: completed application (2 pages company + 1 page per signer), 2 valid IDs per signer/director/shareholder, Articles of Incorporation, EIN, detailed business description, purpose of US account, transaction types and estimated amounts, list of shareholders/directors, list of clients/suppliers
- Source: Email from Guillermo Ruiz to Antonio, 11 Jun 2025

PERSONAL CHECKING (DDA — Foreigners):
- Minimum daily balance: $5,000 to avoid monthly maintenance charge of $50
- 30 debits/month free, excess $0.50 each
- Third-party transactions prohibited (Federal regulation)
- Debit card: ATM withdrawal up to $1,000/day, fee $3.00 per withdrawal. Purchases enabled with credit limit, cost 1% of purchase amount
- Online banking free, domestic US payments included
- International transfers: via application form provided by bank
- Requirements: completed application, 2 valid IDs per signatory + 1 per beneficiary, purpose of US account, source of income/employer details, proof of residential address (utility bill, rental agreement, or property deed)
- Source: Email from Guillermo Ruiz to Tony, 10 Dec 2025

NOTE: LLC must be registered in Florida (foreign qualification) before opening accounts. Compliance department reviews and approves/rejects all applications — no reasons given for rejections.', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Physical | Updated By: Antonio | Last Updated: 2026-02-10', 'recjACnL05Ni1WZI4', '2026-03-03T18:49:32.212304+00:00', '2026-03-11T20:10:23.211396+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('c834ef2d-e79b-474e-bd90-3eb9d245507a', 'Standard Response: Telegram Welcome New Client', 'Quando usare: Dopo l''onboarding di un nuovo cliente, per invitarlo al gruppo di supporto Telegram.

Template:
Ciao [Nome]! Benvenuto/a in Tony Durante LLC.

Ti invio il link per unirti al nostro gruppo di supporto su Telegram, dove potrai ricevere assistenza dedicata per tutto ciò che riguarda la tua LLC:
[LINK GRUPPO TELEGRAM]

Nel gruppo il nostro team è a disposizione per qualsiasi domanda o necessità: documenti, scadenze, banking, e molto altro.

A presto!

Canale: WhatsApp / Telegram
Note: Sostituire [Nome] e [LINK GRUPPO TELEGRAM]. Inviare dopo conferma pagamento e avvio onboarding.', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Onboarding | Updated By: Claude | Last Updated: 2026-02-06', 'rec4g2KvEa13JmjUQ', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('f6ee7283-3c0d-41ef-ac39-8412532d50ea', 'Banking Partner: Truly Financial — DO NOT RECOMMEND', 'Status: PROBLEMATICO — diversi clienti hanno avuto problemi (blocchi fondi, rimozione conti in EUR, servizio inaffidabile).

NON consigliare a nuovi clienti.', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Fintech | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-10', 'rec4vpEjLPkGygkmK', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e174056c-5abc-4d72-ab77-cf590c14b7cf', 'Additional Services Pricing', 'ITIN: €500
1st physical bank account: $1,500
Additional bank accounts: $500 each
Relay Financial: Included in LLC (or $300 standalone)
Office Lease Agreement (MaxScale): $1,200', 'Pricing', NULL, NULL, '[Migrated] Applies To: ITIN, Banking Physical, Banking Fintech | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recQjqQVbJbznzAIi', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('7cd11656-5fef-4fef-adb8-b84acb3cd454', 'Old Office Address (Closed)', '13057 Park Blvd, Seminole — CLOSED. Mail forwarding is active.', 'Business Rules', NULL, NULL, '[Migrated] Applies To: CMRA, Shipping | Updated By: Antonio | Last Updated: 2026-02-06', 'recRCEDseuxt0whji', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('77cd378f-996d-4fa2-b339-07cd34fe30ac', 'Payment Follow-up Cadence', 'PAYMENT FOLLOW-UP CADENCE (Annual Renewal)

When an installment is due (Jan 1 or Jun 1) and remains unpaid:

- Day 0: Invoice created (portal billing, QB fallback). Payment details visible in portal.
- Day 7: First reminder -- friendly follow-up via email/WhatsApp/Telegram (rule P10)
- Day 10: Escalation -- direct message via Telegram/WhatsApp with urgency
- Day 14+: Manual follow-up by Antonio/Luca; consider blocking services

RULES:
- No service until paid -- this is the core rule (Master Rules P1)
- If client requests delay: save evidence in account notes and set agreed follow-up date
- Do NOT start any operational workstream (tax return, state renewal, etc.) until payment is confirmed
- Payment confirmation: CRM payments table is SOT. Check crm_search_payments or Whop membership.

CANONICAL SOURCE: Master Rules (KB 370347b6), rules P1, P10.', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Annual Renewal | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'rec6o5XXIviqB1PXd', '2026-03-03T18:49:32.212304+00:00', '2026-04-01T13:46:33.20201+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('28c10048-eb46-4255-bc23-817f39610a8c', 'ITIN Pricing Rules', 'ITIN PRICING RULES

Pricing depends on when the client purchases the ITIN service:

| Timing | Price |
|--------|-------|
| During Company Formation (bundled in the offer) | EUR 500 |
| Standalone (existing client or non-client) | EUR 800 |

IMPORTANT NOTES:
- Tony Durante is an IRS Certified Acceptance Agent (CAA)
- As CAA, Tony certifies the passport — client does NOT need to send original passport to IRS
- Client must print W-7 and 1040NR in DOUBLE COPY, sign originals, and mail to our office
- Processing time: 2-4 months from IRS submission
- Month 3: If no ITIN received, call IRS CAA line for status update

BENEFITS TO EXPLAIN TO CLIENTS:
- LLC becomes more credible (owner has American tax ID)
- Payment gateways (Stripe) work better without issues
- Can open PayPal without problems
- Can get American credit cards
- Can build American credit score
- Can file personal US tax return (even just $50 in taxes)
- Important: with tax return, no one can say they are ''tax-free''

RENEWAL: Recommended every 2 years. Send renewal reminder proactively.', 'Pricing', NULL, NULL, '[Migrated] Applies To: ITIN | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'recC4NaO0pz92kH77', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('0f9bae18-0b26-459f-a9c7-89192a642792', 'Banking Partner: Payset', 'Servizio: IBAN europeo per LLC
Costo: Mensile (pagato dal cliente direttamente alla piattaforma, NON a Tony Durante)
Uso consigliato: Per ricevere bonifici SEPA in euro senza problemi di ''client reference''', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Fintech | Updated By: Antonio | Last Updated: 2026-02-10', 'recIJhcjsAT84YMHu', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e9d3cf5c-aa28-41dc-a9f3-5a48f2268834', 'Team India Tax Email', 'tax@adasglobus.com', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Tax Return | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recMZGMlAdk1QA8YP', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('9f8294e8-14ea-4de3-9646-6d8553af2efd', 'Tone Guidelines — Client Communication', 'Client Communication Style:
- Friendly but professional
- Direct and actionable
- No excessive formality

Italian Clients:
- Use informal ''tu'' (not ''Lei'')
- Warm, approachable
- Example: ''Ciao! Ecco le informazioni che ti servono...''

English Clients:
- Professional but not stiff
- Clear and concise
- Example: ''Hi! Here''s what you need to know...''

General Rules:
- Always respond, even just with ''grazie, buona giornata''
- Answer ONLY what was asked — no unsolicited extra info
- Match the client''s language automatically', 'Tone Guidelines', NULL, NULL, '[Migrated] CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recNjpLWcMqWFmPKW', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('d4ae79f4-732d-43dd-8ce5-aca739b3dc80', 'Filing Team (not CPA)', 'FILING TEAM — TAX RETURN PROCESSING

Tony Durante LLC uses an external filing team based in India for tax return preparation.

FILING TEAM DETAILS:
- Team: Adas Globus (India)
- Email: tax@adasglobus.com
- Role: Tax return preparation (NOT CPA — they are a filing/preparation team)
- They are NOT referred to as ''CPA'' or ''accountant'' — they are the ''filing team'' or ''preparation team''

EMAIL FORMAT:
- Subject: [Company Name] - [Client Name] - [EIN] - [Type]
- Types:
  - SMLLC = Single Member LLC
  - MMLLC = Multi Member LLC
  - LLC C Corp
- Examples:
  - Cash Cow Consulting LLC - Mirko Delfino - 12-3456789 - SMLLC
  - Virtus Commerce LLC - Balint Gulyas - 98-7654321 - MMLLC

WORKFLOW:
1. Pre-season: Update/verify year-specific tax forms
2. Send data-collection email to PAID/ACTIVE clients only
3. Client submits tax form
4. Internal review (Antonio/Luca) validates completeness
5. File extension by default as safety layer
6. After 2nd installment paid: package data and handoff to India filing team
7. India team prepares return: In Prep → In Review → Ready to File → Filed
8. Antonio reviews completed return
9. Send client copy for signature
10. Filed return copy to client + Drive + Portal

IMPORTANT:
- NEVER send tax data-collection link to non-paying clients
- Extension is filed by default as a safety measure
- Tax return NOT sent to India until 2nd payment confirmed
- Antonio reviews the form AND the filed return
- Forms must be updated/verified each year before sending', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Tax Return | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'recM3SEhsbzmyO4fQ', '2026-03-03T18:49:32.212304+00:00', '2026-03-15T02:23:16.43588+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('d83d36fd-ce0a-47bd-b5db-620e49bf351d', 'Annual Contract Terms (Jan-Dec)', 'ANNUAL CONTRACT TERMS

Contract period: January 1 to December 31 (calendar year)

PAYMENT STRUCTURE:
- Installment 1: Due January 1
- Installment 2: Due June 1
- Recurring invoices configured in QuickBooks

ANNUAL PRICING:
| Type | Installment 1 (Jan 1) | Installment 2 (Jun 1) | Total/Year |
| Single Member | $1,000 | $1,000 | $2,000 |
| Multi Member | $1,250 | $1,250 | $2,500 |

ONBOARDING PRICING (First Year - PAID IN EUROS):
| Type | Onboarding Cost |
| Single Member | EUR 2,500 (one-time) |
| Multi Member | EUR 3,000 (one-time) |

POST-SEPTEMBER RULE: Clients who complete onboarding/formation AFTER September 1st skip the January payment of the following year. The setup fee covers services until December 31st. First payment = June (2nd installment).

FIRST CONTACT RULE: First contact with clients always pays in Euros.

ANNUAL RENEWAL (from 2nd year): Paid in US Dollars.

PAYMENT METHODS:
- Bank wire (EUR: Airwallex IBAN DK8989000023658198, USD: Relay 200000306770/064209588)
- Credit card (with 5% surcharge via Whop)

CANCELLATION: Only permitted if cancellation request is submitted by October 31 AND both installments for the year have been paid.', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Annual Renewal | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'rec7SxCTqr8tLyQmg', '2026-03-03T18:49:32.212304+00:00', '2026-03-20T15:42:15.201581+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('586a0e04-6e84-45bc-8fd6-67ccf0223199', 'Offer Pricing for Proposals', 'Prices used in offers/proposals to new leads:

Gestione LLC (Single Member): €2,500
Gestione LLC (Multi Member): €3,000
ITIN bundled (in formation/onboarding offer): €500
ITIN standalone: €800

Note: Offer prices are in EUR and include premium positioning. Annual management prices are in USD.

Payment gateway and bank are now selectable per offer (commit 978d730):
- Gateway: Stripe (default) or Whop
- Bank: Auto (default), Relay, Mercury, Revolut, Airwallex', 'Pricing', NULL, NULL, '[Migrated] Applies To: Company Formation, Onboarding | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recGTZYnbQl9K1un9', '2026-03-03T18:49:32.212304+00:00', '2026-04-04T18:16:27.465636+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('bf1496d2-3858-4971-ac81-8d50222f53d5', 'Banking Partner: OFX', 'Servizio: Ricezione pagamenti in valuta estera (EUR → USD)
Nota: Funziona bene MA richiede che i clienti inseriscano la ''client reference'' nella causale del bonifico — può causare ritardi nell''allocazione dei fondi', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Fintech | Updated By: Antonio | Last Updated: 2026-02-10', 'recSlw1ZbCCeytLbU', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e1d31320-3f48-4ead-8556-130e3429db2d', 'LLC Management Pricing', 'Single Member LLC:
- Formation + 1st year: $1,000 + $1,000 = $2,000
- Annual renewal (from 2nd year): $1,000 + $1,000 = $2,000/yr

Multi Member LLC:
- Formation + 1st year: $1,250 + $1,250 = $2,500
- Annual renewal (from 2nd year): $1,250 + $1,250 = $2,500/yr', 'Pricing', NULL, NULL, '[Migrated] Applies To: Company Formation, Annual Renewal | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recUgj2Bv5ueIdiof', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('5d7b4d5f-3520-44d9-973c-0d77774b07f2', 'Tony''s Phone Number', '+1 727 452 1093', 'Business Rules', NULL, NULL, '[Migrated] CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'reccgPBDE4sQha0TT', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('6f27ffe2-9f75-45de-aee7-a1ac37e9d157', 'Wise Payment Rules', 'WISE PAYMENT RULES — IMPORTANT FIXED RULES

1. WISE IS AN EXCHANGE, NOT A BANK
   - Never use Wise for outgoing payments
   - Wise is ONLY for receiving payments in EUR via IBAN

2. CORRECT PROCESS:
   Receive on Wise (EUR) → Convert to USD → Transfer to Relay → Make payments from American bank (Relay/Mercury)

3. WHAT WISE IS FOR:
   - Receiving client payments in EUR
   - Converting EUR to USD
   - Transferring USD to the American bank account

4. WHAT WISE IS NOT FOR:
   - Making payments to suppliers/vendors
   - Transferring money to personal accounts
   - Any outgoing payments whatsoever

5. RISK:
   - If Wise is used improperly (outgoing payments, personal transfers), there is a concrete risk of account suspension/closure by Wise

6. STRIPE RULE:
   - Stripe payouts should go direct to Relay in USD
   - Avoid double pass through Wise (EUR→USD→EUR→USD)

7. MERCURY/RELAY:
   - These are NOT physical banks (no credit facilities, no loans)
   - They are fintech banking platforms for business operations', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Company Formation, Onboarding, Annual Renewal, Tax Return, State Renewal, CMRA, Shipping, Public Notary, Banking Fintech, Banking Physical, ITIN, Company Closure, Offboarding | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'receJz6ZDYsRvgVLx', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('dbf9a351-47c3-4c38-8681-c38afc5ca4aa', 'Standard Response: Relay Post-Application Message', 'Quando usare: Dopo aver completato l''application Relay per un cliente.

Template:
Ciao [Nome]! Abbiamo completato l''application Relay per [Società].

Dovresti aver ricevuto un''email da Relay con un invito. Ecco cosa fare:
1. Apri l''email da Relay e accetta l''invito
2. Segui le istruzioni a video per completare la verifica

Una volta completato, ci vorranno 1-2 giorni lavorativi per l''approvazione.

Canale: Telegram / WhatsApp
Note: Adattare nome e società. Per domande specifiche su Relay/NIUM, fare riferimento alle risposte approvate Banking-Relay-NIUM.', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Fintech, Onboarding | Updated By: Claude | Last Updated: 2026-02-06', 'recf1AkHQxIUd309Z', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('5afc15aa-b145-4dd9-ac5a-7b8dd948a3a8', 'Referral Commission Rule', 'Referral commission: 10% via credit note.', 'Pricing', NULL, NULL, '[Migrated] Applies To: Onboarding | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'reciomRrCQTYv8ndc', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('0ef7c28a-c8bb-45a8-8e14-a96c5b010861', 'Template Offerta — Permanent Rules', 'Regole permanenti per il template offerta (NON cambiare mai):

1. Stato di formazione: New Mexico — NON Wyoming. Tutte le offerte devono dire ''New Mexico LLC'', mai ''Wyoming LLC''.
2. Tax Return: solo ''Tax Return annuale'' — NON specificare form number (no ''Form 1065 + K-1'', no ''Form 1120-S / 5472''). Solo ''Tax Return annuale''.
3. NO ''Consulenza telefonica diretta con me'' — Questa voce NON deve apparire nella lista ''Include'' dei servizi.

Template HTML definitivo: 08-Knowledge/Templates/template-offerta.html
Logo: 08-Knowledge/Templates/tony-logos.jpg', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Company Formation, Onboarding | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-11', 'reclgMW711BMX0YPZ', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('b08163f3-df38-4da6-b90a-2ac576261b44', 'Current Office Address', '10225 Ulmerton Road, Suite 3D, Largo, FL 33771', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Company Formation, CMRA, Shipping | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recsF2zbPh6JaQPKf', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('52e49d55-b246-490b-a291-ef75246edd16', 'No Service Until Paid', 'PAYMENT GATING RULE

No service until paid. This applies to:
- New services
- Renewals
- Any work requiring our time

Exceptions must be approved by Antonio only.

IMPLEMENTATION:
- CRM payments table is the source of truth for payment status
- Whop memberships (whop_list_memberships) for card payments
- Wire/bank transfers: confirmed via Plaid auto-matching or manual wire check cron
- When payment confirmed: crm_update_record to mark payment as paid

CLIENT STATUS RULES:
- ACTIVE: Included in automations, reminders, communications
- INACTIVE: Excluded from ALL workflows, reminders, communications (used for cancellations)

CANONICAL SOURCE: Master Rules (KB 370347b6), rule P1.', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Company Formation, Onboarding, Annual Renewal, Tax Return, State Renewal, CMRA, Shipping, Public Notary, Banking Fintech, Banking Physical, ITIN, Company Closure, Offboarding | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'recg0QMkGjvaB1QeV', '2026-03-03T18:49:32.212304+00:00', '2026-04-01T13:46:37.240102+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('3769a9d0-ab29-4c59-84a7-690f8936e386', 'Tony Durante LLC — Mercury ACH Details', 'Beneficiary: Tony Durante LLC
Routing: 091311229
Account: 202236384517
Type: Business Checking
Bank: Choice Financial Group', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Fintech | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recrwTul5pTcfrKkK', '2026-03-03T18:49:32.212304+00:00', '2026-04-15T15:34:33.868953+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('a712a2ee-e440-4d44-919e-5a5207a9f483', 'Banking Partner: Relay Financial', 'Servizio: Business banking per LLC
Incluso nella gestione LLC (oppure $300 standalone)

⭐ PREFERRED BANK FOR NEW CLIENTS (over Mercury)

Novità: Relay offre ora conto in euro tramite Nium
Uso consigliato: Prima scelta per tutti i nuovi clienti. Alternativa per clienti che devono ricevere pagamenti in EUR da clienti europei.

Banking Partner: Mercury
Status: Secondary option / backup bank. NOT the primary recommendation for new clients.
Preferred: Relay is the primary bank for all new clients. Mercury can be recommended as a Plan B / second account.', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Fintech, Onboarding | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-10', 'recdRlzY5uQTlvOXA', '2026-03-03T18:49:32.212304+00:00', '2026-04-02T00:21:44.605479+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('3404c471-21f9-42d1-878a-f4221ff7c0ad', 'Banking Rules (Relay/Payset/Truly)', 'BANKING RULES — FINTECH

DIRECT APPLICATIONS (we do on behalf of client):
- ONLY Relay and Payset
- We submit the application in the bank portal entering company + owner data
- Client completes KYC/identity verification directly with the bank

CHAT ASSISTANCE ONLY (client does it themselves):
- Mercury
- Any other fintech platform
- We provide guidance and support via chat but do NOT submit applications

IMPORTANT FIXED RULES:
1. Mercury and Relay are NOT physical banks — they do not offer credit facilities or loans
2. Stripe payouts: Direct to Relay in USD — avoid double pass through Wise
3. Always recommend professional domain email (name@company.com or name@company.us), NOT Gmail
4. Wise: ONLY for receiving EUR payments via IBAN — NEVER for outgoing payments

DEBIT CARDS:
- Cards are often mailed to the CMRA address
- When cards arrive: notify client
- Shipping cards to client = PAID service (Shipping SOP)
- Do NOT ship until client has paid for shipping

KYC ISSUES:
- If KYC fails or bank requests more info: request from client, update status, keep evidence in Notes
- Create follow-up tasks if KYC is pending beyond expected timeframe

RELAY IBAN/NIUM:
- Relay uses Nium for international wire capability
- Delays in IBAN activation are common and affect ALL clients (not individual issue)
- Alternative during delay: Wise as temporary solution for receiving international payments', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Fintech | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'recu2WRhyyPe0dTfo', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('20a0c95a-d9bf-462d-84e9-62b31d2a4289', 'Payment Policy — No Service Until Paid', 'NO SERVICE UNTIL PAID.

This is a strict rule: no work begins on any service until the client has completed payment in full.', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Company Formation, Annual Renewal, ITIN, Banking Physical, Banking Fintech, Tax Return | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'recxlmaEyJ9Fxngdq', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('92776372-de1c-4aad-9fcc-7dcdfa02ef5d', 'Physical Banking Pricing', 'PHYSICAL BANKING PRICING

Physical banking service is appointment-based. Antonio attends the appointment/Zoom call with the client and the bank relationship manager.

KEY RULES:
- Antonio must attend the appointment (Antonio-Only action)
- Bank relationship manager coordinates the scheduling
- Required documents must be sent to client beforehand as a checklist
- Debit cards are typically mailed to CMRA address
- Cards at CMRA = paid shipping (client must pay for shipping before we ship)

PROCESS:
1. Payment confirmed
2. Contact bank RM to schedule appointment
3. Send document checklist to client
4. Attend appointment
5. Confirm account opened
6. Handle debit card shipping when received

EXCEPTIONS:
- Appointment rescheduled: Update record and set reminders
- Additional docs needed: Request from client; track until resolved', 'Pricing', NULL, NULL, '[Migrated] Applies To: Banking Physical | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'recyPDNmBqRRp2SjW', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('27f23f22-eb2b-4486-b6e3-d48bbe358c7c', 'Client/Lead Research Protocol', 'When researching a client or lead, check sources in this order:

1. SUPABASE CRM (Primary): accounts, contacts, services, payments, documents tables
2. GOOGLE DRIVE: client folder (1. Company, 2. Contacts, 3. Tax, 4. Banking, 5. Correspondence)
3. GMAIL: search support@tonydurante.us and antonio.durante@tonydurante.us
4. CIRCLEBACK/FIREFLIES: meeting transcripts and call notes
5. AIRTABLE (Backup only): historical data that may not be in Supabase yet

IMPORTANT: Supabase is the single source of truth. Always start there.
If data is missing in Supabase but found in Airtable, UPDATE Supabase with the correct data.
Never treat Airtable as primary — it is legacy backup only.

For document searches: use MCP tools doc_search, doc_list, drive_search.
For messaging history: use msg_search, msg_read_group.
For offers: use offer_list, offer_get.', 'Business Rules', NULL, NULL, '[Migrated] CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-27', 'recdmKTFWI10HSWfW', '2026-03-03T18:49:32.212304+00:00', '2026-03-09T00:29:19.781282+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('c37d3dec-9ba6-4c0f-bd97-a75ea47af9d0', 'Knowledge Base Architecture', 'TD Operations knowledge is stored in Supabase tables:

## Tables
- **knowledge_articles** (35 records) — Business rules, pricing, banking, tone guidelines. Categories: Banking, Business Rules, Pricing, Tone Guidelines, Portal.
- **approved_responses** (66 records) — Pre-approved client response templates with reasoning (notes field = Antonio Brain). Fields: title, category, service_type, language, response_text, tags, notes, usage_count.
- **system_docs** (3 records) — Operational docs by slug: milestones, system-issues-to-fix, platform-credentials.
- **compliance_requirements** (19 records) — Document requirements per entity type (SMLLC/MMLLC/C-Corp).

## MCP Tools
- kb_search, kb_get, kb_create, kb_update — CRUD knowledge articles + approved responses
- sysdoc_list, sysdoc_read, sysdoc_update — System documentation

## Access Priority
1. Supabase (kb_search) — check FIRST for approved responses
2. approved_responses.notes — reasoning behind decisions (Antonio Brain)
3. knowledge_articles — business rules, pricing, partner info
4. system_docs — milestones, credentials, known issues', 'Business Rules', NULL, NULL, '[Migrated] Updated By: Claude | Last Updated: 2026-02-06', 'recLykxtjEVX9E0J0', '2026-03-03T18:49:32.212304+00:00', '2026-03-09T00:32:57.314412+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('118e2573-15c4-4879-bf6c-e7faeab3e155', 'Portal TD Rules', 'PORTAL TD RULES — Client Portal Access

Every client receives access to the Tony Durante LLC Portal where they can:
- Issue invoices to their own clients
- Chat with support
- Access documents organized in a private area

Portal Type: Custom (web + app Android/iOS)

COMPANY FORMATION (New LLC):
Portal account created IMMEDIATELY after LLC is incorporated and company name is confirmed.

Steps:
1. Log in to Portal Admin
2. Create client''s Portal account
3. Portal automatically sends access email (password/setup/login)
4. Upload Articles of Organization to client''s private Portal area
5. When EIN/SS-4 received → upload to Portal
6. Update client dashboard progressively (company name, address, EIN)

CLIENT ONBOARDING (Existing LLC):
Portal account created ONLY AFTER key documents are complete:
- Articles of Organization (or equivalent)
- EIN number
- Onboarding packet (SS-4, passport, address)

Steps:
1. Log in to Portal Admin
2. Create client''s Portal account
3. Portal automatically sends access email
4. Upload collected company documents to Portal
5. Populate dashboard fields (company name, EIN, address)

DOCUMENT STORAGE RULE:
| System | Role | Content |
| Google Drive | Source of Truth (internal) | ALL documents, folder per client |
| Portal | Mirror (client-facing) | Key documents for client access |

Rule: Every document goes FIRST to Google Drive, then key documents are COPIED to Portal.

DOCUMENTS TO UPLOAD TO PORTAL:
- Articles of Organization
- EIN Letter / SS-4
- Tax returns (after filing)
- State renewal confirmations
- ITIN letter (when received)

OFFBOARDING/CLOSURE:
- Portal account must be DEACTIVATED when client becomes INACTIVE', 'Portal', NULL, NULL, '[Migrated] Applies To: Company Formation, Onboarding | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'rec4Axu6vl25tV9y5', '2026-03-03T18:49:32.212304+00:00', '2026-04-01T13:45:58.671608+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('6f8735ca-1f05-4dcb-9ca5-621e6b6c0ae0', 'TD Operations — MCP Architecture', 'TD Operations runs on a remote MCP server deployed on Vercel.

## MCP Server
- URL: https://td-operations.vercel.app/api/mcp
- Auth: Bearer token (TD_MCP_API_KEY)
- 76 tools across 15 tool files
- Protocol: Streamable HTTP + Legacy SSE

## Tool Groups (76 tools)
- CRM (9): accounts, contacts, payments, services, tasks, deals, client_summary, dashboard_stats
- Documents (13): process, search, list, compliance, mass_process, health
- Drive (8): search, list, get, read, upload, create_folder, move, read_file
- QuickBooks (6): customers, invoices, payments, reports, company
- Email/Gmail (8): search, read, send, reply, labels, watch, history
- DocAI + Classify (4): OCR, classify by content/filename
- Calendly (3): bookings, events, availability
- Storage (5): list, read, write, delete, move
- SQL (1): execute_sql (raw Postgres)
- Messaging (6): inbox, read_group, search, send, mark_read, channels
- Offers (4): list, get, create, update
- System Docs (3): list, read, update
- Knowledge Base (4): search, get, create, update

## Infrastructure
- Supabase (ydzipybqeebtpcvsbtvs) = SOT for all data
- Google Drive = document storage
- 6 Edge Functions: whatsapp-webhook, telegram-webhook, send-message, import-messages, whop-webhook, sync-drive
- Vercel cron: sync-drive every 6h
- GitHub: TonyDuranteSystem/td-operations', 'Business Rules', NULL, NULL, '[Migrated] CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-20', 'recEhM9tm0SS1Ltth', '2026-03-03T18:49:32.212304+00:00', '2026-03-09T00:33:08.826921+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e33e0576-70b7-4b73-bd7d-7d661795a200', 'Shipping Cost Rules', 'SHIPPING COST RULES

CORE RULE: Shipping is ALWAYS a paid service. No shipping until payment is received.

WHEN SHIPPING IS TRIGGERED:
- Mail forwarding from CMRA address
- Debit cards received at CMRA from bank
- Notarized documents to be sent to client
- Any physical item that needs to be mailed to the client

PROCESS:
1. Client requests shipping (or shipping is triggered by another service)
2. Create Shipping Service Deal linked to Account and originating service
3. Provide shipping quote to client
4. Wait for payment confirmation
5. Create shipment in ShipStation; purchase label
6. Pack and ship; record tracking number
7. Send tracking to client; store proof in Google Drive

SHIPSTATION:
- All shipments created and managed through ShipStation
- Labels purchased through ShipStation
- Tracking numbers automatically generated

EXCEPTIONS:
- If client delays payment: keep shipping record pending; store delay evidence in Notes
- No exceptions to ''no shipping until paid'' without Antonio''s approval

RELATED SERVICES:
- CMRA: Mail forwarding always triggers Shipping SOP
- Banking: Debit cards at CMRA trigger Shipping SOP
- Notary: Original documents may need shipping', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Shipping | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'recyOrfW8imwR2nru', '2026-03-03T18:49:32.212304+00:00', '2026-04-01T13:45:58.671608+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('50b108ad-a87d-4c7d-b033-f2495717eb34', 'Tony Durante LLC — Chase Bank Details', 'Bank: JPMorgan Chase
Branch: 7796 113th St, Seminole, FL 33772
Account Name: Tony Durante LLC
Account Address: 10225 Ulmerton Rd, 3D, Largo, FL 33771
Account #: 893993920
Routing #: 267084131', 'Banking', NULL, NULL, '[Migrated] Applies To: Banking Physical | CRITICAL: Yes | Updated By: Antonio | Last Updated: 2026-02-06', 'rec2R5RZBuihKbXnh', '2026-03-03T18:49:32.212304+00:00', '2026-03-03T18:49:32.212304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('2fe61888-34a2-4424-bd5f-24f5a66b7133', 'Cancellation Rules (Oct 31)', 'CANCELLATION RULES

Cancellation is only permitted under the following conditions:
1. Cancellation request must be received by October 31 of the current year
2. Both installments (January + June) must be fully paid

IF ELIGIBLE:
1. Verify eligibility (timing + payment compliance)
2. Record cancellation request evidence in account notes
3. Mark Account as INACTIVE (crm_update_record) -- excludes client from ALL workflows/emails/reminders
4. Cancel any pending invoices (portal billing or QB)
5. Close or update any open tasks with reason: Cancelled
6. Notify client of cancellation confirmation via email
7. Archive documents in Google Drive
8. Deactivate portal account

IF NOT ELIGIBLE:
- Keep Account ACTIVE
- Respond with contract terms explaining why cancellation is not possible
- Continue normal payment follow-ups
- Client remains in all automations and workflows

ANTONIO-ONLY: Eligibility verification and final approval is an Antonio decision.

NON-PAYMENT TERMINATION: Clients who fail to pay can be terminated by Antonio''s decision, following the same offboarding steps.

CANONICAL SOURCE: Master Rules (KB 370347b6), rule P8.', 'Business Rules', NULL, NULL, '[Migrated] Applies To: Offboarding | CRITICAL: Yes | Updated By: Claude | Last Updated: 2026-02-12', 'rec1uNhSxhi4mjrAb', '2026-03-03T18:49:32.212304+00:00', '2026-04-01T13:46:40.638407+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('cc09f3c1-66db-4091-a9e3-44de06b35c4e', 'Servizi Ricorrenti — Client Attivo', 'SERVIZI RICORRENTI PER CLIENT ATTIVO

Un client attivo (contratto annuale) ha SEMPRE questi 4 servizi ricorrenti:

1. State RA Renewal — rinnovo registered agent (billing: Included)
2. State Annual Report — filing annual report statale (billing: Included)
3. Tax Return — dichiarazione fiscale annuale (billing: Included)
4. CMRA — mailing address (billing: Standalone se venduto a parte, Included se nel pacchetto)

REGOLE:
- Tutti e 4 i servizi vengono creati alla data di inizio contratto
- RA Renewal, Annual Report, Tax Return = billing type "Included" (coperti dal contratto annuale)
- CMRA = "Standalone" se venduto separatamente, "Included" se nel pacchetto
- Ogni servizio ha un ciclo annuale con scadenza e rinnovo
- I servizi ricorrenti si rinnovano automaticamente a meno che il client non cancelli entro Oct 31', 'Business Rules', '["services", "recurring", "active-client", "billing"]', NULL, 'Regola fondamentale: ogni client attivo deve avere questi 4 servizi. Se mancano, è un errore da correggere. CMRA è l''unico che può essere Standalone.', NULL, '2026-03-09T14:09:44.717265+00:00', '2026-03-09T14:09:44.717265+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('8b734d91-817e-45f2-9af2-0ee5b5858d41', 'Servizi One-Time — Completamento', 'SERVIZI ONE-TIME

Questi servizi si eseguono UNA VOLTA e diventano status "Completed" al termine:

- Company Formation — creazione LLC (SOLO nuovi clienti, MAI per account con formation_date nel passato)
- EIN Application — richiesta EIN (SOLO alla formazione, MAI per account già formati)
- ITIN — richiesta ITIN proprietario
- Banking Fintech — apertura conto fintech (Relay, Payset, etc.)
- Banking Physical — apertura conto bancario fisico
- Shipping — spedizione documenti/carte
- Public Notary — notarizzazione documenti
- Client Onboarding — onboarding LLC già esistente (per clienti che portano LLC formata altrove)

REGOLE CRITICHE:
- NON creare Company Formation o EIN Application per account con formation_date nel passato
- Client Onboarding è alternativo a Company Formation (uno o l''altro, mai entrambi)
- Una volta completato, il servizio resta nel CRM come storico ma non si rinnova
- Banking Fintech e Banking Physical sono servizi distinti (un client può avere entrambi)', 'Business Rules', '["services", "one-time", "formation", "onboarding"]', NULL, 'Errore comune: creare Company Formation per account già formati. Controllare sempre formation_date. Client Onboarding = per LLC già esistenti che entrano nel sistema.', NULL, '2026-03-09T14:09:44.717265+00:00', '2026-03-09T14:09:44.717265+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('4f652b9a-23ed-4b5c-b008-7e3de3e57078', 'Entity Type vs Client Type', 'ENTITY TYPE ≠ SERVICES

The entity type (SMLLC, MMLLC, C-Corp) does NOT determine services. It only determines pricing.

What matters is the CLIENT TYPE:

CLIENT (annual contract):
- Has an annual Jan-Dec contract
- Receives the 4 recurring services (RA Renewal, Annual Report, Tax Return, CMRA)
- Pays 2 annual installments (Jan + Jun)
- account_type = "Client"

ONE-TIME CUSTOMER (single service):
- Has no annual contract
- Purchases only specific services (e.g. only Company Formation, only ITIN)
- Pays a one-time fee for the requested service
- account_type = "One-time"

PRICING PER ENTITY TYPE (only for clients with a contract):
- SMLLC: $2,000/year ($1,000 + $1,000)
- MMLLC: $2,500/year ($1,250 + $1,250)
- C-Corp: custom pricing (ask Antonio)

RULE: Never assign recurring services to a One-time customer. Never use the entity type as the criterion for deciding which services to create.', 'Business Rules', '["entity-type", "client-type", "pricing", "services"]', NULL, 'Confusione frequente: pensare che SMLLC/MMLLC determinino i servizi. NO. È il tipo di relazione (Client vs One-time) che determina se ha servizi ricorrenti. Entity type influenza solo il prezzo.', NULL, '2026-03-09T14:09:44.717265+00:00', '2026-04-06T23:48:04.077057+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('d4cce4ac-e736-4651-a5a3-c8089be9d30b', 'SOP 6: MaxScale Partner Model', 'MaxScale rivende il servizio CMRA ai propri clienti.

DETTAGLI:
- 23 companies, solo CMRA
- Nessun service delivery ticket individuale — gestiti a livello partner
- Fatturazione tramite MaxScale
- Esclusi da client gap analysis
- Campo account: is_maxscale = true

GESTIONE: Trattati come partner, non come singoli client. Fatturazione aggregata. Non inclusi nei KPI standard di client health.', 'SOP', '["maxscale", "partner", "cmra"]', '6.0', 'Sezione 6 del SOP v6.0', NULL, '2026-03-09T17:10:31.54543+00:00', '2026-03-09T17:10:31.54543+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('415ca74d-da6b-4375-b863-0edbba5be8ef', 'SOP 7: Annual Management Calendar', 'CALENDARIO CRITICO — Lo strumento operativo più importante.

SCADENZE FISSE:
- Gennaio: Emissione fattura 1st Installment (1 Gen) + Invio link dati Tax Return (dopo pagamento 1st)
- Feb-Apr: Raccolta dati e preparazione Tax Return
- 1 Marzo: Delaware Franchise Tax — CORPORATION (C Corp, S Corp)
- 15 Marzo: MMLLC Tax Return deadline originale (o extension)
- 15 Aprile: SMLLC/C Corp Tax Return deadline originale (o extension)
- 1 Maggio: Florida Annual Report due
- Giugno: Emissione fattura 2nd Installment (1 Giu) + Verifica pagamento prima di preparazione TR
- 1 Giugno: Delaware Franchise Tax — LLC SINGLE MEMBER
- 15 Giugno: ITIN renewal deadline (se applicabile, ogni 3 anni)
- 15 Settembre: Tax Return extended deadline — solo MMLLC
- 15 Ottobre: Tax Return extended deadline — SMLLC e C Corp

SCADENZE VARIABILI:
- RA Renewal: anniversario di incorporazione (ra_renewal_date)
- CMRA contract renewal: cmra_expiry_date
- Wyoming Annual Report: anniversario

DELAWARE FRANCHISE TAX PER ENTITY TYPE:
- Corporations (C Corp, S Corp elected): filing entro 1 Marzo
- LLCs (Single Member): filing entro 1 Giugno
- Multi-Member LLCs: seguono schedule Corporation (1 Marzo)
- LLC flat fee: $300
- Corporation tax: calcolata per authorized shares o assumed par value method
- Controllare campo company_type dell''Account per determinare data corretta

MULTI-STATE: Il calendario è per Account (company), non per Contact (persona). Un client con LLC in più stati ha entry separate per Account.', 'SOP', '["calendar", "deadlines", "tax-return", "delaware", "annual-report", "ra-renewal"]', '6.0', 'Sezione 7 del SOP v6.0. Calendario operativo annuale.', NULL, '2026-03-09T17:10:31.54543+00:00', '2026-03-09T17:10:31.54543+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('a12c51f5-cbc9-4004-9c8b-22fae9c4a6a9', 'SOP 4: Payment Model', 'PRICING AUTHORITY: NON esistono prezzi fissi. Antonio determina il pricing per ogni client durante la consultation. L''offerta web (offerte.tonydurante.us) è la SINGLE SOURCE OF TRUTH per il pricing concordato.

STRUTTURA PAGAMENTO:
- Setup Fee: una tantum, copre formation + servizi iniziali. Dovuto prima del filing.
- 1st Installment: prima metà della management fee annuale. Scadenza 1 Gennaio.
- 2nd Installment: seconda metà della management fee annuale. Scadenza 1 Giugno.

REGOLE PRIMO ANNO:
- Formation Gennaio-Agosto → 1st Installment a Gennaio anno SUCCESSIVO, 2nd a Giugno anno SUCCESSIVO
- Formation Settembre-Dicembre → SALTA Gennaio (troppo vicino), primo pagamento a Giugno anno SUCCESSIVO

Nel gap tra formation e primo installment, il revenue è coperto dalla setup fee.

INVOICING: Tutto tramite QuickBooks (Realm ID: 13845050572680403).

FOLLOW-UP PAGAMENTI: Giorno 15 reminder → Giorno 30 secondo reminder → Giorno 45 escalation ad Antonio. Nessuna late fee automatica. Antonio decide per ogni client.

SUPPORT ELIGIBILITY: Prima di rispondere a richieste non-urgenti, verificare se il client ha pagato il 1st installment dell''anno corrente. Soglia: 30+ giorni dalla data fattura. Se non pagato: ricordare gentilmente prima di fornire supporto. Emergenze compliance (IRS, scadenze statali) ESENTI.

BLOCKED / ON HOLD: È una PROPERTY (boolean), NON uno stage. Può essere impostato su qualsiasi service delivery a qualsiasi stage. Quando attivo: SLA in pausa. Registrare motivo e data risoluzione prevista.', 'SOP', '["payment", "pricing", "quickbooks", "invoicing", "follow-up"]', '6.0', 'Sezione 4 del SOP v6.0. QuickBooks = invoicing.', NULL, '2026-03-09T17:10:31.54543+00:00', '2026-03-09T17:10:31.54543+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('84bf8bfe-131f-48c8-8912-33a581b14515', 'SOP 2: Deal vs Service Delivery', 'CRITICAL RULE: A Deal is NOT a service. A Deal represents a SALE. Service Delivery tickets represent the EXECUTION of purchased services.

A Deal = commercial relationship: what was sold, how much, payment status. All Deals in a single Sales Pipeline.
A Service Delivery = execution of a specific service, with a dedicated pipeline and specific stages.

Example: Client purchases Formation + Tax Return + CMRA → 1 Deal + 3 Service Delivery tickets.

AUTOMATION (LIVE): When a Deal moves to "Closed Won", Service Delivery tickets are automatically created based on the deal''s service_type field. Mapping defined in pipeline/actions.ts (SERVICE_MAP). Duplicate services for the same account are skipped.

SALES PIPELINE STAGES:
- Initial Consultation (10%) — Prospect had Calendly call
- Offer Sent (30%) — Offer link sent via offerte.tonydurante.us
- Negotiation (60%) — Prospect is discussing terms
- Agreement Signed (90%) — Client accepted, payment terms confirmed
- Paid (95%) — Payment received, awaiting service start
- Closed Won (100%) — Deal complete, service tickets created automatically
- Closed Lost (0%) — Declined or unresponsive, reason recorded

AUTOMATION NOTES:
- Moving to "Paid" → automatically sets payment_status = Paid
- Moving to "Closed Won" → sets close_date + creates service tickets', 'SOP', '["deal", "pipeline", "service-delivery", "automation"]', '6.0', 'Sezione 2 del SOP v6.0. Automazione Closed Won → service tickets è LIVE.', NULL, '2026-03-09T17:10:31.54543+00:00', '2026-04-06T23:49:11.545175+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e193d5cc-59a7-45e9-99cc-07dd9d154b0a', 'SOP 3: Service Classification', '6 CATEGORIE DI SERVIZI:

1. RECURRING (ANNUAL): Tax Return, RA Renewal, State Annual Report, CMRA
   Billing: Inclusi nella management fee annuale

2. ONE-TIME (SETUP): Company Formation, EIN Application, Client Onboarding, Banking Fintech, Banking Physical
   Billing: Setup fee una tantum

3. ONE-TIME WITH RENEWAL: ITIN (rinnovo ogni 3 anni)
   Billing: Fee una tantum, rinnovo tracciato

4. ONE-TIME (EXIT): Company Closure, Client Offboarding
   Billing: Fee determinata per caso

5. AD-HOC POST-PAY: Public Notary, Shipping
   Billing: Fatturato per occorrenza dopo il servizio

6. INTERNAL: Support
   Billing: Non fatturabile', 'SOP', '["service-classification", "billing", "servizi"]', '6.0', 'Sezione 3 del SOP v6.0', NULL, '2026-03-09T17:10:31.54543+00:00', '2026-03-09T17:10:31.54543+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('ce64a110-e19c-4b0a-8000-effb39ef2fa0', 'SOP 1: Business Model', 'Tony Durante LLC — US business consulting practice. Specializzazione: LLC formation e ongoing management per imprenditori internazionali (principalmente italofoni).

CLIENT LIFECYCLE: Lead → Consultation → Offer → Acceptance → Deal → Formation → CLIENT → Annual Management

REVENUE MODEL: Due stream:
1. One-time formation/setup fees (quotati in EUR)
2. Recurring annual management fees (in USD), raccolti in due rate (Gennaio e Giugno).', 'SOP', '["business-model", "lifecycle", "revenue"]', '6.0', 'Sezione 1 del SOP v6.0', NULL, '2026-03-09T17:10:31.54543+00:00', '2026-03-09T17:10:31.54543+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('703ea8c0-e0ce-44d2-8b0e-bbb3ffe07f77', 'SOP 5: Service Delivery Pipelines (15)', '15 pipeline di service delivery. Ognuna corrisponde a un service_type. Le definizioni degli stage sono nella tabella sop_runbooks su Supabase.

1. Company Formation: Payment Confirmed → Filing Submitted → State Processing → Formation Approved → Documents Delivered
2. Client Onboarding: Welcome Email → Folder Created → Portal Access → Onboarding Complete
3. Tax Return Filing: Data Link Sent → Data Received → Preparation → Client Review → Extension Filed → TR Filed
4. RA Renewal: Renewal Due → Submitted → Confirmed
5. State Annual Report: Report Due → Filed → Confirmation Received
6. EIN Application: Application Submitted → IRS Processing → EIN Received
7. CMRA: Contract Initiated → USPS 1583 Submitted → Contract Active → Renewal
8. ITIN Application: Documents Collected → CAA Certification → Application Submitted → IRS Processing → ITIN Received
9. Banking Fintech: Application Submitted → Verification → Account Active
10. Banking Physical: Appointment Scheduled → Documents Prepared → Appointment Completed → Account Active
11. Shipping: Package Received → Forwarded → Delivered
12. Public Notary: Request Received → Notarized → Shipped
13. Company Closure: Closure Requested → State Filing → IRS Notification → Closure Complete
14. Client Offboarding: Exit Interview → Documents Transferred → Access Revoked → Complete
15. Support: Request Received → In Progress → Resolved

NOTA: Annual Renewal (#16 nella v5.0) è stato ELIMINATO. Era legacy, service_type non nell''enum, zero record.', 'SOP', '["pipelines", "service-delivery", "stages", "runbooks"]', '6.0', 'Sezione 5 del SOP v6.0. 15 pipeline (Annual Renewal rimosso).', NULL, '2026-03-09T17:10:31.54543+00:00', '2026-03-09T17:10:31.54543+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('925b910e-6434-4258-a099-6ff821602594', 'SOP 14: Team Roles RACI', 'R=Responsible, A=Accountable, C=Consulted, I=Informed

CLAUDE = OPERATOR (76+ tools). Responsabile per esecuzione task operativi, manutenzione sistemi, integrità dati, automazione processi. Report ad Antonio per approvazione su decisioni client-facing.

MATRICE RACI:
- Lead conversation/qualification: Antonio=R, Luca=I, Claude=C
- Offer content creation: Antonio=A, Claude=R
- Offer technical insertion (Supabase): Antonio=I, Claude=R
- Offer delivery to prospect: Antonio=A, Luca=R, Claude=R
- Offer follow-up/view tracking: Antonio=A, Luca=R, Claude=R
- Offer modification (new offer): Antonio=A, Luca=I, Claude=R
- Pricing decisions/discounts: SOLO ANTONIO (R)
- Payment verification: Antonio=A, Luca=R, Claude=R
- Payment record creation (QuickBooks): Antonio=A, Luca=R, Claude=R
- Invoice creation (QuickBooks): Antonio=A, Claude=R
- Service Delivery ticket creation (Closed Won): Antonio=I, Luca=I, Claude=R (Automatico)
- Company Formation execution: Antonio=A, Luca=R, Claude=C
- Tax Return preparation: Antonio=A, India=R
- RA/AR/CMRA renewals: Antonio=A, Luca=R, Claude=R
- Client communication (strategic): SOLO ANTONIO (R)
- Client communication (operational): Antonio=A, Luca=R, Claude=R
- System updates (Supabase+HubSpot): Antonio=I, Luca=R, Claude=R
- CAA certification (ITIN): SOLO ANTONIO (R)
- Annual client review: Antonio=R, Luca=C, Claude=C
- QC Gate verification: Antonio=A (spot checks), Luca=R, Claude=R
- Client Health monitoring: Antonio=R, Luca=R, Claude=R
- SLA monitoring (daily report): Antonio=I, Luca=I, Claude=R
- Document processing (Drive): Antonio=I, Luca=R, Claude=R
- HubSpot sync: Antonio=I, Claude=R
- Email sending (operational): Antonio=A, Luca=R, Claude=R
- Payment follow-up: Antonio=A, Luca=R, Claude=R', 'SOP', '["raci", "team", "roles", "claude-operator"]', '6.0', 'Sezione 14 del SOP v6.0. Claude = Operator con R espanse.', NULL, '2026-03-09T17:11:55.309882+00:00', '2026-03-09T17:11:55.309882+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('544f6912-b004-494a-ba2b-760d4e69a138', 'SOP 13: Source of Truth Architecture', 'CURRENT ARCHITECTURE:
Supabase = PRIMARY SOT. All new records written to Supabase.
Admin Dashboard on Vercel for daily operations.
HubSpot = CRM frontend for pipeline and reporting.
Airtable = read-only archive/backup.

DATA FLOW RULES:
- All new records written to Supabase (via Dashboard or API/MCP)
- Sync service pushes changes to HubSpot (Edge Functions or scheduled sync)
- Airtable = read-only archive, no new writes
- HubSpot = read-mostly, updated via sync
- Conflicts: Supabase ALWAYS wins

TECHNOLOGY STACK:
- Primary Database: Supabase (PostgreSQL) — ACTIVE, SOT
- Custom Frontend: Vercel (Next.js) — td-offers live, Dashboard live
- CRM Frontend: HubSpot (paid plan) — Active
- Team Workspace: Airtable — Read-only archive
- Cloud Storage: Google Drive — Active
- Invoicing: Portal Billing (primary), QuickBooks (accounting sync)
- Sync Engine: Supabase Edge Functions + API routes — Partially built
- Lead Collection: Calendly — Active
- Call Recording: Circleback (primary) + Fireflies (backup) — Active
- Inbox: Gmail API + WhatsApp + Telegram (via Supabase) — Active

RULE: No external automation tools (Make.com, Zapier, n8n). Everything built with Supabase Edge Functions or Next.js API routes.', 'SOP', '["architecture", "supabase", "hubspot", "technology-stack", "sot"]', '6.0', 'Sezione 13 del SOP v6.0. Supabase = SOT primario.', NULL, '2026-03-09T17:11:55.309882+00:00', '2026-04-06T23:48:59.748966+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('2f256112-3af1-4a42-9f76-88dd4509b20e', 'SOP 8: Proactive Client Communication', 'STATUS: ROADMAP — Da implementare con template e trigger automatici.

PRE-CLIENT (LEAD) FLOW:
- Calendly booking → Auto confirmation (Email Calendly)
- 24h prima della call → Reminder + agenda (Email/WhatsApp, Claude → Antonio approva)
- Dopo consultation → Thank you + recap (WhatsApp, Antonio)
- Offerta inviata (entro 2 giorni) → Link offerta + messaggio (WhatsApp + Email, Luca → Antonio approva)
- 3-5 giorni dopo offerta → Follow-up se non vista (WhatsApp, Luca)
- 5+ giorni dopo vista, no risposta → Secondo follow-up (WhatsApp/Email, Antonio)
- Offerta accettata → Welcome + next steps (Email + WhatsApp, Luca → Antonio approva)

10 TOUCHPOINT ANNUALI CLIENT ATTIVO:
1. Gennaio — Piano annuale + fattura 1st installment (Email)
2. Dopo 1st pagamento — Richiesta dati tax (Email + WhatsApp)
3. Tax extension depositata — Conferma con nuova deadline (Email)
4. RA rinnovato — Conferma (WhatsApp)
5. Annual Report depositato — Conferma + allegato (Email)
6. Giugno — Fattura 2nd installment (Email)
7. Dopo 2nd pagamento — Conferma inizio preparazione tax (WhatsApp)
8. Tax Return depositato — Conferma + copia (Email)
9. CMRA rinnovato — Conferma (WhatsApp)
10. Dicembre — Summary annuale (Email)

Template per ogni touchpoint nella tabella templates. Trigger basati su stage servizi o date calendario.', 'SOP', '["communication", "touchpoints", "templates", "roadmap"]', '6.0', 'Sezione 8 del SOP v6.0. STATUS: ROADMAP.', NULL, '2026-03-09T17:11:55.309882+00:00', '2026-03-09T17:11:55.309882+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('b3afd1ed-9418-481f-a1ac-8b2633b8d098', 'SOP 9: Client Health Monitoring', 'STATUS: IMPLEMENTATO — Funzioni SQL calculate_client_health() e update_client_health() live su Supabase.

LIVELLO 1: Campo rapido su Account
Campo: client_health (Green / Yellow / Red) — aggiornato automaticamente.

LIVELLO 2: Health score mensile (tabella client_health_scores)
Componenti: payment_health, compliance_health, communication_health → overall_health

LOGICA CALCOLO:
GREEN: Tutti i pagamenti correnti AND tutte le scadenze in track AND ultimo contatto entro 60 giorni.
YELLOW: Pagamento scaduto <30 giorni OR scadenza entro 15 giorni e non completata OR ultimo contatto 60-90 giorni.
RED: Pagamento scaduto 30+ giorni OR scadenza passata OR nessun contatto 90+ giorni OR client ha richiesto documenti (potenziale churn).

SEGNALI DI RISCHIO:
- Pagamento in ritardo (qualsiasi installment) → 15+ giorni → Chiamata personale da Antonio
- Non responsivo a richieste dati → 30+ giorni → WhatsApp + email + offerta chiamata
- Nessun acquisto aggiuntivo → 2+ anni → Review annuale, chiedere necessità
- Client chiede documenti → Qualsiasi richiesta di copie complete → Antonio chiama per capire
- Reclamo o disputa → Qualsiasi reclamo → Antonio risponde entro 24h', 'SOP', '["client-health", "monitoring", "risk", "implemented"]', '6.0', 'Sezione 9 del SOP v6.0. IMPLEMENTATO con funzioni SQL.', NULL, '2026-03-09T17:11:55.309882+00:00', '2026-03-09T17:11:55.309882+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('da92f13a-23f7-48e0-b3fb-0933a5ec4fb5', 'SOP 10: Service Level Agreements', 'STATUS: ATTIVO — Views v_sla_monitor e v_sla_summary live su Supabase.

SLA TRACKING:
Ogni Service Delivery ha: stage_entered_at (ingresso nello stage corrente) e sla_due_date (scadenza SLA).
SLA si ferma quando blocked_waiting_external = true.
Monitoraggio: report giornaliero automatico — ticket vicini a scadenza (entro 2 giorni) e violazioni.

SLA PER SERVIZIO:
- Tax data link inviato: 3 giorni dopo 1st installment (target: stesso giorno). Escalation: 5+ giorni → Antonio verifica.
- Tax extension MMLLC: Entro 15 Marzo (target: 10 Marzo). Verifica: 8 Marzo.
- Tax extension SMLLC/Corp: Entro 15 Aprile (target: 10 Aprile). Verifica: 8 Aprile.
- Tax preparation: 3 settimane dopo 2nd installment + dati (target: 15 giorni lavorativi). Ritardo → alert team India.
- RA Renewal: Prima della scadenza (target: 30 giorni prima). NON-POSTPONABILE: rinnovare anche se pagamento pending.
- Annual Report: Prima della deadline statale (target: 30 giorni prima). 15 giorni: verificare filing.
- CMRA Renewal: Prima della scadenza contratto (60gg notifica, 30gg rinnovo). Non responsivo → rinnovare comunque.
- Link offerta inviato: 2 giorni lavorativi dopo call (target: stesso giorno). 3+ giorni → Antonio verifica.
- Follow-up offerta: 5 giorni lavorativi se non vista (Day 3 check, Day 5 follow-up). 10 giorni no vista → Antonio decide.
- Filing Company Formation: 3 giorni lavorativi dopo pagamento (target: stesso giorno). Ritardi statali → notificare client.
- Support first response: 4 ore lavorative (target: immediato). Non risolto 48h → Antonio.', 'SOP', '["sla", "deadlines", "monitoring", "active"]', '6.0', 'Sezione 10 del SOP v6.0. ATTIVO con views SQL.', NULL, '2026-03-09T17:11:55.309882+00:00', '2026-03-09T17:11:55.309882+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('aece00c8-4eab-4ab5-b04c-e7412666319a', 'SOP 11: Escalation Framework', 'STATUS: ROADMAP — Da implementare con alert automatici.

DUE TIPI DI ESCALATION:

1. OPERATIVA (14 giorni): Client non risponde a una specifica richiesta di servizio attivo (es. dati tax). Luca ha provato 3 volte → escalation ad Antonio per chiamata personale.

2. HEALTH SIGNAL (30 giorni): Client generalmente disengaged — non risponde a nessuna comunicazione. Flag client_health a Yellow, schedulare outreach personale.

MATRICE ESCALATION:
- Client non responsivo 14+ giorni → Luca: follow-up multi-canale → Antonio dopo 3 tentativi → Chiamata personale
- Pagamento scaduto 30+ giorni → Cadenza standard → Sempre al Giorno 30 → Late fee / piano pagamento / relationship call
- Ritardo governativo → Documentare, impostare reminder → Se supera atteso del 50% → Intervento diretto
- Servizio bloccato 5+ giorni → Identificare blocker → Se serve azione esterna → Review e sblocco
- Reclamo client → Log in pipeline Support → Sempre → Risposta personale entro 24h
- Conflitto dati tra sistemi → Flag e documentare → Se dati client-facing impattati → Decidere valore autoritativo', 'SOP', '["escalation", "roadmap", "risk-management"]', '6.0', 'Sezione 11 del SOP v6.0. STATUS: ROADMAP.', NULL, '2026-03-09T17:11:55.309882+00:00', '2026-03-09T17:11:55.309882+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('8de61bec-2162-468b-8a61-a04671e4c0dc', 'SOP 12: Quality Control Gate', 'STATUS: ROADMAP — Table qc_gates and enforcement to be built.

RULE: Before closing ANY Service Delivery, the QC checklist for that service type must be completed.

PROCESS:
1. Each service_type has a QC template in the qc_gates table with service-specific items
2. Team member completes all checklist items
3. When all items pass → qc_verified = true on the Service Delivery
4. The ticket CANNOT move to Completed until qc_verified = true

UNIVERSAL QC ITEMS (all services):
- Filing/service confirmation received?
- Document saved to Drive?
- Client notified of completion?
- Supabase record updated?
- HubSpot ticket updated?

SERVICE-SPECIFIC QC ITEMS:
- Tax Returns: signed copy from client? Filed copy in Drive?
- Formation: EIN received? Portal set up? All docs in Drive?', 'SOP', '["qc", "quality-control", "checklist", "roadmap"]', '6.0', 'Sezione 12 del SOP v6.0. STATUS: ROADMAP.', NULL, '2026-03-09T17:11:55.309882+00:00', '2026-04-06T23:48:48.244647+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('6a72cb77-5da7-4670-b807-6aa1093587bd', 'SOP 15: KPIs', 'STATUS: ROADMAP — Dashboard da costruire.

10 KPI OPERATIVI:
1. Client Retention Rate: Target >90%, Review annuale
2. Annual Cycle Completion: Target 100%, Review trimestrale
3. Collection Rate (on-time): Target >85%, Review mensile
4. Service Delivery Time: Target entro SLA, Review mensile
5. Client Health (% Green): Target >80%, Review mensile
6. Support Response Time: Target <4 ore, Review settimanale
7. Zero-Defect Rate: Target >98%, Review mensile
8. Offer Conversion Rate: Track trend, Review mensile
9. Offer Response Time: Target <2 giorni, Review mensile
10. Offer View Rate: Target >90%, Review mensile', 'SOP', '["kpi", "metrics", "dashboard", "roadmap"]', '6.0', 'Sezione 15 del SOP v6.0. STATUS: ROADMAP.', NULL, '2026-03-09T17:12:32.761922+00:00', '2026-03-09T17:12:32.761922+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e4134096-e9ba-467b-b96a-c4ff7d6b80a0', 'SOP 19: Offer System Workflow', 'WORKFLOW SEMI-AUTOMATICO IN 8 STEP. Ogni offerta richiede approvazione ESPLICITA di Antonio.

1. Prospect prenota via Calendly → Lead data catturati → Lead creato su Supabase
2. Antonio fa call Zoom → Circleback/Fireflies registrano
3. Antonio dice a Claude: "Crea offerta per [nome]" → Claude estrae note call + lead data
4. Claude genera contenuto offerta (criticità, servizi, costi, etc.)
5. Claude presenta per approvazione → Antonio rivede, modifica, approva
6. Claude inserisce in Supabase (tabella offers), token generato, link creato
7. Claude aggiorna Lead su Supabase (Offer Link, Status=Sent, Date) + crea task per Luca
8. Luca consegna link via WhatsApp/email con messaggio approvato da Antonio

MODIFICA OFFERTA:
- Nuova offerta creata con nuovo token (formato: client-name-year-v2)
- Offerta precedente mantenuta in Supabase per storico
- Lead aggiornato con nuovo link

CICLO VITA OFFERTA: Draft → Sent → Viewed → Accepted / Expired
View tracking automatico al caricamento pagina.', 'SOP', '["offers", "workflow", "supabase", "semi-automatic"]', '6.0', 'Sezione 19 del SOP v6.0. Lead management su Supabase.', NULL, '2026-03-09T17:12:32.761922+00:00', '2026-03-09T17:12:32.761922+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('edb8eb45-ce30-4ba8-a589-fce917245db9', 'SOP 18: Business Continuity', 'SE ANTONIO NON DISPONIBILE:

CONTINUANO SENZA APPROVAZIONE:
- Luca ha admin access
- Servizi non-postponabili (RA, AR) continuano senza approvazione

IN PAUSA CON NOTIFICA CLIENT:
- Tutti gli altri servizi
- Notificare i client dell''interruzione

BLOCCATI:
- CAA certification (ITIN notarization) — solo Antonio
- Pricing decisions
- Offer generation
- Luca consegna SOLO offerte già approvate', 'SOP', '["business-continuity", "emergency", "contingency"]', '6.0', 'Sezione 18 del SOP v6.0', NULL, '2026-03-09T17:12:32.761922+00:00', '2026-03-09T17:12:32.761922+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('7f7a2086-d92d-4711-a839-b86c825f4179', 'SOP 17: Data Privacy', 'ACCESSO:
- Antonio: full access
- Luca: operational access
- India team: solo dati tax
- Documenti sensibili SOLO su Drive — mai in email/WhatsApp
- Cartelle client: solo team autorizzato

RETENTION:
- Client attivi: tutti i documenti mantenuti
- Offboarded: archivio, mantenere 7 anni (statuto IRS), poi eliminare

SICUREZZA OFFERTE:
- URL con token, nessuna auth richiesta (by design)
- Protezione copia/stampa attiva
- View tracking usa service role key client-side (trade-off accettato)

BREACH:
- Notificare client impattati entro 72 ore', 'SOP', '["privacy", "security", "retention", "compliance"]', '6.0', 'Sezione 17 del SOP v6.0', NULL, '2026-03-09T17:12:32.761922+00:00', '2026-03-09T17:12:32.761922+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('3ca525ba-5397-40ca-8f12-e311ef4fb1b1', 'SOP 16: Annual Client Review (December)', 'STATUS: ROADMAP — Generazione automatica summary da costruire.

PROCESSO ANNUALE (Dicembre):
Per ogni client attivo:
1. Preparare summary di una pagina: servizi completati, prossimi, item aperti
2. Schedulare 15-min call O inviare messaggio personalizzato
3. Domande: soddisfatto? Servizi aggiuntivi? Cambiamenti business?
4. Aggiornare client_health
5. Menzionare: rinnovi ITIN, necessità banking, cambiamenti company', 'SOP', '["annual-review", "december", "client-retention", "roadmap"]', '6.0', 'Sezione 16 del SOP v6.0. STATUS: ROADMAP.', NULL, '2026-03-09T17:12:32.761922+00:00', '2026-03-09T17:12:32.761922+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('422bc2c3-46d3-4e7b-8367-c6c4df1a2959', 'OAuth 2.1 — Infrastruttura Autenticazione MCP', '# OAuth 2.1 — Autenticazione MCP Server per Claude.ai

## Problema Risolto
Claude.ai non supporta Bearer token per custom connectors. Solo OAuth 2.1 o authless.
Serviva un modo per collegare Claude.ai ai 76 tool MCP senza connettori esterni.

## Soluzione
OAuth 2.1 completo con PKCE, implementato internamente (Vercel + Supabase). Bearer token resta attivo per Claude Code.

## Architettura

### Endpoints
| Endpoint | Metodo | Funzione |
|----------|--------|----------|
| /.well-known/oauth-authorization-server | GET | RFC 8414 — metadata discovery |
| /oauth/register | POST | RFC 7591 — Dynamic Client Registration (DCR) |
| /oauth/authorize | GET | Mostra pagina login (dark theme) |
| /oauth/authorize | POST | Processa login → genera auth code → redirect |
| /oauth/token | POST | Scambia code → access + refresh token |

### Tabelle Supabase
| Tabella | Scopo |
|---------|-------|
| oauth_clients | Client registrati via DCR |
| oauth_codes | Authorization code temporanei (TTL 10 min) |
| oauth_tokens | Access token (7gg) + refresh token (90gg) |
| oauth_users | Utenti autorizzati (email + PIN hash SHA-256) |

### Flusso Completo
1. Claude.ai chiama /.well-known → scopre endpoints
2. Claude.ai chiama /oauth/register → ottiene client_id + client_secret
3. Redirect utente a /oauth/authorize → pagina login
4. Utente inserisce email + PIN → auth code generato → redirect
5. Claude.ai scambia code per access_token + refresh_token
6. 76 tool MCP disponibili nella chat
7. Refresh automatico alla scadenza

### Auth Middleware Duale (app/api/[transport]/route.ts)
1. Bearer statico (TD_MCP_API_KEY) → Claude Code
2. OAuth access token → Claude.ai

### Sicurezza
- PKCE S256, PIN hashati SHA-256, token rotation
- Access TTL 7gg, Refresh TTL 90gg
- Middleware esclude .well-known e /oauth da Supabase auth

### Utenti
- antonio.durante@tonydurante.us (admin)
- support@tonydurante.us (operator)

### File Codebase
lib/oauth.ts, app/.well-known/*, app/oauth/authorize|register|token/route.ts, middleware.ts

### Commit: 4a16c13, 29e903c', 'infrastructure', '["oauth", "mcp", "claude-ai", "authentication", "security"]', '1.0', NULL, NULL, '2026-03-09T18:20:13.013147+00:00', '2026-03-09T18:20:13.013147+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('0ef379bb-308d-4eb3-bf10-1965afb4d6dc', 'Task Display Format — Visual Tables', '## Task Display Format

When asked "dammi le task" / "give me tasks" / "task update": respond with visual tables in chat. Never create files.

### 🔴 URGENT — DO TODAY

| # | Company / Client | Action | Assigned To | Due Date | Priority |
|---|-----------------|--------|-------------|----------|----------|
| 1 | [Company] | [What to do] | [Who] | [Date] | 🔴 |

### 🔄 IN PROGRESS — WAITING

| # | Company / Client | Status | Waiting For | Since |
|---|-----------------|--------|-------------|-------|
| 6 | [Company] | [What we did] | [What we''re waiting for] | [Date] |

### 🔵 NORMAL

| # | Company / Client | Status | Next Step |
|---|-----------------|--------|-----------|
| 15 | [Company] | [Current state] | [Next action] |

## Rules
- Use task_tracker tool to get data, then format as above
- Group tasks by priority section
- Sequential numbering across all sections
- Show company name, not account ID
- Dates in DD/MM format
- If no tasks in a section, omit that section entirely', 'Tone Guidelines', NULL, NULL, NULL, NULL, '2026-03-10T12:23:47.854573+00:00', '2026-03-10T12:23:47.854573+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('da2b85fe-85d7-4059-9dec-3b567adb1e6b', 'Bank Details — Tony Durante LLC', '## USD Account — Relay Financial (Thread Bank)
- **Beneficiary**: TONY DURANTE L.L.C.
- **Routing Number**: 064209588
- **Account Number**: 200000306770
- **Beneficiary Address**: 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771
- **Use for**: US domestic wire, ACH, QuickBooks invoices in USD

## EUR Account — Airwallex (via Banking Circle S.A.)
- **Beneficiary**: TONY DURANTE L.L.C.
- **IBAN**: DK8989000023658198
- **BIC/SWIFT**: SXPYDKKK
- **Bank Name**: Banking Circle S.A.
- **Bank Address**: Amerika Plads, 38, Copenhagen, Denmark, 2100
- **Beneficiary Address**: 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771
- **Account Location**: Denmark (Europe)
- **Use for**: EUR payments from European clients, offers with payment_type=bank_transfer

## QuickBooks Invoice Memo (USD)
Standard customer_memo text for USD invoices:
```
Payment by wire transfer:
Beneficiary: TONY DURANTE L.L.C.
Bank: Relay Financial (Thread Bank)
Routing: 064209588 | Account: 200000306770
Reference: [INVOICE NUMBER]
```

## QuickBooks Invoice Memo (EUR)
Standard customer_memo text for EUR invoices:
```
Payment by bank transfer:
Beneficiary: TONY DURANTE L.L.C.
IBAN: DK8989000023658198
BIC: SXPYDKKK
Bank: Banking Circle S.A.
Reference: [INVOICE NUMBER]
```

CANONICAL SOURCE: Master Rules (KB 370347b6), rule B5. If this document conflicts with Master Rules, Master Rules wins.', 'Banking', NULL, NULL, NULL, NULL, '2026-03-10T17:10:05.39613+00:00', '2026-04-01T13:23:33.003054+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('500ada85-1966-4c46-9294-271307afa371', 'Offer/Contract/Checkout Flow — Technical Reference', '## Offer → Contract → Checkout Flow (updated April 2026)

### Pages
1. **Offer page** (`/offer/[token]`) — Shows proposal with payment INFO only (no buttons). CTA: "Accept & Sign Contract"
2. **Contract page** (`/offer/[token]/contract`) — Renders one or more contracts based on per-service contract_type:
   - **Main contract** (formation or onboarding MSA + SOW) — for services matching the offer''s contract_type
   - **Addon agreements** (standalone service agreements) — for services with a different contract_type (e.g., ITIN on a formation offer, Tax Return on an onboarding offer)
   - Client must **sign ALL contracts** before checkout becomes available
3. **Post-sign checkout** — Appears after ALL signatures collected. Two choice buttons: Card or Bank Transfer
4. **Preview params**: `?preview=1` bypasses email gate on offer page. `?checkout=1` on contract page shows checkout directly.

### Multi-Contract Signing (commit 1ca20f0)

Each service in the offer carries a `contract_type` field (from SERVICE_CATALOG via CRM dialog):
- Services with `contract_type` matching the offer''s main type → included in the main MSA + SOW
- Services with a different `contract_type` (e.g., `itin` on a `formation` offer) → rendered as separate standalone agreements below the main contract
- Each contract has its own signature canvas
- **Setup fee** only counts services belonging to the main contract
- Even free/included services (e.g., Tax Return at $0) require their own standalone agreement signed

### Client Portal Section in SOW

The SOW now includes a **Client Portal** section describing:
- LLC Management tools (documents, service tracking, signing, deadlines, tax docs)
- Business Tools (invoicing, client management, payments, service requests)
- Communication requirement (portal chat required, replaces WhatsApp/Telegram)
- Mobile App installation instructions (PWA)

### Payment Gateway + Bank Selection (commit 978d730)

The CRM offer dialog now includes:
- **Payment Gateway**: Stripe (default, deferred checkout at signing) or Whop (plan created at offer creation)
- **Bank Account**: Auto (default), Relay, Mercury, Revolut, Airwallex — centralized in bank-defaults.ts via `getBankDetailsByPreference()`

### Dynamic Behavior (driven by offer data)
- `payment_links[]` → Card payment option. Each item has `url` (Whop), `label`, `amount` (includes +5% surcharge)
- `bank_details{}` → Bank transfer option. Fields: `beneficiary`, `account_number`, `routing_number`, `iban`, `bic`, `bank_name`, `amount` (base price), `reference`
- `services[]` with `recommended: true` → Determines Annual Service Fee and LLC Type in contract
- `cost_summary[]` with "Recommended" in label → Overrides fee in contract if present
- `services[].contract_type` → Determines which contract each service belongs to

### Checkout Scenarios
- Both `payment_links` + `bank_details` → Card (+5% badge) OR Bank Transfer choice
- Only `payment_links` → Card button only
- Only `bank_details` → Bank details + receipt upload only
- Neither → Generic "contact us" message

### Contract getContractData() Logic
1. Filter services to only those matching the main contract_type
2. Find service with `recommended: true`, get its `price` as fee
3. Find cost_summary with "recommended" in label, override fee with its `total`
4. Payment Schedule = "Single payment of {fee}" (uses base fee, NOT card surcharge)
5. LLC Type = first service name containing "llc"

### Post-Sign Flow
- ALL contracts must be signed before checkout appears
- Card button → opens payment URL in new tab
- Bank button → reveals bank details panel + wire receipt upload
- Receipt uploads to Supabase Storage `wire-receipts/{token}/` and updates `contracts.wire_receipt_path`

### Files
- `app/offer/[token]/page.tsx` — Offer page
- `app/offer/[token]/contract/page.tsx` — Multi-contract rendering + checkout
- `app/offer/[token]/contract/service-agreement.tsx` — Main MSA+SOW (formation/onboarding)
- `app/offer/[token]/contract/standalone-service-agreement.tsx` — Addon agreements (ITIN, Tax Return, etc.)

### DO NOT MODIFY without understanding the full flow:
- `getContractData()` function — determines contract terms from offer data (now filters by main contract_type)
- Multi-signature canvas management
- Post-sign payment choice HTML generation in `signContract()`
- `CheckoutPreview` component — React version of post-sign checkout for ?checkout=1 preview
- Email gate bypass logic (`isPreview` check)

### Test Offer
Token: `test-preview-2026` — Use for previewing changes. Reset to `status: sent` after testing.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-10T18:22:21.825611+00:00', '2026-04-04T18:16:23.120739+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('96a0b042-1cd9-4cf0-8fc8-6655ab05e5f1', 'Whop API - Payment Check via curl', '## Whop Payment Check

API key in sysdoc ''platform-credentials''. NEVER use browser — always use API via curl.

### Check payments:
```
curl -s -H "Authorization: Bearer {WHOP_API_KEY}" "https://api.whop.com/api/v5/company/payments?per=50"
```

### Key fields in response:
- status: paid/refunded/failed
- final_amount, currency
- user_email, card_last_4, card_brand
- billing_address (name, line1, city, state, postal_code, country)
- plan_id → match to offer''s payment_links

### Rule: When no MCP tool exists for a service, check platform-credentials for API keys and use curl directly. Do NOT default to browser.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-10T21:53:28.437738+00:00', '2026-03-10T21:53:28.437738+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('a66e9278-bf98-4209-ae65-6607f9cf4b58', 'Referral Partnership Pricing - Base Rates', 'Prezzi base Tony per clienti referral (partnership):

- Single Member LLC (Formation o Onboarding): €2.500
- Multi-Member LLC (Formation o Onboarding): €3.000
- Supplemento per LLC già costituite in Delaware o Florida: +€300

I prezzi sono gli stessi sia per nuove costituzioni (Formation) che per presa in carico di LLC esistenti (Onboarding).

Il Partner aggiunge il proprio markup al prezzo base. Tony fattura il totale al cliente, trattiene la quota base e trasferisce la differenza al Partner entro 7 giorni lavorativi dall''incasso.', 'Pricing', NULL, NULL, NULL, NULL, '2026-03-11T00:02:53.617779+00:00', '2026-03-11T00:02:53.617779+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('b8096080-ff7b-42c0-8f2a-abea970e7374', 'Invoice Workflow — Pre-Invoice Checklist', '## RULE: Before creating an invoice on QuickBooks

### MANDATORY STEPS before creating any invoice:

1. **Read the contract signed by the client** (`offer_get` with the token)
   - Verify purchased services and exact amounts
   - Verify the currency (EUR or USD)
   - Verify the chosen payment method (Whop checkout or bank transfer)

2. **Verify the payment**
   - If Whop: look for Whop confirmation (email, WhatsApp, CRM payments)
   - If EUR wire: look for Airwallex/Banking Circle notification
   - If USD wire: look for Relay Financial notification
   - Check the client''s WhatsApp for "Payment done" confirmations
   - DO NOT ask Antonio if the client has paid — CHECK autonomously

3. **Determine the QB customer currency**
   - EUR = individual person (personal name, e.g. "Alex Vitucci") → for EU clients who pay in EUR
   - USD = company (LLC name, e.g. "Alex Vitucci LLC") → after LLC formation
   - A client can have TWO QB customers: one EUR and one USD

4. **Create the invoice with correct data**
   - Customer name: must match how they paid (individual/LLC)
   - Amount: as per the contract (NOT the Whop total with 5% fee)
   - Due date: today (Due on receipt) if already paid
   - Description: services as per the contract

5. **If the client has ALREADY PAID:**
   - Create invoice → record payment (`qb_record_payment`) → send as Paid
   - The invoice PDF will show Balance Due: $0.00

6. **If the client has NOT yet paid:**
   - Create invoice → send with bank details in the email
   - Monitor the payment

### SPECIAL RULE for LLC Formation:
- The first payment is ALWAYS on the individual person (EUR if EU, USD if non-EU)
- After LLC formation, the customer switches to USD with LLC name
- Annual renewals go on the LLC (USD)', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-11T14:34:58.046766+00:00', '2026-04-06T23:48:29.043668+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('67452a49-c436-4133-a26b-4a80ab6e20fb', 'Post-Payment Onboarding Workflow (Complete)', '# Post-Payment Client Onboarding Workflow

## Trigger
Whop webhook receives payment.succeeded → lead status set to "Paid" → task created for Antonio.

## Complete Steps (in order)

### Phase 1: Form
1. `onboarding_form_create(lead_id, entity_type, state)` → generates form URL
2. Send form link to client via email (gmail_send)
3. Client completes form: personal data + company data + tax status + document uploads

### Phase 2: Review & Full CRM Setup (ONE TOOL)
4. `onboarding_form_review(token)` → review submitted data (dry run first)
5. `onboarding_form_review(token, apply_changes=true)` → executes ALL steps automatically:
   1. Contact: find/create/update with all personal data
   2. Account: find/create with company data, status=Active
   3. Link: account_contacts junction (role=Owner)
   4. **Drive folder**: auto-creates `Companies/{State}/{Company Name}/`, sets `drive_folder_id` on account
   5. **Document copy**: downloads all uploaded files from Supabase Storage → uploads to Drive folder
   6. **Lease Agreement**: auto-creates lease as draft (auto-assigns suite 3D-XXX), shows URL and token
   7. Tasks: WhatsApp group (Luca), review+send lease (Antonio), RA change (Luca)
   8. Tax returns: auto-created if client answered "No" or "Not sure" to filing questions
   9. Portal: portal_account=true, portal_created_date=today
   10. Lead: status → "Converted"
   11. Form: status → "reviewed"

### Phase 3: Post-Review
6. `lease_send(token)` → Antonio reviews lease then sends to client (email with signature link)
7. `doc_bulk_process(account_id)` → classify and index all documents in Drive
8. Harbor Compliance: initiate RA change (manual until API available)
9. Send welcome email with portal access + WhatsApp group invitation
10. Request Google + Trustpilot review at closing

## Lease Agreement Flow
- Auto-created as **draft** during onboarding review (step 5.6)
- Suite number auto-assigned (3D-101, 3D-102, etc.)
- Antonio reviews with `lease_get(token)` then sends with `lease_send(token)`
- Client receives email → verifies identity → reads 19 articles → signs electronically
- Signed PDF auto-saved

## Payment Methods
- **Whop (card)**: +5% fee, automated via webhook
- **Wire transfer**: manual confirmation, then same flow

## Entity Type Mapping
- SMLLC → "Single Member LLC" → Tax return type 1120/5472 → deadline April 15
- MMLLC → "Multi Member LLC" → Tax return type 1065 → deadline March 15

## Drive Folder Structure
`TD Clients / Companies / {State} / {Company Name}/` on Shared Drive

## Key: Lead Status Flow
New → Call Scheduled → Call Done → Offer Sent → Negotiating → **Paid** → **Converted** (after onboarding review)', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-11T15:22:36.159988+00:00', '2026-03-12T02:43:07.601702+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('8fd23946-b2be-4a64-9c1f-a960e0ffd1ca', 'Invoicing Workflow — QuickBooks Post-Payment', 'CORE PRINCIPLE: All invoices are emitted AFTER payment is received. They are receipts/confirmations, NOT payment requests.

PAYMENT CHANNELS:
1. WHOP (card): Webhook auto-creates CRM payment (status=paid). No auto-invoice.
2. WIRE TRANSFER (bank): Client sends proof (contabile). CRM payment created as Pending → confirmed against QB bank feed → status=Paid.

DAILY PAYMENT MONITOR (Mon-Fri 9AM ET):
Scheduled task checks all CRM payments without QB invoice number. For each:
- ✅ Contract signed (offer status = signed/completed)
- ✅ Payment confirmed in CRM (status = paid)
- ✅ QB bank feed match (wire transfers only)
- ✅ QB customer exists (or needs creation)
Presents report to Antonio with 🟢🟡🔴 status.

APPROVAL FLOW:
1. Claude presents payment report with all checks
2. Antonio reviews and approves specific invoices
3. On approval, Claude executes:
   a. Create/verify QB customer
   b. Create QB invoice (marked as paid)
   c. Send invoice PDF via Gmail to client
   d. Update CRM payment with QB invoice number
   e. Update related CRM task

INVOICE RULES:
- NEVER emit before payment confirmed
- NEVER auto-send without Antonio approval
- Currency must match payment (USD or EUR)
- Whop: invoice amount = Whop charge amount
- Wire: invoice amount = agreed price from offer
- QB memo: include payment method + reference (Whop payment ID or bank transfer ref)
- Line items: match services from the client''s offer/deal

EXCEPTION HANDLING:
- Payment without matching lead/contact: flag for manual review
- Currency mismatch (EUR payment, USD offer): flag for Antonio
- Partial payment: create invoice for amount received, note remainder
- Refund: void original invoice in QB, update CRM payment status', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-11T17:10:33.364662+00:00', '2026-03-11T17:10:33.364662+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('6c59d7ca-e34a-4e79-93a7-0d7a49f758ee', 'Pricing: Service Amount vs Payment Amount', '## Rule: Service Amount != Payment Amount

The CRM tracks TWO different amounts:

### Service Delivery / Offer -> Service value
- The real price of the service (e.g., $2,000 for SMLLC annual management)
- This goes in: service_deliveries.amount, offers.services[].price
- Does NOT include surcharge, taxes, or processing fees

### Payment / Invoice -> Amount actually paid
- Includes the Whop surcharge (+5% for card) or other processing costs
- Example: service $2,000 -> card payment $2,100 ($2,000 + 5%)
- This goes in: payments.amount, QuickBooks invoice

### Whop Surcharge (credit card)
- +5% on the service amount (Master Rules P7)
- Example: $2,000 x 1.05 = $2,100
- The surcharge is NOT part of the service value
- In CRM: payment records $2,100, service delivery records $2,000

### Wire Transfer (bank transfer)
- No surcharge
- Amount paid = service amount
- Example: $2,000 wire = $2,000 service

### Rule for automations
When any job handler or automation creates a service delivery:
- ALWAYS use the service price from the offer (services[].price)
- NEVER use the Whop/card payment amount
- If the price in the offer includes ''$'' and commas, parse the clean number

CANONICAL SOURCE: Master Rules (KB 370347b6), rules P3, P7.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-12T15:56:04.554251+00:00', '2026-04-01T13:47:14.328813+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('4acad099-ae2e-4e03-b242-279f131cc008', 'safeSend Pattern — Mandatory for All Send Operations', '## Rule
Every MCP tool that sends something (email, notification, webhook) and updates a DB status MUST use `safeSend()` from `lib/mcp/safe-send.ts`.

## Why
If a tool updates status to "sent" BEFORE the actual send, and the send fails, the record is permanently marked as sent without actually being sent. The client never receives the email but the system thinks it was sent.

## Pattern
```
import { safeSend } from "@/lib/mcp/safe-send"

const result = await safeSend({
  idempotencyCheck: async () => { /* return { alreadySent: true, message } or null */ },
  sendFn: async () => { /* actual send — gmailPost, etc. */ },
  postSendSteps: [
    { name: "update_status", fn: async () => { /* DB update */ } },
    { name: "save_tracking", fn: async () => { /* tracking */ } },
  ],
})
```

## Key principles
1. Idempotency — check if already sent before sending again
2. Send FIRST — actual send before any DB status update
3. Status AFTER — only update status after confirmed send
4. Multi-step tracking — each post-send step tracked independently
5. Partial failure handling — if email sent but status update fails, report warning (not error)

## Tools using this pattern
- `lease_send` (lease.ts) — sends via Gmail API, then updates status
- `offer_send` (offers.ts) — sends via Gmail API, then updates status + lead
- `qb_send_invoice` (qb.ts) — sends via Gmail API (no status to update, safe)

## When building new send tools
ALWAYS use safeSend(). NEVER put status update before sendFn. See CLAUDE.md for details.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-12T22:09:57.079744+00:00', '2026-03-12T22:09:57.079744+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('85af9997-9a84-44d5-89b0-41e10538c6d3', 'Payset Application Process — OTP Required', '## Payset EUR IBAN Application Process

Payset non ha un portale partner dove aggiungere clienti. Il processo è:

1. Noi apriamo il referral link Payset
2. Al sign-up inseriamo email e telefono del cliente
3. Payset invia un **OTP via SMS** al telefono del cliente
4. Dobbiamo coordinarci con il cliente via **Telegram/WhatsApp** per ricevere l''OTP in tempo reale
5. Completiamo l''application con i dati raccolti dal banking form
6. Payset fa compliance review e approva

**IMPORTANTE:** Prima di iniziare l''application, concordare un orario con il cliente su Telegram per essere pronti a ricevere l''OTP.

**Contatto Payset:** Dragos Ungureanu — dragos.ungureanu@payset.io — +40 746 859 642

**Fee mensile:** £20/mese per cliente (accordo partnership)', 'Banking', NULL, NULL, NULL, NULL, '2026-03-13T16:28:20.392993+00:00', '2026-03-13T16:28:20.392993+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('2aa22c48-e467-4cd7-9c6d-6cf614d37f66', 'Relay Application Process — Client Self-Auth', '## Relay USD Business Account Application Process

1. Noi completiamo l''application con i dati raccolti dal banking form
2. Relay invia una **email di autenticazione** direttamente al cliente
3. Il cliente si autentica cliccando il link nell''email
4. Relay attiva il conto

**Nessun OTP richiesto.** Il cliente deve solo controllare la sua email dopo che noi facciamo l''application.

**Nota:** Informare il cliente nella welcome email che riceverà un''email da Relay per completare l''autenticazione.', 'Banking', NULL, NULL, NULL, NULL, '2026-03-13T16:28:23.367559+00:00', '2026-03-13T16:28:23.367559+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('4c520869-0d9a-43b9-9487-10ba707a7626', 'Workflow — Company Formation (5 Stages)', '## COMPANY FORMATION — Complete Workflow (v2 — March 14, 2026)

### STAGE 0 — Post-Sale (trigger: contract signed + payment)
**Mode: SUPERVISED for first 5 clients, then full-auto**

| # | Step | Who | How |
|---|------|-----|-----|
| 0.1 | Client signs contract | Client | **AUTO** — API call `/api/webhooks/offer-signed` → creates `pending_activations` record |
| 0.2a | Card payment (Whop) | System | **AUTO** — Whop webhook → match with pending_activation → `/api/workflows/activate-formation` |
| 0.2b | Wire payment | System | **AUTO** — Cron `/api/cron/check-wire-payments` every 6h → QB deposits match → activate-formation |
| 0.3 | Create QuickBooks invoice (paid) and send | **SUPERVISED** | Prepares data, saves in `pending_activations.prepared_steps`, waits for confirmation via MCP. After 5 ok → full-auto. `qb_create_invoice` + `qb_record_payment` + `qb_send_invoice` |
| 0.4 | Lead → Contact | **AUTO** | Creates contact with data from lead (name, email, phone) |
| 0.5 | Create service delivery "Company Formation" | **DEFERRED** | Created in Stage 2 when the account exists |
| 0.6 | Create formation form and send email to client | **SUPERVISED** | Creates form, prepares email, waits for confirmation via MCP. After 5 ok → full-auto. `formation_form_create` + `gmail_send` |

### STAGE 1 — Data Collection (trigger: client fills out the form)
**Mode: SUPERVISED — notification + confirmation review via MCP**

| # | Step | Who | How |
|---|------|-----|-----|
| 1.1 | Client fills out the formation form | Client | Data saved to Supabase (status → completed) |
| 1.2 | Notification email to support@ | **AUTO** | "Client X has completed the formation form" |
| 1.3 | Review data (supervised) | **SUPERVISED** | Claude prepares review, shows diff, waits for confirmation via MCP before applying |
| 1.4 | Apply changes | **AUTO** (after confirmation) | Job `formation_setup`: Contact update + Lead → Converted + Form → reviewed |
| 1.5 | Create service delivery | **AUTO** | `sd_create` Company Formation (inside job) |
| 1.6 | Advance to Stage 2 | **AUTO** | auto_advance after review |
| 1.7 | WhatsApp task for Luca | **AUTO** | CRM task: "Create WhatsApp group for {client_name} — {phone}" |

### STAGE 2 — State Filing (Luca communicates via Claude.ai)
**Mode: Luca leads, system automates CRM + Drive**

| # | Step | Who | How |
|---|------|-----|-----|
| 2.1 | Confirm state with client | Luca | Communicates to Claude.ai: "state confirmed WY, name XYZ LLC" |
| 2.2 | Check name availability on SOS portal | Luca | Guided by Claude.ai |
| 2.3 | Luca indicates the available name | Luca | Communicates to Claude.ai |
| 2.4 | Email to client for name confirmation | **SUPERVISED** | Claude prepares email, Luca/Antonio confirms |
| 2.5 | Search for client''s email reply | **AUTO** | Claude searches Gmail for the reply, then asks Luca to confirm |
| 2.6 | Register company on SOS portal | Luca | Guided by Claude.ai |
| 2.7 | Wait for SOS confirmation | Luca | WY: immediate / FL-NM: wait for SOS email |
| 2.8 | Luca uploads Articles PDF | Luca | Upload via Claude.ai → system saves to Drive |
| 2.9 | Create Account in CRM | **AUTO** | company_name, state, formation_date |
| 2.10 | Link Contact → Account | **AUTO** | Immediately after Account creation |
| 2.11 | Create Drive folder + upload Articles | **AUTO** | `Companies/{State}/{Company Name}/` |
| 2.12 | Activate Registered Agent (Harbor Compliance) | Luca | Guided — Luca confirms when done |
| 2.13 | Confirmation → advance to Stage 3 | **AUTO** | After Luca confirms RA |

### STAGE 3 — EIN Application + Welcome Package
**Mode: Luca leads EIN, system prepares complete package**

| # | Step | Who | How |
|---|------|-----|-----|
| 3.1 | Prepare SS-4 form | Luca | Guided by Claude.ai |
| 3.2 | Send SS-4 to client for digital signature | Luca | Email only |
| 3.3 | Fax signed SS-4 to IRS | Luca | Guided by Claude.ai |
| 3.4 | Follow up with IRS after 7 days | **AUTO** | 7-day timer → CRM task for Luca |
| 3.5 | Luca uploads EIN letter | Luca | Upload via Claude.ai |
| 3.6 | Save EIN to Drive + update Account | **AUTO** | Upload EIN letter + update Account.ein_number |
| 3.7 | Create Operating Agreement | **AUTO** | `oa_create` — state-specific template (NM/WY/FL), data from CRM |
| 3.8 | Create Lease Agreement (draft) | **AUTO** | `lease_create` |
| 3.9 | Create Relay Bank form | **AUTO** | `banking_form_create(provider: relay)` |
| 3.10 | Create Payset Bank form | **AUTO** | `banking_form_create(provider: payset)` |
| 3.11 | Send Welcome Package to client | **SUPERVISED** | Template `dac9ce5f`: EIN (attachment) + Articles (attachment) + OA link + Lease link + Relay link + Payset link + Wise recommendation + IBAN rules |
| 3.12 | Advance to Stage 4 | **AUTO** | After email sent |

### STAGE 4 — Post-Formation (automation)

| # | Step | Who | How |
|---|------|-----|-----|
| 4.1 | Document quality check | **AUTO** | `doc_compliance_check(account_id)` — verifies: Articles, EIN, OA, Passport, Proof of Address |
| 4.2 | Advance to Stage 5 | **AUTO** | After quality check |

### STAGE 5 — Closing
**Mode: Luca confirms banking, system handles review**

| # | Step | Who | How |
|---|------|-----|-----|
| 5.1 | Verify banking completed | Luca | Confirms to Claude.ai: "Relay and Payset active for {company}" |
| 5.2 | Send review request email | **SUPERVISED** | Review template with Google + Trustpilot links |
| 5.3 | Cron check review after 7 days | **AUTO** | Trustpilot scraping for client name |
| 5.4 | If review not found → reminder | **AUTO** | Reminder email to client + CRM task |
| 5.5 | If review found → completed | **AUTO** | Mark completed |
| 5.6 | Close service delivery | **AUTO** | After banking confirmation + review (or second reminder) |

---

## Drive Folder Structure

```
Companies/{State}/{Company Name}/
  ├── Articles of Organization.pdf
  ├── EIN Letter.pdf
  ├── Operating Agreement.pdf
  ├── Passport/
  │   └── {owner_name}.pdf
  ├── Lease/
  │   └── Lease Agreement.pdf
  └── Bank/
      ├── Relay/
      │   ├── Passport Photo.jpg
      │   └── Proof of Address.pdf
      └── Payset/
          ├── Proof of Address.pdf
          └── Business Bank Statement.pdf
```

## Compliance Requirements (per entity type)

**Single Member LLC:** Articles of Organization, EIN Letter, Operating Agreement, Passport, Proof of Address
**Multi Member LLC:** Articles of Organization, EIN Letter, Operating Agreement, Passport, Proof of Address
**C-Corp Elected:** Articles of Incorporation, Bylaws, EIN Letter, Passport, Proof of Address

## Templates

| Template | ID | Usage |
|----------|------|-------|
| Welcome Package — Post-EIN (IT+EN) | `dac9ce5f` | Step 3.11 — email with EIN, Articles, OA, Lease, Relay, Payset, Wise |
| Review Request — Post-Formation (IT+EN) | approved_responses | Step 5.2 — Google + Trustpilot review request |

## Review Links
- **Trustpilot:** https://www.trustpilot.com/evaluate/tonydurante.net
- **Google:** https://g.page/r/CekpVxwN1zY5EBM/review

## Operating Agreement
- Template per state: NM, WY, FL (English only, SMLLC)
- Pattern: `oa_create` + `oa_send` + frontend `/operating-agreement/{token}`
- Table: `oa_agreements` (like lease_agreements)
- Data from CRM: company_name, state, member_name, address, formation_date, EIN
- Client signs digitally and downloads PDF

## Supervised Automation
- Step 0.3 (QB invoice) and 0.6 (formation form): supervised for first 5 clients, then full-auto
- Confirmation via MCP tool (works from Claude Code and Claude.ai)
- Prepared data saved in `pending_activations.prepared_steps` JSON

## Technical Notes

### Table: pending_activations
- Tracks the gap between contract signing → payment
- Status: awaiting_payment → payment_confirmed → activated → expired/cancelled
- Field `prepared_steps` JSON for supervised automation

### Endpoints (Stage 0)
- `/api/webhooks/offer-signed` — creates pending_activation when client signs
- `/api/workflows/activate-formation` — executes Stage 0
- `/api/cron/check-wire-payments` — every 6h checks QB deposits

### Banking
- **Relay (USD)**: We submit the application → client receives email to authenticate
- **Payset (EUR IBAN)**: We submit the application → OTP from client in real time on Telegram
- **Wise**: Client opens on their own at wise.com

### IBAN Rule
IBAN (Payset/Wise) only for receiving euros. Funds converted to USD and transferred to Relay. NEVER use IBAN for payments to third parties.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-13T19:05:34.451746+00:00', '2026-04-06T23:49:59.602009+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('96d3cb53-0e36-4818-9d05-1c6b109279ba', 'Currency Rule for Offers: EUR setup, USD installment', '## Currency rule for offers

**Setup fee (one-time)**: always in **EUR** (€)
- The client is European and pays the initial setup in euros
- Examples: €2,500 (SMLLC), €3,000+ (MMLLC/partner pricing)

**Annual maintenance (installment)**: always in **USD** ($)
- Invoiced by the US LLC Tony Durante LLC
- SMLLC: $2,000/year ($1,000 Jan + $1,000 Jun)
- MMLLC / Delaware: $2,500/year ($1,250 Jan + $1,250 Jun)

**Why**: All clients are European. The setup is a direct payment (EUR). Maintenance is an ongoing service invoiced by the US LLC (USD).

**No exceptions**: applies to all offers.', 'Pricing', NULL, NULL, NULL, NULL, '2026-03-16T16:44:53.296381+00:00', '2026-04-06T23:48:35.438129+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('ca7dbd6e-67dd-4d95-bfba-d66685ca2d98', 'Installment Rule: Formation Date and First Payment', '## Annual Maintenance Installments

### Amounts per entity type
- SMLLC (Single Member LLC): $2,000/year -- $1,000 (January) + $1,000 (June)
- MMLLC (Multi Member LLC): $2,500/year -- $1,250 (January) + $1,250 (June)
- Delaware LLC: $2,500/year -- $1,250 (January) + $1,250 (June)

### Formation after September rule (MANDATORY)
If a company is formed AFTER September 1 of a year, the FIRST installment of the following year (January) is SKIPPED.

Logic: The setup fee covers services through the end of the formation year. The first annual maintenance payment starts from the SECOND installment (June) of the following year.

Example:
- Zhang Holding LLC formed on 09/26/2025
- The setup fee covers through 12/31/2025
- First 2026 installment (January) = SKIPPED
- First payment due = Second 2026 installment (June) = $1,250

### When to create payment records
- Companies formed BEFORE September: create both installments for the following year
- Companies formed AFTER September: create ONLY the second installment (June) for the following year
- From the second year onward: both installments as usual

### Currency
- Setup fee: ALWAYS in EUR
- Annual installments: ALWAYS in USD', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-16T19:24:12.525949+00:00', '2026-04-06T23:48:13.980685+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e4946685-fa7c-4608-a525-6ac4da568b65', 'Contract Types — MSA, Service, Tax Return [DEPRECATED]', '## ⚠️ DEPRECATED — Use "Contract Type Taxonomy" (3ddcdf85) instead

_Deprecated 2026-04-04. This article described the OLD contract_type values (`msa`, `service`) which have been replaced._

**Current contract_type values:** `formation`, `onboarding`, `tax_return`, `itin`, `renewal`

**What changed (April 2026):**
- `msa` → replaced by `formation` (new LLC) and `onboarding` (existing LLC)
- `service` → replaced by `onboarding`
- Each service now carries its own `contract_type` in the offer''s services JSONB (per-service contract_type)
- Multi-contract signing: if an offer includes services with different contract_types (e.g., formation + ITIN), each renders as a separate agreement. Client must sign ALL contracts before checkout.
- Client Portal section added to MSA + SOW
- CRM offer dialog now includes Payment Gateway (Stripe/Whop) and Bank Account (Relay/Mercury/Revolut/Airwallex/Auto) dropdowns (commit 978d730)

**Canonical reference:** KB article "Contract Type Taxonomy" (3ddcdf85-d119-4988-9a8c-d57e83817167)

## Payment Structure (still valid)
- Upon Signing (First Year): Full Annual Service Fee due at contract signing
- From Following Year: Split into two installments (January + June)
- Late Onboarding: Clients onboarding after January 1 pay the full fee (no proration)
- Cancellation Deadline: November 1 of current Contract Year — written notice required

## Rules (still valid)
1. Contract content MUST be in English
2. Fee labels: `/year` not `/anno`
3. First year = full fee at signing. Year 2+ = two installments
4. Existing clients: use `account_id` in `offer_create` instead of `lead_id`
5. Preview before sending: always provide `?preview=td` link to Antonio', 'Operations', NULL, NULL, NULL, NULL, '2026-03-17T18:18:11.61936+00:00', '2026-04-04T18:15:48.188389+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('954e851a-0b6c-447e-b6bb-ccd79ee07df9', 'Bank Wire Details — Relay Financial (USD)', '## Relay Financial — USD Wire Transfer Details

Use these details for all client wire transfers in USD.

**Bank:** Relay Financial
**Account Name:** TONY DURANTE L.L.C.
**Address:** 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771
**Account Number:** 200000306770
**Routing Number:** 064209588

### Important
- Always include the full beneficiary address — wires without it get rejected
- Reference format: "{Company Name} - {Client Name}"
- The old Seminole address (11761 80th Ave) is NO LONGER valid — do not use

### EUR Wire (Airwallex via Banking Circle)
**IBAN:** DK8989000023658198
**BIC/SWIFT:** SXPYDKKK
**Beneficiary:** Tony Durante LLC', 'Banking', NULL, NULL, NULL, NULL, '2026-03-18T12:00:08.073689+00:00', '2026-04-01T13:45:57.773013+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('8a04eb60-d1c0-43ce-bca9-b7a3630c2ff2', 'Client-Facing Naming Rule: Use Correct Service Name', 'All client-facing elements MUST use the correct service name, not a generic or unrelated name.

This applies to:
- Contract titles (e.g., "ITIN Application Service Agreement", NOT "Tax Return Filing Agreement")
- Offer titles and service names
- Form titles and page headers
- Email subject lines
- HubSpot deal names and links
- PDF filenames
- Any URL slugs or tokens that clients see

Each service has its own identity:
- LLC Formation → "LLC Formation"
- LLC Onboarding/Management → "LLC Management" or "Annual LLC Management"
- Tax Return → "Tax Return Filing"
- ITIN Application → "ITIN Application"
- Banking (Payset/Relay) → "Banking Application"
- Registered Agent → "Registered Agent"
- Annual Report → "Annual Report Filing"

NEVER use a generic name (like "LLC Formation") for a different service (like "ITIN Application"). Each service must be clearly identified by its correct name in all client-facing contexts.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-18T12:31:19.886783+00:00', '2026-03-18T12:31:19.886783+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('3ddcdf85-d119-4988-9a8c-d57e83817167', 'Contract Type Taxonomy', '## Contract Types (offer.contract_type)

Contract type represents the BUSINESS SCENARIO, not the legal document name. It determines which contract template the client sees.

| contract_type | Scenario | Contract Template |
|---|---|---|
| `formation` | LLC to create (new client) | Full MSA+SOW with formation timeline |
| `onboarding` | LLC already exists (new or existing client) | MSA+SOW without formation timeline (ServiceAgreement) |
| `tax_return` | Standalone tax return filing | StandaloneServiceAgreement (lightweight) |
| `itin` | Standalone ITIN application | StandaloneServiceAgreement (lightweight) |
| `renewal` | Annual renewal | Renewal agreement |

### Rules
- Both `formation` and `onboarding` use MSA+SOW contracts — the only difference is formation includes the LLC creation timeline
- `tax_return` and `itin` use the same lightweight template (StandaloneServiceAgreement) but with service-specific titles, scope, and procedures
- Every form, contract, link, and document MUST use the actual service name — never generic names like "LLC Formation" for an ITIN service
- New standalone services (EIN, Banking, Closure) get added as new contract_type values
- Old values `msa` and `service` were migrated and should never be used for new offers

## Per-Service contract_type (Multi-Contract Offers — commit 1ca20f0)

Each service in the offer''s `services` JSONB now carries its own `contract_type` field, populated from SERVICE_CATALOG via the CRM create-offer dialog.

### How it works:
1. The offer has a main `contract_type` (e.g., `formation`)
2. Each service also has a `contract_type` (e.g., `formation`, `itin`, `tax_return`)
3. Services whose `contract_type` matches the offer''s main type → go into the **main MSA + SOW**
4. Services with a **different** `contract_type` → rendered as **separate standalone agreements**
5. Services with no `contract_type` → default to the offer''s main `contract_type`

### Multi-Contract Signing Flow:
- Client sees all contracts on one page: main MSA+SOW at top, addon standalone agreements below
- Each contract has its own signature canvas
- **Client MUST sign ALL contracts before checkout** — checkout button only appears after all signatures
- Even free/included services (e.g., Tax Return at $0 in an onboarding offer) require signing their standalone agreement
- Setup fee only counts services belonging to the main contract

### Payment Gateway + Bank Selection (commit 978d730)
- CRM offer dialog now has **Payment Gateway** dropdown: Stripe (default, deferred checkout) or Whop (plan created at offer time)
- CRM offer dialog now has **Bank Account** dropdown: Auto (default), Relay, Mercury, Revolut, Airwallex
- Centralized in `bank-defaults.ts` via `getBankDetailsByPreference()`
- `servicesJson` now includes `contract_type` + `pipeline_type` from SERVICE_CATALOG

### Examples:

**Formation + ITIN:**
```
Offer contract_type: formation
Services:
  Company Formation LLC NM — contract_type: formation → main MSA+SOW
  ITIN Application — contract_type: itin → standalone ITIN agreement
Result: 2 contracts, 3 signatures (2 for MSA+SOW, 1 for ITIN)
```

**Onboarding + Tax Return (included):**
```
Offer contract_type: onboarding
Services:
  LLC Annual Management — contract_type: onboarding → main MSA+SOW
  Tax Return 2025 — contract_type: tax_return, price: Included → standalone Tax Return agreement
Result: 2 contracts, 3 signatures (even though Tax Return is free)
```

**Standalone ITIN:**
```
Offer contract_type: itin
Services:
  ITIN Application — contract_type: itin → standalone ITIN agreement
Result: 1 contract, 1 signature
```

## Bundled Pipelines (offer.bundled_pipelines)

A text[] array listing which service deliveries to create when the client pays. Each entry becomes a separate tracked pipeline.

### Correct bundled_pipelines per contract type (v7.0)

| contract_type | bundled_pipelines MUST contain | Optional additions |
|---|---|---|
| `formation` | `["Company Formation"]` | `"ITIN"`, `"Banking Fintech"`, `"Tax Return"` |
| `onboarding` | `["Client Onboarding"]` | `"Tax Return"`, `"ITIN"`, `"Banking Fintech"` |
| `tax_return` | `["Tax Return"]` | — |
| `itin` | `["ITIN"]` | — |

### NEVER in bundled_pipelines (annual/recurring SDs)

These service types are NEVER included in bundled_pipelines:
- **State RA Renewal** — created at formation/onboarding CLOSING (SOP Phase 3)
- **State Annual Report** — created at formation/onboarding CLOSING (SOP Phase 3)
- **CMRA Mailing Address** — created at formation/onboarding CLOSING (SOP Phase 3)
- **Billing Annual Renewal** — created by 1st installment payment cron (Year 2+)

These annual SDs are created:
1. **Year 1:** At formation/onboarding closing (Phase 3 of SOP v7.0), after all portal items are signed
2. **Year 2+:** By the 1st installment payment cron (January), which creates a Billing Annual Renewal SD. When payment is received, that SD auto-creates 4 recurring SDs: RA Renewal, Annual Report, CMRA, Tax Return

### How it works
1. Every offer MUST have bundled_pipelines set
2. When client pays (Whop webhook or wire), activate-service reads bundled_pipelines
3. One service_delivery is created for EACH pipeline type
4. Each delivery follows its own independent pipeline with auto_tasks from pipeline_stages
5. If a service has price "Inclusa"/"Included" in the offer, it''s covered by the main deal — no separate invoice needed. The system sets tax_returns.paid=true for included Tax Returns

### Available pipeline types
- Company Formation
- Client Onboarding
- ITIN
- Tax Return
- EIN
- Company Closure
- Banking Fintech
- Banking Physical
- Annual Renewal
- CMRA Mailing Address

### Examples
- Formation only: `[''Company Formation'']`
- Formation + ITIN: `[''Company Formation'', ''ITIN'']`
- Onboarding + Tax + ITIN + Banking: `[''Client Onboarding'', ''Tax Return'', ''ITIN'', ''Banking Fintech'']`
- Standalone tax return: `[''Tax Return'']`
- Standalone ITIN: `[''ITIN'']`

### Important
- The services array is for DISPLAY (what client sees on the offer page)
- bundled_pipelines is for AUTOMATION (what the system creates when client pays)
- These are separate concerns — a display service like "Full LLC Management" doesn''t need its own pipeline
- Only services with independent workflows get their own pipeline entry', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-18T14:35:53.776621+00:00', '2026-04-04T18:17:09.279496+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('4f884934-7db1-4776-b7c2-9d063a9bd64b', 'Service Naming Convention', '## Rule: Every client-facing element MUST use the actual service name

All forms, contracts, links, emails, HubSpot entries, and documents must reflect the specific service they relate to. Never use generic or incorrect service names.

### Correct examples
- ITIN contract title: "ITIN Application Service Agreement" (NOT "Tax Return Filing Agreement")
- Tax return contract title: "Tax Return Filing Agreement" (NOT "Service Agreement")
- Formation offer: Shows "LLC Formation" in title and content
- Onboarding offer: Shows the specific services being onboarded

### Where this rule applies
- Contract templates (title, scope, procedure sections)
- Form titles and descriptions
- Email subject lines and body
- HubSpot deal names and pipeline entries
- Google Drive folder names
- QuickBooks invoice descriptions
- Task titles in CRM
- Service delivery names

### Why
- Clients should always see the name of the service they''re purchasing
- Internal systems should be searchable by service name
- Avoids confusion when a client has multiple services
- Makes reporting and pipeline tracking accurate', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-18T14:36:07.856231+00:00', '2026-03-18T14:36:07.856231+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('bec358d5-0a3b-4551-ae36-63d0dd3078bd', 'Form Submissions Must Be Saved to Google Drive', '## Rule: Every form submission must be converted to PDF and saved to Google Drive

When a client completes ANY form (tax, formation, onboarding, ITIN, banking, closure), the following must happen during review (apply_changes=true):

1. **Data Summary PDF** — generated from submitted data using `saveFormToDrive()` from `lib/form-to-drive.ts`
2. **Uploaded files** — copied from Supabase Storage to the client''s Drive folder
3. **Correct subfolder** — each form type saves to its designated Drive subfolder

### Form Type → Drive Subfolder Mapping

| Form Type | Storage Bucket | Drive Subfolder | PDF Prefix |
|---|---|---|---|
| tax_return | tax-form-uploads | 3. Tax | Tax_Data |
| formation | onboarding-uploads | 1. Company | Formation_Data |
| onboarding | onboarding-uploads | 1. Company | Onboarding_Data |
| itin | onboarding-uploads | ITIN | ITIN_Data |
| banking | onboarding-uploads | 4. Banking | Banking_Data |
| closure | onboarding-uploads | 1. Company | Closure_Data |

### Implementation

All `_form_review` MCP tools call `saveFormToDrive()` when `apply_changes=true`. The module:
- Finds or creates the target subfolder in the client''s Drive folder
- Generates a data summary PDF with all submitted fields organized by section
- Copies uploaded files from Supabase Storage to Drive
- Returns file IDs and error details

### When adding new form types
1. Add config entry to `FORM_CONFIGS` in `lib/form-to-drive.ts`
2. Hook `saveFormToDrive()` into the new form''s `_review` tool
3. Ensure the Storage bucket and Drive subfolder are correct

### Email templates
- Forms are in English only (legal documents for US authorities)
- Emails to clients must be in the client''s language (EN or IT)
- Every email template must be bilingual with language parameter', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-18T16:39:11.276632+00:00', '2026-03-18T16:39:11.276632+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('93d30298-a831-454f-a8e2-eedc1cfd9f04', 'Company Closure — State Forms and Filing Requirements', '## Dissolution Filing by State

### Wyoming (majority of clients)
- **Form**: Articles of Dissolution (official PDF from SOS)
- **Filing**: Mail only — cannot file online
- **Fee**: $60 (check or money order to Wyoming Secretary of State)
- **Mail to**: Wyoming Secretary of State, Herschler Building East, Suite 101, 122 W 25th Street, Cheyenne, WY 82002-0020
- **Processing**: Up to 15 business days
- **Template**: Drive → Templates/State Forms/Wyoming LLC Articles of Dissolution.pdf

### New Mexico
- **Form**: Online only — no paper filings accepted
- **Filing**: Online via https://enterprise.sos.nm.gov
- **Fee**: $25
- **Note**: Luca files directly on the portal

### Florida
- **Form**: Articles of Dissolution via Sunbiz
- **Filing**: Online preferred via https://efile.sunbiz.org/dissolvellc.html (or mail PDF)
- **Fee**: varies
- **Note**: Online filing recommended

### Delaware
- **Form**: Certificate of Cancellation (not "Dissolution")
- **Filing**: Online or mail
- **Mail to**: Delaware Division of Corporations, 401 Federal Street, Suite 4, Dover, DE 19901
- **Template**: Drive → Templates/State Forms/Delaware LLC Certificate of Cancellation.pdf

## IRS EIN Closure
- **No official form** — requires a signed letter
- **Mail to**: Internal Revenue Service, Cincinnati, OH 45999
- **Letter must include**: LLC legal name, EIN, business address, reason for closing
- **Prerequisites**: All outstanding tax returns must be filed and taxes paid
- **Processing**: Few weeks, IRS mails confirmation letter
- **Template**: Auto-generated from CRM data by the system', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-18T20:26:02.64635+00:00', '2026-03-18T20:26:02.64635+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('a25c8daf-f419-47a3-908f-98e494ba60c0', 'Bank Account Details — EUR and USD', '## Rule: Auto-select bank account based on payment currency

When creating an offer with bank_transfer payment:
- If client pays in EUR → use Airwallex
- If client pays in USD → use Relay

---

## EUR Account — Airwallex

Account name: TONY DURANTE L.L.C.
Address: 10225 Ulmerton Rd, 3D, Largo, FL 33771
IBAN: DK8989000023658198
SWIFT/BIC: SXPYDKKK
Account location: Denmark (Europe)
Bank name: Banking Circle S.A.
Bank address: Amerika Plads, 38, Copenhagen, Denmark, 2100

---

## USD Account — Relay

Account name: TONY DURANTE L.L.C.
Address: 10225 Ulmerton Rd, 3D, Largo, FL 33771
Account#: 200000306770
Routing#: 064209588', 'Banking', NULL, NULL, NULL, NULL, '2026-03-19T12:14:08.821723+00:00', '2026-03-19T12:14:08.821723+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('d493ab61-0c08-458f-8585-397909c9f8df', 'Tax Return — EUR to USD Conversion Rule (IRS Requirement)', '## IRS Requirement: All US Tax Returns Must Be Filed in USD

All amounts on Form 1065 (and any US tax return) MUST be expressed in US dollars. No exceptions.

### How to Convert

Use the IRS yearly average exchange rate for the tax year:
- Source: https://www.irs.gov/individuals/international-taxpayers/yearly-average-currency-exchange-rates
- 2025 rate: EUR → USD = divide EUR by 0.886 (i.e., 1 EUR = $1.1287 USD)
- 2024 rate: EUR → USD = divide EUR by 0.924

### Application to P&L and Balance Sheet

When generating financial statements for MMLLCs with EUR accounts:
1. Show BOTH columns: EUR (original) and USD (converted at IRS rate)
2. Use yearly average rate for all income/expense transactions
3. Use year-end spot rate for Balance Sheet items (cash, assets, liabilities)
4. Note the conversion method and rate on the financial statements
5. Currency conversions between EUR/USD balances are NOT income/expense — exclude from P&L

### Tool Implementation

The bank_statement_pnl MCP tool MUST:
- Auto-convert all EUR amounts to USD using the IRS yearly average rate
- Include both EUR and USD columns in the Excel output
- Flag the conversion rate and source (IRS) in notes
- Handle multi-currency accounts (EUR + USD) separately then consolidate

### Related Party Transactions

Flag any transactions between the LLC and entities sharing the same owners (e.g., PL Academy FZCO for PlayLover International LLC). These must be disclosed on Form 1065 Schedule L and K-1.', 'Tax', NULL, NULL, NULL, NULL, '2026-03-19T14:45:11.094558+00:00', '2026-03-19T14:45:11.094558+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('bf23fdea-4af1-43f4-8f74-77d23cfaa5cd', 'Email Encoding Rule - ASCII Only in Subjects', 'RULE: All email subjects and content sent to clients or team members must use ASCII-only characters.

PROHIBITED in email subjects:
- Emojis (no unicode emojis of any kind)
- Special dashes (no em dash, en dash - use regular hyphen -)
- Accented characters in subjects (use ASCII equivalents)

USE INSTEAD:
- Priority tags: [URGENT], [HIGH], [TASK], [REMINDER]
- Regular hyphen: - (not em dash or en dash)
- Plain text descriptions

WHY: Gmail and other email clients garble UTF-8 emojis in MIME-encoded subjects, showing broken characters like "A*AYA" instead of emojis. This looks unprofessional to clients.

APPLIES TO: All emails sent via gmail_send, gmail_draft, and any email notification (task notifications, form links, welcome packages, etc.).

HTML BODY: Emojis are OK inside the HTML body (they render correctly in the body), but keep subjects clean.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-19T17:22:54.492489+00:00', '2026-03-19T17:22:54.492489+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('813c6351-8a77-4f40-82da-e39016e07525', 'Whop Product and Invoicing Rules', 'RULE: Every Whop checkout plan must be created under the CORRECT product. Never dump everything under "Client Onboarding."

WHOP PRODUCTS (match service types):
- LLC Formation (prod_R7chh5mXdiCTc) - setup fees for new LLC
- Client Onboarding (prod_X6mwSZhW9GqPW) - setup fees for existing LLC clients
- LLC Annual Management (prod_ogVnqqu9sp9UE) - annual installments for existing clients
- Tax Return (prod_BqM6rYviYUnoH) - standalone tax return
- ITIN Application (prod_IaDRac97m5F2G) - standalone ITIN
- DBA Registration (prod_C2q5sUGOiPx8O) - DBA service
- Shipping (prod_oIoUpYrCGEwcT) - shipping fees

PLAN TITLE FORMAT: "{Company short} - {description}" (max 30 characters)
Examples: "Nova Ratio - 1st Install 2026", "Alma Accel - Tax Return 2025"

PRICING RULE: Whop adds 5% CC processing fee on top of the base price.
- QB invoice: base amount (e.g., $1,250)
- Whop plan: base + 5% (e.g., $1,313)
- Wire transfer: base amount only (no fee)

INVOICE FLOW:
1. Create QB invoice (base amount, unpaid)
2. Create Whop plan under correct product (base + 5%)
3. Send invoice email with BOTH options:
   - Wire transfer: Relay bank details + base amount
   - Card payment: Whop checkout link + amount with fee
4. When paid: mark QB invoice as paid, record payment method

BANK DETAILS FOR WIRE:
- USD: Relay (Account 200000306770, Routing 064209588)
- EUR: Airwallex (IBAN DK8989000023658198, BIC SXPYDKKK)

RULE: The client sees the Whop product name on the checkout page. It MUST match the service being invoiced. A client paying an annual installment must see "LLC Annual Management", not "Client Onboarding."', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-19T19:18:39.760393+00:00', '2026-03-19T19:18:39.760393+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('095f8a5f-6c01-4830-9c00-2a3abbcc38ae', 'Service Delivery Lifecycle — Year 1 vs Year 2+', 'SERVICE DELIVERY LIFECYCLE

YEAR 1 (Setup — Formation or Onboarding):
- Client pays setup fee (one-time, in EUR for first contact)
- activate-service reads bundled_pipelines from the offer and creates deal-specific SDs
- Example formation: ["Company Formation"] or ["Company Formation", "ITIN", "Banking Fintech"]
- Example onboarding: ["Client Onboarding", "Tax Return", "ITIN", "Banking Fintech"]
- The setup fee covers everything for the current year through Dec 31
- Each SD follows its own pipeline independently with auto_tasks from pipeline_stages
- If a service has price "Inclusa"/"Included" in the offer (e.g. Tax Return), tax_returns.paid is set to true — no separate invoice
- Annual/recurring SDs (RA Renewal, Annual Report, CMRA) are NOT in bundled_pipelines — they are created at formation/onboarding CLOSING (Phase 3 of SOP v7.0)
- The onboarding/formation closing creates ARTIFACTS (lease, OA) and recurring SDs

YEAR 2+ (Annual Management):
- January: system creates 1st installment invoice for ALL active clients (account_type = "Client")
- Client pays 1st installment -> Billing Annual Renewal SD created
- When payment received: Billing Annual Renewal auto-creates 4 recurring SDs:
  - State RA Renewal (renew on Harbor Compliance)
  - State Annual Report (file on state portal, NOT for NM)
  - CMRA Mailing Address (new lease agreement)
  - Tax Return (activate tax season pipeline)
- June: 2nd installment = gate before tax return goes to India team
- One-Time customers (account_type = "One-Time") do NOT get recurring services

RENEWAL TRACKING DATES (on accounts table):
- ra_renewal_date: set during onboarding/formation, used by cron (30 days before)
- annual_report_due_date: per state (FL=May 1, DE=Jun 1, WY=anniversary month, NM=none)
- cmra_renewal_date: Dec 31 current year (lease expiry)
- These dates are for SERVICE DELIVERY tracking, NOT for invoicing
- Invoicing is a separate January process for ALL active clients

POST-SEPTEMBER RULE:
- Formation Sep-Dec -> skip January installment next year
- First payment = June (2nd installment)
- Tax return still gets filed
- Setup fee covers services through Dec 31

CANCELLATION:
- Only permitted if cancellation request submitted by October 31
- AND both installments for the year have been paid', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-20T15:35:10.980955+00:00', '2026-03-26T17:28:04.025921+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('2bd3040d-0832-423e-886c-265022d05ffa', 'Drive Folder Structure — Fixed Rules', 'GOOGLE DRIVE FOLDER STRUCTURE — FIXED RULES

Shared Drive: Tony Durante LLC (ID: 0AOLZHXSfKUMHUk9PVA)

ROOT STRUCTURE:
TD Clients/
  Companies/
    {State}/
      {Company Name - Owner Name}/
        1. Company/        -- Articles of Org, OA, Lease, EIN Letter
        2. Contacts/       -- Passport, ID docs, W-7
        3. Tax/            -- Tax returns, extensions, P&L
           {Year}/         -- Year subfolder (e.g., 2025/, 2026/)
        4. Banking/        -- Bank applications, account docs
        5. Correspondence/ -- Emails, letters, communications
  Individual Clients/
    {Client Name}/
      {Service}/           -- Per-service subfolder (ITIN/, Banking Physical/)
  Leads/
    {Client Name}/         -- Pre-formation/pre-onboarding data

RULES:
1. Companies folder: organized by STATE, then COMPANY NAME
2. 5 numbered subfolders: ALWAYS created together, never skip any
3. Tax folder: MUST have year subfolders (3. Tax/2025/, 3. Tax/2026/)
4. Individual Clients: per-SERVICE subfolders (not numbered)
5. Leads folder: temporary, documents move to Companies/ after formation/onboarding
6. Pre-SOS (before LLC confirmed): documents go to Leads/{Contact Name}/
7. Post-SOS (after LLC confirmed): documents go to Companies/{State}/{Company}/
8. Folder naming: {Company Name} - {Owner Name} (e.g., ''PTBT Holding LLC - Mark Eke'')
9. formation_confirm creates the definitive Companies/ folder with 5 subfolders
10. onboarding_setup background job creates the same structure

TEMPLATES FOLDER:
Templates/
  IRS Forms/             -- W-7, 1040-NR, Schedule OI blanks, passport example
  State Forms/           -- Articles of Dissolution (WY, DE)

DOCUMENT STORAGE RULE:
- Google Drive = source of truth for all documents
- Portal = mirror (client-facing) for key documents only
- Every document goes FIRST to Drive, then key docs COPIED to Portal
- Documents saved to Drive: Articles, EIN Letter, OA, Lease, Tax Returns, Bank Statements, P&L, ITIN forms

FILE NAMING CONVENTION:
- W-7_{FirstName}_{LastName}.pdf
- 1040-NR_{FirstName}_{LastName}.pdf
- Schedule_OI_{FirstName}_{LastName}.pdf
- Tax_Data_{Company}.pdf
- Formation_Data_{Name}.pdf
- Onboarding_Data_{Company}.pdf
- {Company} - PnL {Year}.xlsx
- EIN Official - {Company}.pdf
- Articles of Organization - {Company}.pdf"', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-20T15:42:40.888837+00:00', '2026-03-20T15:42:40.888837+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('370347b6-cfa7-486e-a757-e2acce70e15d', 'MASTER RULES — Fixed Business Rules Reference', 'MASTER RULES -- Fixed Business Rules Reference
Version: 3.2 -- 11 April 2026
KB Article ID: 370347b6-cfa7-486e-a757-e2acce70e15d

MANDATORY RULE: Every SOP must reference this document. Every SOP update must verify alignment with these rules. If a rule here changes, all SOPs inherit the change automatically.

CANONICAL SOURCE RULE: When any data (bank details, pricing, domain names) appears in multiple places, this document is canonical. If values conflict, Master Rules wins. Always.

DECISION PROPAGATION RULE: When a decision changes how the system works: 1. Update THIS document FIRST. 2. Update relevant SOP. 3. Update instructions.ts. 4. Update session-context sysdoc. 5. Update CLAUDE.md or memory if affects Claude Code. A decision is NOT recorded until all sources are updated.

=======================================
FLEXIBILITY PRINCIPLE (1) -- NEW v3.2
=======================================

F1. FLEXIBLE, STATE-AWARE, RECONCILING DESIGN: When designing, planning, fixing, or refactoring, do NOT default to rigid one-path solutions when a flexible, state-aware, reconciling design is better. Do not disable when coexistence is better. Do not replace when linking/matching is better. Do not assume one source owns truth when multiple should reconcile. Preserve information. Prefer additive, composable, future-compatible changes. Always ask whether two parts of the system should check each other before excluding one. Full details: kb_search(''F1 Flexibility Principle''). Full roadmap: sysdoc_read(''crm-lifecycle-roadmap'').

=======================================
CLAUDE OPERATING RULES (4) -- READ FIRST
=======================================

O1. MANDATORY SESSION START: At the start of every session, before any action or answer, run sysdoc_read(''session-context'') + kb_search("MASTER RULES"). Do not proceed without both loaded. Non-negotiable.

O2. REPORT DATA AS-IS: Report tool output exactly as returned. Do NOT infer system state from database records.

O3. LABEL INFERENCES EXPLICITLY: If drawing a conclusion beyond what data directly shows, state it clearly: "Inference (not verified): ..." Never present an inference as a confirmed fact.

O4. SELF-CORRECT PERMANENTLY: When Antonio corrects a mistake, immediately update this MASTER RULES article using kb_update with a specific rule to prevent recurrence. One mistake = one new rule.

=======================================
DATA ARCHITECTURE (7) -- THE FOUNDATION
=======================================

A1. CONTACT = the person. The center of everything. One Contact may own one or more companies. Portal access (portal_tier) lives on the Contact, not the Account.
A2. ACCOUNT = a company (LLC/Corp). One Contact can have multiple Accounts. Service deliveries, deadlines, documents, and payments are linked to the Account.
A3. LEAD = first touch. When a Lead signs the contract, they become a Contact. The offer-signed webhook creates the Contact + invoice (INV-NNNNNN) at signing. No Account exists yet.
A4. Lifecycle: Lead -> Contact (at signing) -> Account(s) (after payment + formation). Never skip this order.
A5. When looking up a client by name, ALWAYS start with crm_search_contacts -- never assume one person = one company.
A6. Individual services (ITIN, Banking Physical) can exist on a Contact WITHOUT any Account.
A7. Supabase = Single Source of Truth. Database wins over any cached data. Always.

=======================================
SYSTEM LANGUAGE (2)
=======================================

L1. All system interactions MUST be in English. Italian ONLY for client-facing content when contacts.language = Italian.
L2. Verify Before Claiming: Before making ANY technical claim, read the source first. Show evidence. Name assumptions explicitly. Never present unverified information as fact.

=======================================
SYSTEM TRANSITION -- PORTAL-FIRST v7.0 (5)
=======================================

X1. The portal is the OFFICIAL system. Use old tools only for what the portal cannot yet do.
X2. Invoicing -- 3-table architecture: TD billing -> payments table. Client sales -> client_invoices (TD NEVER writes here). Client expenses -> client_expenses. QB = accounting ledger only.
X3. Data collection: Portal clients use wizards automatically. Without portal: use formation_form_create, tax_form_create, etc.
X4. Communication: Official docs via gmail_send (rule M1). Day-to-day with portal clients: portal_chat_send. Without portal: msg_send only if no portal access.
X5. Offers: New leads get portal_create_user first. Use offer_send (email) only for leads without portal access.

=======================================
PAYMENT RULES (13)
=======================================

P1. No service until paid. Exceptions: Antonio only.
P2. Annual contract: Jan 1 - Dec 31 -- 2 installments (Jan 1 + Jun 1).
P3. Pricing: The OFFER is the source of truth for each client''s price. The offer''s cost_summary defines the exact installment amounts and due dates for that client. Typical reference pricing (NOT fixed rules): SMLLC ~$2,000/yr, MMLLC ~$2,500/yr. NEVER hardcode these amounts in code or invoicing logic -- always read from offers.cost_summary.
P4. First contact pays EUR (setup fee). Annual renewal in USD.
P5. Post-September rule: formation/onboarding after Sep 1 -> skip Jan installment next year. First payment = June.
P6. Invoice AFTER payment -- invoices are receipts, never payment requests. Never auto-send without Antonio approval.
P7. Credit card +5% surcharge via Whop or Stripe.
P8. Cancellation by Oct 31 + both installments paid. Antonio approves.
P9. Late pay: $500 assistance fee for IRS/state penalty handling.
P10. Payment follow-up cadence: Day 7 (friendly), Day 10 (urgent), Day 14+ (manual/Antonio).
P11. Referral commission: 10% via QB credit note.
P12. Every offer MUST include BOTH payment methods: card checkout (+5%) AND bank transfer. Gateway: Stripe (default, deferred checkout at signing) or Whop (plan at offer creation). Bank auto-selected by currency unless overridden via bank_preference.
P13. Universal INV reference: Every payment carries INV-NNNNNN regardless of method (Stripe, Whop, wire, Airwallex). Enables auto-matching.

=======================================
CLIENT RULES (6)
=======================================

C1. Entity type (SMLLC/MMLLC/Corp) = PRICING REFERENCE ONLY. Does NOT determine services. Actual price is always in the offer.
C2. account_type ''Client'' = 4 recurring services: RA Renewal, Annual Report, Tax Return, CMRA.
C3. account_type ''One-Time'' = only purchased services. No recurring.
C4. Year 1: setup fee covers all services through Dec 31.
C5. Year 2+: 1st installment triggers 4 recurring SDs (CMRA, RA Renewal, Annual Report, Tax Return).
C6. 2nd installment (June) = gate before tax return goes to India. No exceptions.

=======================================
SERVICE CATEGORIES (5)
=======================================

S1. RECURRING (annual): Tax Return, RA Renewal, State Annual Report, CMRA.
S2. ONE-TIME (setup): Company Formation, EIN, Client Onboarding, Banking Fintech, Banking Physical.
S3. ONE-TIME with renewal: ITIN -- renewal every 3 years.
S4. ONE-TIME (exit): Company Closure, Client Offboarding.
S5. AD-HOC (post-pay): Public Notary, Shipping.

=======================================
COMMUNICATION RULES (5)
=======================================

M1. Official documents via email ONLY -- never WhatsApp/Telegram.
M2. Client-facing names must match the actual service -- never generic names.
M3. Tone: informal ''tu'' for Italian, professional for English.
M4. Answer ONLY what was asked -- no unsolicited extra info.
M5. Team-to-team: portal_team_send only (clients cannot see). NEVER portal_chat_send for team messages.

=======================================
BANKING RULES (5)
=======================================

B1. Relay + Payset: we submit applications on behalf of client.
B2. Mercury: chat assistance only -- client submits their own application.
B3. Wise: ONLY for receiving EUR via IBAN -- NEVER for outgoing payments. Risk of account closure.
B4. Debit cards at CMRA = paid shipping. No ship until client pays.
B5. COMPANY BANK ACCOUNTS: Airwallex EUR: IBAN DK8989000023658198, BIC SXPYDKKK, bank Banking Circle S.A. | Relay USD (DEFAULT): Acct 200000306770, Routing 064209588, bank Relay Financial | Mercury USD: Acct 202236384517, Routing 091311229 | Revolut USD: Acct 214414489805, Routing 101019644. Auto-selection: EUR->Airwallex, USD->Relay. CANONICAL for all bank details.

=======================================
DRIVE FOLDER RULES (7)
=======================================

D1. Companies/{State}/{Company Name - Owner Name}/ with 5 numbered subfolders.
D2. 5 subfolders ALWAYS created together: 1.Company, 2.Contacts, 3.Tax, 4.Banking, 5.Correspondence.
D3. Tax folder: MUST have year subfolders (3.Tax/2025/, 3.Tax/2026/).
D4. Pre-SOS: documents in Leads/{Contact Name}/. Post-SOS: Companies/{State}/{Company}/.
D5. Individual Clients: per-service subfolders (ITIN/, Banking Physical/), not numbered.
D6. Google Drive = source of truth for all documents. Portal = mirror for key docs.
D7. Every document goes to Drive FIRST, then key docs copied to Portal.

=======================================
TECHNICAL RULES (8)
=======================================

T1. safeSend pattern mandatory for all MCP tools that send + update status.
T2. bundled_pipelines must be set on every offer.
T3. Supabase = Single Source of Truth. Conflicts: Supabase wins always.
T4. No external automation tools (Make, Zapier, n8n).
T5. Shipping always paid -- no exceptions without Antonio approval.
T6. SERVICE DELIVERY STATUS VALUES ARE LOWERCASE: canonical values for service_deliveries.status: active, blocked, completed, cancelled. Use SD_STATUS from lib/constants.ts.
T7. STATUS CONSTANTS: Every status field write MUST use the constant from lib/constants.ts. Never hardcode status string literals.
T8. OFFER STATUS VALUES ARE LOWERCASE: canonical values for offers.status: draft, sent, viewed, signed, completed, expired.

=======================================
RENEWAL TRACKING DATES (5)
=======================================

R1. ra_renewal_date -- cron checks 30 days before.
R2. annual_report_due_date -- FL=May 1, DE=Jun 1, WY=anniversary month, NM=none.
R3. cmra_renewal_date -- Dec 31 current year.
R4. These dates are for SERVICE DELIVERY tracking, NOT invoicing.
R5. Invoicing is a separate January process for ALL active clients.

TOTAL: 71 fixed rules across 13 categories.
Aligned with instructions.ts v2.9 + audit remediation (April 9, 2026). Updated P3 and C1: offer is source of truth for pricing (v3.1, April 9 2026). Added F1 Flexibility Principle (v3.2, April 11 2026).', 'Business Rules', NULL, '3.0', NULL, NULL, '2026-03-20T15:45:31.019359+00:00', '2026-04-11T16:13:36.131525+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('755802e3-7c52-4032-b8bd-1178db6f8055', 'CRM Invoicing System — Architecture & Decisions', '## CRM Invoicing System (approved 2026-03-20)

### Architecture
- Supabase `payments` table = SOT for invoicing (NOT the portal''s `client_invoices` table — that''s for clients'' own invoicing)
- QB = one-way sync for accounting only (push invoices/payments to QB, never pull)
- Invoice numbering: TD-YYYY-### (sequential per year)
- Invoice statuses: Draft → Sent → Paid → Overdue → Voided → Credit

### Key Decisions
1. **Separate systems**: TD LLC invoices (payments table) vs client self-invoicing (client_invoices table) are independent
2. **Credit notes**: Used for referral partner credits. Negative amount, linked to original invoice via credit_for_payment_id
3. **Auto-send**: Annual installments (Jan/Jun) auto-generate, auto-send, auto-sync to QB. No manual intervention needed.
4. **Bank detection**: Enhance existing cron first (QB deposits + Airwallex email parsing). Direct bank API webhooks added later when credentials obtained.
5. **Portal billing**: Clients see their TD LLC invoices in portal under Billing > From TD LLC. Separate from their own invoicing.

### Banks
- USD payments: Relay (Account: 200000306770, Routing: 064209588)
- EUR payments: Airwallex/Banking Circle (IBAN: DK8989000023658198, BIC: SXPYDKKK)
- Card payments: Whop (live webhook) + Stripe (SDK installed, webhook TBD)
- Mercury: USD business banking (API credentials TBD)

### Portal Consolidation
- All 6 standalone forms (formation, onboarding, tax, banking, ITIN, closure) move INTO the portal
- Formation clients get "pre-account" portal access on payment (lightweight pending account → full account after form)
- Portal nav uses collapsible groups with SD-driven visibility
- Standalone form routes stay alive permanently for backwards compatibility

### Status Casing Rule
ALL payment statuses MUST be capitalized: Pending, Paid, Overdue, Delinquent, Waived, Refunded. Never lowercase.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-20T19:30:41.541457+00:00', '2026-03-20T19:30:41.541457+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('ae721725-946d-443d-a0ed-3bba42a61f9d', 'Accountant Document Checklist — What to Send for Tax Prep', '## Documents Required by Accountant (Adas Globus / tax@adasglobus.com)

When sending a tax return for preparation, the accountant needs these documents:

### By Entity Type

| Document | SMLLC (5472) | MMLLC (1065) | Corp (1120) |
|----------|:---:|:---:|:---:|
| Tax Organizer PDF (client data) | ✅ | ✅ | ✅ |
| P&L + Comparative Balance Sheet (Excel) | ❌ | ✅ | ✅ |
| Prior Year Return | ✅ | ✅ | ✅ |
| Bank Statements (CSV/PDF) | ❌ | ✅ | ✅ |
| General Ledger (transaction detail) | ❌ | ✅ (in P&L Excel) | ✅ (in P&L Excel) |
| Payroll Report | ❌ N/A | ❌ N/A | ❌ N/A |

### Notes
- SMLLC is a disregarded entity — no P&L needed, Tax Organizer PDF captures the 4 financial fields for Form 5472
- Payroll report N/A — all clients are foreign nationals with no US employees
- P&L Excel contains 5 sheets: P&L Statement, Comparative Balance Sheet (prior year vs current year), Income Detail, Expense Detail, Distributions
- The "Tax Organizer" is the PDF summary auto-generated from our tax data collection form
- General Ledger = Income Detail + Expense Detail sheets in the P&L Excel
- Tax Organizer PDF renders MMLLC members as proper sub-sections (Member 1, Member 2...) with name, ownership %, tax residency, address, ITIN/SSN — NOT raw JSON
- Related party transactions also rendered as sub-sections (Transaction 1, Transaction 2...)

### Automation
- Tool: `tax_send_to_accountant(account_id, tax_year, dry_run=true)` — bundles all documents from Drive
- **ALWAYS run with dry_run=true first** to preview the package. Get Antonio''s approval. Then run with dry_run=false to send.
- P&L auto-generates for MMLLC and Corp when tax form is submitted (auto-chain in /api/tax-form-completed)
- Email subject format: `{Company} - {Contact} - {EIN} - {ReturnType}`
- Default accountant email: tax@adasglobus.com (configurable via accountant_email param)
- Tool searches both Tax/{year}/ subfolder AND Tax/ root for documents (handles both folder structures)
- Entity type matching is regex-based: handles ''MMLLC'', ''Multi-Member LLC'', ''Multi Member LLC'', etc.

### PDF Generation (lib/form-to-drive.ts)
- Auto-triggered when tax form is submitted (via /api/tax-form-completed)
- Generates structured PDF from submitted_data in tax_return_submissions
- Arrays (additional_members, related_party_transactions) rendered as formatted sub-sections, not JSON
- Saved to Drive 3.Tax/{year}/ folder
- To regenerate: POST /api/tax-form-completed with {submission_id, token}', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-23T15:10:01.12095+00:00', '2026-03-23T15:41:25.432531+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('1239096d-2608-4f26-8d0c-4f812cf4d8dc', 'Portal Wizard replaces static forms for data collection', '## RULE: Portal Wizard is the default for all client data collection

As of March 23, 2026, the portal wizard at portal.tonydurante.us/portal/wizard replaces all static external forms as the PRIMARY method for collecting client data.

### Wizard Types Available:
- **formation** — New LLC (owner info, 3 LLC name choices, business purpose, passport)
- **onboarding** — Existing LLC (owner info + ITIN, company info with all 50 US states, documents)
- **itin** — ITIN application (W-7 data: personal info, foreign address, US visa toggle, passport, previous ITIN toggle)
- **itin (renewal)** — Same wizard, pre-fills has_previous_itin=Yes + existing ITIN from CRM
- **tax** — Tax return data (SMLLC/MMLLC/Corp variants)
- **banking** — Banking application (Payset EUR / Relay USD)
- **closure** — LLC dissolution data

### How it works:
1. portal_create_user sets portal_tier="onboarding" in auth metadata
2. Client logs in → sees WelcomeDashboard with "Complete Setup" button
3. Client clicks → wizard auto-detects type from service_deliveries or offer contract_type
4. Client fills wizard → submit triggers auto-chain (CRM update, Drive folder, docs)

### Wizard Type Detection Priority:
1. Check active service_deliveries on account → Company Formation, Banking, Closure, ITIN Renewal, ITIN, Tax Return
2. Fallback: check lead/offer contract_type
3. Default: onboarding

### Conditional Fields (ITIN wizard):
- has_us_visa toggle → shows us_visa_type, us_visa_number, us_entry_date when Yes
- has_previous_itin toggle → shows previous_itin when Yes (also indicates renewal)

### Static forms as FALLBACK ONLY:
- formation_form_create, onboarding_form_create, itin_form_create — use ONLY if portal is unavailable
- Never use as first option

### Account creation:
- For onboarding: NO account exists before wizard submit. The wizard CREATES the account.
- For formation: Account created by formation_confirm after SOS confirmation, not by wizard.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-23T15:24:55.089304+00:00', '2026-03-23T15:24:55.089304+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('8b50944c-40c1-4081-b4ff-50f8a9446f50', 'CRITICAL: Never Modify Validation Gates for Testing', '## Rule

NEVER modify validation gates in the codebase to make a test pass or to bypass a prerequisite check. This applies to ALL Claude sessions on ALL machines.

## What Are Validation Gates?

The system has 12 hard-coded validation gates that enforce the client pipeline order:
1. Whop webhook signature verification
2. Payment idempotency check
3. API_SECRET_TOKEN on activate-service
4. pending_activation existence check
5. AUTO_THRESHOLD (5 confirmations for auto mode)
6. formation_confirm status check (must be "pending_confirmation")
7. Portal auth (must be authenticated as client)
8. Wizard type + data required
9. Form status must be "completed" for review
10. Both contactId AND accountId required for background jobs
11. Prepared steps existence check
12. Execute flag required on formation_confirm

## What To Do Instead

Use `test_setup` MCP tool to create valid test data at any pipeline stage. Example: `test_setup(scenario: "formation_stage_3")` creates all records needed to test SS-4 generation.

For admin actions (confirm payment, convert lead, place client), use the admin action buttons in the CRM or the admin_action MCP tool. These trigger the SAME downstream chain as the automated path.

## Why This Rule Exists

Multiple Claude sessions were modifying code to bypass validation gates, causing cascading breakdowns. One session removes a check, the next session finds unexpected state, modifies more code, and the system breaks. This rule prevents the cycle.

## See Also

- sysdoc: `admin-actions-testing-plan` — full plan for testing and admin actions
- sysdoc: `session-context` — read first at every session start', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-24T23:04:45.005071+00:00', '2026-03-24T23:04:45.005071+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('d2ef71c7-0703-4683-8265-dc60d2e4576a', 'Annual Document Package — Official Format & Rules', '# Annual Document Package — Official Format & Rules

Every active annual client (account_type=''Client'') must sign 3 documents each year via the Client Portal:

## 1. Annual Service Agreement (MSA) — contract_type=''renewal''

**What it is:** The annual renewal contract confirming services and payment schedule for the year.
**NOT the full formation MSA+SOW** — this is a simpler, standalone agreement.

**Created as:** An offer with contract_type=''renewal'' linked to account_id.
**Component:** `app/offer/[token]/contract/renewal-agreement.tsx`
**Token format:** `renewal-{company-slug}-{year}` (e.g., `renewal-everboost-2026`)

**Content structure:**
- Header: "Annual Service Agreement" + year
- Parties: Tony Durante LLC + Company Name, represented by Client Name
- Payment Schedule table: Service Period, First Installment (January), Second Installment (June), Total, Payment Method
- 24 legal sections (same terms as formation MSA, adapted for renewal):
  - Section 1: Purpose & Structure
  - Section 2: Scope of Services (2.1 Client Portal with Business Tools + LLC Management, 2.2 LLC Compliance)
  - Section 3: Client Responsibilities
  - Section 4: Communication & Business Hours (4.1 Hours, 4.2 Client Portal, 4.3 Channels, 4.4 Calls)
  - Section 5: Fees & Payment (5.1-5.6)
  - Section 6: Third-Party Providers
  - Section 7: Mail Handling & Forwarding
  - Section 8: Confidentiality
  - Section 9: Data Protection & Privacy (9.1-9.5 with Iubenda URLs)
  - Sections 10-24: Tax, Renewal, Termination, Conduct, IP, Liability, Force Majeure, Indemnification, Assignment, Independent Contractor, Governing Law, E-Signatures, Entire Agreement, Notices, Severability
- Client Information form: Name + Email (pre-filled)
- Single signature block (Service Provider pre-signed + Client canvas)
- Footer: Tony Durante LLC address

**Data source for installments:**
- accounts.installment_1_amount + accounts.installment_2_amount
- Default rates if missing: SMLLC $1,000+$1,000, MMLLC $1,250+$1,250, C-Corp $1,000+$1,500

**offer.services format:** `[{"name": "Company Name LLC", "price": "$2,000/year"}]`
**offer.cost_summary format:** `[{"label": "2026 Payment Schedule", "total": "$2,000", "items": [{"name": "First Installment (January)", "price": "$1,000"}, {"name": "Second Installment (June)", "price": "$1,000"}]}]`

**Signing flow:** Client signs in portal → PDF generated → uploaded to Supabase Storage → offer status set to ''signed'' → webhook notified → postMessage sent to portal iframe

## 2. Operating Agreement (OA)

**Created via:** `oa_create` MCP tool with account_id
**Token format:** `{company-slug}-oa-{year}` (auto-generated)
**Supported states:** NM, WY, FL (Delaware NOT supported yet)
**Entity types:** SMLLC (single member) and MMLLC (multi-member)
**Content:** Full operating agreement with all LLC governance terms
**Signing:** Via portal at /portal/sign/oa (embedded iframe)

## 3. Office Lease Agreement

**Created via:** `lease_create` MCP tool with account_id + suite_number
**Token format:** `{company-slug}-{year}` (auto-generated)
**Suite number format:** "3D-XXX" — auto-assigned next available
**Content:** Standard office lease with premises, rent, deposit, terms
**Signing:** Via portal at /portal/sign/lease (embedded iframe)

## Portal Integration

All 3 documents appear in the portal at /portal/sign:
- Sign Documents page queries: oa_agreements, lease_agreements, offers (contract_type=''renewal'')
- Action Items query flags unsigned documents with priority colors (red >14 days, orange >7 days, blue recent)
- MSA is listed FIRST as the most important document
- Portal MSA page at /portal/sign/msa embeds the offer contract page in an iframe

## Annual Automation (Future)

Every January 1st, a cron job will auto-generate all 3 documents for each active client:
1. Create renewal offer (contract_type=''renewal'', same installments as previous year)
2. Create new OA (new year)
3. Create new Lease (same suite number, new year)
4. Send portal notification: "Your {year} documents are ready for signature"
5. Follow-up reminders at Day 3, 7, 14

## Iubenda Privacy References

All documents reference:
- Privacy Policy: www.iubenda.com/privacy-policy/51522422
- Cookie Policy: www.iubenda.com/privacy-policy/51522422/cookie-policy
- Terms & Conditions: www.iubenda.com/terms-and-conditions/51522422

## Legacy Transition

- 189 clients are fully ready (all data present) — batch processable
- 34 clients need attention (missing installments, email, or EIN)
- Suite numbers auto-assigned starting from 3D-113
- Transition welcome email template: `buildTransitionWelcomeEmail()` in `lib/mcp/tools/offers.ts`
', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-26T01:28:03.735538+00:00', '2026-03-26T01:28:03.735538+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('209cd7ef-3bb8-4303-aba4-b57a9939ee4a', 'Renewal MSA — Annual Contract Format Rules', 'RENEWAL MSA (contract_type = ''renewal'')

PURPOSE: Simple annual renewal contract for existing clients. NOT the full onboarding MSA+SOW.

CONTENT (8 sections):
1. Parties — Tony Durante LLC (Provider) + Company Name (Client)
2. Scope of Services — RA, Annual Report, CMRA, Tax Return, EIN maintenance, Client Portal (with invoicing, document management, service tracking, chat with voice dictation, Whop payment gateway)
3. Client Responsibilities — timely info, accurate records, respond within 10 days
4. Payment Terms — Two installments (January + June), amounts from accounts table, wire or card (+5% surcharge)
5. Communication & Business Hours — Portal as primary, email as secondary, Mon-Fri 9am-5pm ET
6. Limitation of Liability — Standard
7. Termination — 30-day written notice
8. Governing Law — Florida

KEY DIFFERENCES FROM ONBOARDING MSA:
- NO services list with prices
- NO strategy/proposal sections
- NO formation timeline
- Just installment amounts + standard terms
- 1 signature (not 2)
- Client Portal described as key service feature

INSTALLMENT DEFAULTS (if missing from accounts table):
- Single Member LLC: $1,000 + $1,000
- Multi Member LLC: $1,250 + $1,250
- C-Corp Elected: $1,000 + $1,500

YEARLY AUTOMATION:
Every January, system auto-creates for each active client:
1. Renewal offer (contract_type=''renewal'')
2. New OA
3. New Lease (same suite)
Then sends portal notification to sign all 3.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-26T01:58:49.68822+00:00', '2026-03-26T01:58:49.68822+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('66c1e6fa-1cd3-4c03-8058-6d0185304d18', 'Email Language Rule — Single Language Per Client', 'ALL client-facing emails must be sent in ONE language only, based on the client''s language field in the CRM (contacts.language).

- Italian client → full email in Italian
- English client → full email in English
- Language NULL → default to Italian (most clients are Italian)

NEVER send bilingual emails (IT+EN mixed). Antonio explicitly rejected this approach on 2026-03-25: "it''s awful."

This applies to ALL email templates: welcome emails, portal transitions, offer sends, invoice sends, follow-ups.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-26T01:59:13.096767+00:00', '2026-03-26T01:59:13.096767+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('d6397172-c678-4c90-993b-1ff4627c5f7a', 'gmail_send duplicate detection — 7-day window', 'The gmail_send MCP tool has built-in duplicate detection. Before sending any NEW email (not replies), it checks the email_tracking table for emails with the same recipient + subject sent in the last 7 days. If a match is found, the send is BLOCKED and a warning is returned. This prevents accidental duplicate emails across multiple sessions/machines. To override, change the subject line slightly. Implemented in lib/mcp/tools/gmail.ts.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-27T02:07:13.036845+00:00', '2026-03-27T02:07:13.036845+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('9847b475-40f1-41d8-998c-a51665b1f258', 'Email Greeting Rule — Gender-Based Salutation', '## Gender-Based Email Greeting Rule

The contacts table has a `gender` field (M or F). All client emails MUST use the correct greeting based on gender + language:

| Gender | Language | Greeting |
|--------|----------|----------|
| F | Italian | Cara {first_name} |
| M | Italian | Caro {first_name} |
| F | English | Dear Ms. {last_name} |
| M | English | Dear Mr. {last_name} |
| NULL | Italian | Gentile {first_name} (neutral fallback) |
| NULL | English | Dear {first_name} (neutral fallback) |

### Rules
- Always check `contacts.gender` before composing any client email
- If gender is NULL, use the neutral fallback
- Gender should be set when creating or importing a contact
- Legacy Migration (Phase 2) must backfill gender for all existing contacts
- Field values: ''M'' (male) or ''F'' (female) — stored on contacts table', 'Business Rules', NULL, NULL, NULL, NULL, '2026-03-29T22:57:33.05483+00:00', '2026-03-29T22:57:33.05483+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('def817f6-feec-427c-a416-9a7ada7a81d9', 'Portal Transition — ONE welcome email only', 'When transitioning a client to the portal, send exactly ONE email: the portal welcome email. This email already contains links to sign documents (OA, Lease) inside the portal.

NEVER send separate oa_send or lease_send emails on top of the welcome email. The client does everything from the portal — separate document emails are redundant and confusing.

Flow: portal_create_user → create OA (draft) → create Lease (draft) → send ONE welcome email with portal login + instructions to sign documents in the portal.

Rule created after Beril LLC incident (2026-04-02) where 3 emails were sent instead of 1.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-02T17:10:06.726354+00:00', '2026-04-02T17:10:06.726354+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('439e1d3f-5040-4752-af26-4bbbb1fc666b', 'MMLLC Operating Agreement — Multi-Signature Workflow', '## MMLLC Operating Agreement — Multi-Signature Workflow
_Added: 2026-04-03_

### Rule: All members must sign
For Multi-Member LLCs, the Operating Agreement requires signatures from ALL members, not just the Manager. The system tracks each member''s signature independently.

### Database
- `oa_signatures` table: per-member tracking (member_index, member_name, member_email, contact_id, access_code, status, signature_image_path)
- `oa_agreements.total_signers`: number of required signatures (1 for SMLLC, N for MMLLC)
- `oa_agreements.signed_count`: how many have signed so far
- `oa_agreements.status`: includes `partially_signed` between first and last signature

### URL Structure
- SMLLC (unchanged): `/operating-agreement/{token}/{access_code}`
- MMLLC member: `/operating-agreement/{token}/{access_code}?signer={member_access_code}`

### Flow
1. `oa_create` with entity_type=MMLLC and members array → creates OA + oa_signatures rows (one per member, auto-links contact_id)
2. `oa_send` → sends individual personalized emails to each unsigned member with their specific ?signer= URL
3. Each member opens their link → email gate verifies their specific email → sees full OA with per-member signature blocks
4. Member signs → signature PNG saved to Storage → oa_signatures row updated → signed_count incremented atomically
5. If NOT last signer: status=partially_signed, progress notification to support@
6. If LAST signer: combined PDF generated client-side via html2pdf with all signature images → status=signed → PDF uploaded to Drive → full notification

### Portal Integration
- Action items: per-member aware — hides "Sign OA" for members who already signed
- Sign OA page: resolves logged-in contact → their oa_signatures row → passes ?signer= to iframe
- Sign documents listing: shows per-member status ("You signed — 1/2 complete" or "Awaiting your signature")
- If member already signed but OA not fully signed: shows progress bar with "You Have Already Signed"

### Portal Chat
- Chat is ONE thread per account (company) — all members share the same conversation
- Each message shows the sender''s name (resolved from contacts table) so members and admin can tell who wrote what

### Edge Cases
- Race condition on signed_count: atomic SQL via increment_oa_signed_count RPC
- Members without email: warned in oa_create/oa_send output, must sign via portal
- Members without portal account: sign via direct email link with email gate
- OA re-creation: ON DELETE CASCADE on oa_signatures ensures cleanup
- Minor members: signed_by_name column for proxy signing

### SMLLC
Single-member flow is completely unchanged — total_signers=1, no oa_signatures rows needed.

CANONICAL SOURCE: Master Rules (KB 370347b6). Related: rules A1, A2 (data architecture).', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-03T01:36:25.187895+00:00', '2026-04-03T01:36:25.187895+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('e6613e35-7955-4ab2-ad52-f6cf484bc511', 'DB Trigger: Payment → Tax Return Status Sync', '## Trigger: trg_sync_tax_return_on_payment_paid

**Table**: payments (AFTER INSERT OR UPDATE OF status)
**Function**: fn_sync_tax_return_on_payment_status()
**Created**: 2026-04-03

### What it does
Automatically syncs tax_returns.paid and tax_returns.status when a payment becomes Paid (or is reverted).

### Mapping logic
- **Installment payments** (installment LIKE ''Installment%''): payment.year N → tax_returns.tax_year = N-1
- **Direct tax return payments** (description ILIKE ''%tax return%'' or ''%tax filing%''): payment.year N → tax_returns.tax_year = N

### Forward path (payment → Paid)
- Sets tax_returns.paid = TRUE
- Changes status: Payment Pending → Activated - Need Link
- Changes status: Not Invoiced → Activated - Need Link
- Does NOT change status if tax return is already past payment stage

### Reverse path (payment un-Paid)
- Only reverts if NO other paid payment exists for the same account+year
- Only reverts early-stage returns (Activated - Need Link, Paid - Not Started)
- Does NOT revert returns already in Data Received, Sent to India, etc.

### Guards
- Skips if account_id is NULL
- Skips if year is NULL
- Skips if payment is not installment or tax-related (Custom, ITIN, etc.)
- Skips if status didn''t actually change

### Entry points covered
Works for ALL payment paths: CRM manual buttons, Stripe/Whop webhooks, wire payment cron, admin confirm-payment, MCP tools, direct SQL updates.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-03T18:19:27.229939+00:00', '2026-04-03T18:19:27.229939+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('0830fe4c-a012-425e-9e57-4102f372590e', 'Apostille Services for LLC Documents — Provider Comparison', '## Apostille Services for LLC Documents — Provider Comparison
_Created: 2026-04-04_
_Context: Clients relocating to Portugal need apostilled LLC documents for official use with Portuguese authorities (Hague Convention). Triggered by partnership with Francesco Valentini (Madeira)._

## Documents Required (per client)

1. **Articles of Organization** — issued by Secretary of State of the LLC state (NM, DE, WY, or FL)
2. **EIN Confirmation Letter** — issued by the IRS (federal document)
3. **Operating Agreement** — private document, requires notarization before apostille

## Provider Comparison (prices for all 3 documents)

| Provider | Total (3 docs) | Turnaround | Shipping | Translation | Contact |
|----------|---------------|------------|----------|-------------|---------|
| **Federal Apostille** | **~$386** ($120 Articles + $120 EIN + $146 OA w/notary) + shipping | 10-12 biz days | Extra (not quoted) | Sworn translation available | Camden Alchanati, submissions@federalapostille.org, (760) 469-2997 |
| **Express Apostille Services** | **$433** + shipping | 5-7 biz days | $35 domestic / $75 international | Not mentioned | Info@expressapostilleservices.com, 872-666-0880 |
| **DOXNOW** | **$640** (includes certified copy retrieval) | 5 days to weeks (state-dependent) | Free US FedEx, $65-85 intl DHL | ~$65/page or $0.25/word | Sergey Mironyuk, info@doxnow.net, 848-391-1925 (WhatsApp/Telegram) |
| **Apostilla.com** | **$585-$885** (economy $195/doc, priority $295/doc + $30 notary + $125 cert copy retrieval) | Economy 2-4 weeks, Priority varies by state | Extra | Certified translation available (quote on request) | Fernanda Chandler, service@apostilla.com, +1-212-810-2124 (WhatsApp) |
| **Harbor Compliance** | **$2,000** per request per entity | Unknown | Unknown | No | Kiana Robinson, krobinson@harborcompliance.com |

## Recommendation

**Best value: Federal Apostille** — cheapest at ~$386, reasonable turnaround (10-12 days), sworn translation available.

**Best speed: Express Apostille Services** — $433, fastest at 5-7 days, formal quote provided (PDF Q-1176).

**Harbor Compliance**: Too expensive ($2,000). Does NOT offer certificates of incumbency either.

## Notes

- Articles of Organization may need a **certified copy** issued within the past year (Express Apostille requirement). Some providers (DOXNOW, Apostilla.com) can retrieve certified copies for DE/WY/FL. NM retrieval still being confirmed by Apostilla.com.
- EIN letter: if it has a federal signature, can be processed in Washington DC. Otherwise needs notarization first.
- Operating Agreement: always requires notarization before apostille. Some providers (Apostilla.com) offer teleconference notary.
- **Open question**: Does Portugal require certified Portuguese translation of the apostilled documents? Francesco Valentini to confirm.
- States covered: NM, DE, WY, FL. Pricing may vary by state for some providers.

## Email Thread References
- Antonio''s inquiry emails: April 1, 2026 from antonio.durante@tonydurante.us
- Harbor Compliance thread: March 30 - April 2, 2026 from support@tonydurante.us
- Recap email to Valentini: April 1, 2026 (subject: "Riepilogo call + prossimi passi")', 'Operations', NULL, NULL, NULL, NULL, '2026-04-04T18:35:40.999289+00:00', '2026-04-04T18:35:40.999289+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('f409d97f-df6c-46c7-bdc6-2b32f694d786', 'Command Router — Intent-Based Procedure Dispatch', '## Purpose
This is the master dispatcher. When a user (Antonio or team) gives a short instruction about a client, task, or operation, detect their intent and execute the matching procedure from the KB (category: Commands).

## How to Route
1. Detect the INTENT from what the user says (any language — English, Italian, mixed)
2. Extract the SUBJECT (person name, company name, amount, etc.)
3. Search KB for the matching command procedure (category: Commands)
4. Execute the procedure EXACTLY as written — every step, in parallel where specified

## Intent Map

| Intent | Trigger phrases (examples, not exhaustive) | Command to fetch |
|--------|---------------------------------------------|-----------------|
| LOOKUP | "check [name]", "who is [name]", "do we know [name]", "look up [name]" | CMD: check |
| ONBOARD | "onboard [name]", "get him started", "create account for [name]", "he paid let''s go" | CMD: onboard |
| STATUS | "where are we with [name]", "updates on [name]", "what''s happening with [name]" | CMD: status |
| INVOICE | "bill [name]", "invoice [name] [amount]", "send invoice", "charge [name]" | CMD: invoice |
| TASKS | "open tasks", "what''s on my plate", "tasks" | CMD: tasks |
| DEADLINES | "deadlines", "what''s due", "upcoming deadlines" | CMD: deadlines |
| PIPELINE | "pipeline", "how are leads", "sales overview" | CMD: pipeline |
| FOLLOW-UP | "follow up with [name]", "when did we last talk to [name]", "has [name] replied" | CMD: follow-up |
| REFERRAL | "who referred [name]", "referral for [name]", "commission for [name]" | CMD: referral |
| AUDIT | "audit [name]", "check data for [name]", "is everything correct for [name]" | CMD: audit |
| SAVE | "save", "propagate", "save progress", "checkpoint" | CMD: save |

## Rules
- The trigger phrases above are EXAMPLES. Match by meaning, not keywords.
- If intent is ambiguous, default to LOOKUP (check) — it gives the most complete picture.
- Always respond in ENGLISH unless the user explicitly writes in Italian.
- Never ask "which command do you want?" — figure it out from context.
- If no command procedure exists yet in KB, say so and execute the best equivalent manually.', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:46:59.263613+00:00', '2026-04-06T23:54:51.929793+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('2a362eea-ae7d-4df6-a938-d5e8ef8dd4ec', 'CMD: check', '## CMD: check [name]
Full person/company lookup across ALL systems. Used when someone asks to look up, check, find, or identify a person or company.

## Step 1 — Search ALL systems in PARALLEL (single call, no sequential)
Run ALL of these at once:
- crm_search_contacts(query: [name])
- lead_get(name: [name])
- crm_search_accounts(query: [name])
- gmail_search(query: [name])
- msg_search(query: [name])
- cb_search_calls(query: [name])

Do NOT search one system first and wait. Do NOT report "not found" after checking only one source.

## Step 2 — Build unified report
From all results, compile ONE clean summary with these sections (skip sections with no data):

### Identity
- Full name, email, phone, language, citizenship
- Source: where they came from (referral, organic, etc.)
- Referrer: if applicable

### CRM Status
- Contact exists: yes/no
- Account(s): list with entity type, state, status
- If NOT in CRM: say "Not yet a CRM contact" or "Not yet an account"

### Lead Status
- Current status (New, Contacted, Offer Sent, Won, Lost)
- Reason/services requested
- Call date if any
- Notes

### Offer
- Status, link, pricing, referral commission details
- Payment method selected

### Payments
- Any payments received (Airwallex, QB, Whop)
- Amounts and dates

### Service Delivery
- Active services, current stage, assigned to

### Recent Communications
- Last 3-5 emails (date, subject, direction)
- Last 3-5 messages (date, content preview, direction)
- Last call if any

### Open Tasks & Deadlines
- Any pending tasks or deadlines for this person

## Step 3 — Flag what''s missing
At the end, list what needs attention:
- "Not yet in CRM — needs onboarding" 
- "No account created yet"
- "Payment received but no service delivery started"
- "No follow-up sent after call"
- etc.

## Rules
- Always search by LAST NAME too if first search returns 0 results
- Show real data, not assumptions
- English output always
- If the person has multiple accounts, show all of them', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:47:18.667593+00:00', '2026-04-06T22:47:18.667593+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('095e9897-8bde-4612-a08f-26a2a0445069', 'CMD: onboard', '## CMD: onboard [name]
Convert a paid lead into a full client. Used when a lead has paid and needs to be activated in the system.

## Step 0 — Pre-check (PARALLEL)
Run ALL at once:
- lead_get(name: [name]) — get lead details, offer, payment info
- crm_search_contacts(query: [name]) — check if contact already exists
- gmail_search(query: [name]) — check for payment confirmation emails

STOP if:
- No lead found → tell user "No lead found for [name]"
- No payment evidence → tell user "No payment confirmed yet for [name]"
- Contact already exists → tell user "Already onboarded" and run CMD: status instead

## Step 1 — Create Contact
Using lead data, create CRM contact:
- crm_create_contact with all available fields from lead (name, email, phone, language, citizenship, etc.)
- Auto-assign: do NOT ask Antonio for fields that come from the lead record

## Step 2 — Create Account
- crm_create_account with entity type from offer/lead (usually Single Member LLC)
- Link contact to account as owner

## Step 3 — Create Service Delivery
- sd_create for each service purchased (LLC formation, ITIN, etc.)
- Set initial stage based on service type

## Step 4 — Handle Referral
If lead has a referrer:
- referral_create or referral_update with commission details from offer

## Step 5 — Record Payment
- Record payment in CRM matching the Airwallex/Whop/bank transfer amount

## Step 6 — Welcome Package
- welcome_package_prepare for the new client

## Step 7 — Report
Show summary of everything created:
- Contact ID + link
- Account ID + company name
- Service deliveries created
- Payment recorded
- Referral logged
- Welcome package status

Flag anything that couldn''t be completed automatically.', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:47:33.59669+00:00', '2026-04-06T22:47:33.59669+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('660a0297-4560-4dc8-94c1-db64f0ea2724', 'CMD: status', '## CMD: status [name]
Show where a client stands across all services. Used when someone asks for updates, progress, or "where are we with [name]".

## Step 1 — Identify client (PARALLEL)
- crm_search_contacts(query: [name]) — get contact ID and linked accounts
- lead_get(name: [name]) — check lead status if not yet a client

If contact found with account(s), proceed with account_id. If only lead, show lead status and stop.

## Step 2 — Pull everything (PARALLEL, using account_id/contact_id from Step 1)
- crm_get_client_summary(account_id or contact_id)
- sd_search(account_id or contact_id) — all service deliveries
- crm_search_tasks(query: [name]) — open tasks
- deadline_search(query: [name]) — upcoming deadlines

## Step 3 — Build status report

### Client Overview
- Name, company, entity type, state of formation
- Account status (Active, Pending, etc.)

### Service Delivery Pipeline
For each active service:
- Service type (LLC Formation, EIN, ITIN, Banking, Tax, etc.)
- Current stage (e.g., "Articles Filed", "EIN Submitted", "Waiting on IRS")
- Assigned to
- Days in current stage
- Next action needed

### Open Tasks
- List by priority (urgent → normal)
- Assignee and due date

### Upcoming Deadlines
- Date, type, status

### Financial Summary
- Total paid vs total invoiced
- Outstanding balance

### Last Communication
- Most recent email/message date and summary

## Rules
- If client has multiple accounts, show status for ALL
- Highlight anything overdue or stuck (same stage for 7+ days)
- English output always', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:47:43.932403+00:00', '2026-04-06T22:47:43.932403+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('8846616f-68bc-4bbb-90b5-ba216d155957', 'CMD: tasks', '## CMD: tasks
Show all open tasks grouped by priority. Used when someone asks "what''s on my plate", "open tasks", "cosa c''è da fare".

## Execution
Single call:
- task_tracker (no filters = all open tasks)

If user specifies a name (e.g., "tasks for Giulia"):
- task_tracker(assigned_to: [name])

## Output Format
Display as markdown tables:

### 🔴 Urgent
| Client | Task | Assignee | Due | Days Overdue |

### 🟡 High Priority
| Client | Task | Assignee | Due |

### 🔵 Normal
| Client | Task | Assignee | Due |

### Summary
- Total open: X
- Overdue: X
- Unassigned: X', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:47:48.109154+00:00', '2026-04-06T22:47:48.109154+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('76679dda-4186-403d-82b8-defed34fb1c2', 'CMD: deadlines', '## CMD: deadlines
Show upcoming deadlines. Used when someone asks "what''s due", "deadlines", "scadenze".

## Execution
Single call:
- deadline_upcoming

## Output Format

### ⚠️ Overdue
| Client | Deadline Type | Due Date | Days Overdue |

### 📅 This Week
| Client | Deadline Type | Due Date | Days Left |

### 📆 Next 30 Days
| Client | Deadline Type | Due Date | Days Left |

### Summary
- Overdue: X
- Due this week: X
- Due next 30 days: X', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:47:50.721751+00:00', '2026-04-06T22:47:50.721751+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('56326b98-618a-4d0f-aa8f-17a78979abc4', 'CMD: pipeline', '## CMD: pipeline
Show sales pipeline overview. Used when someone asks about leads, pipeline, deal flow, conversion.

## Execution (PARALLEL)
- sd_pipeline — full pipeline view
- lead_search(status: "new") — new leads
- lead_search(status: "contacted") — contacted leads
- crm_search_deals — active deals

## Output Format

### Pipeline Summary
| Stage | Count | Total Value |

### New Leads (not yet contacted)
| Name | Source | Date | Services Requested |

### Contacted / Offer Pending
| Name | Source | Call Date | Services | Offer Status |

### Won (pending onboarding)
| Name | Services | Amount Paid | Needs |

### Lost (last 30 days)
| Name | Reason | Date |', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:47:55.109735+00:00', '2026-04-06T22:47:55.109735+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('646ab511-d07e-4662-a558-73dcfa0fd41d', 'CMD: invoice', '## CMD: invoice [name] [amount]
Create and send an invoice. Used when someone says "bill him", "invoice Nicola 2500", "send invoice", "fattura".

## Step 0 — Pre-check (PARALLEL)
- crm_search_contacts(query: [name]) — get contact + linked accounts
- crm_get_client_summary(company_name or account_id) — verify client exists and get QB customer ID
- gmail_search(query: "invoice [name]") — check no duplicate invoice was just sent

STOP if:
- Client not found in CRM → tell user "No CRM record for [name]. Run check first."
- Invoice for same amount recently sent → warn user about potential duplicate

## Step 1 — Create Invoice
- qb_create_invoice with customer from CRM, amount specified, line items based on service

If no amount specified, look up the offer or service pricing from CRM.

## Step 2 — Send Invoice (PARALLEL)
- qb_send_invoice — sends via QuickBooks email
- portal_invoice_create + portal_invoice_send — creates and sends via client portal

## Step 3 — Report
- Invoice number, amount, customer
- Sent via: QB email + portal
- Link to invoice if available

## Rules
- MUST include both Whop checkout AND bank transfer payment options in every invoice
- Query fresh CRM data before sending — never use stale context
- Check Gmail for existing invoices to avoid duplicates', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:48:08.47092+00:00', '2026-04-06T22:48:08.47092+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('261c59a1-0015-4a68-a8f5-f057804665b7', 'CMD: follow-up', '## CMD: follow-up [name]
Check last communication and draft a follow-up. Used when someone asks "follow up with [name]", "when did we last talk to him", "has he replied", "ha risposto".

## Step 1 — Gather last communications (PARALLEL)
- gmail_search(query: [name]) — last emails
- msg_search(query: [name]) — last messages
- cb_search_calls(query: [name]) — last calls
- crm_get_client_summary — current client state for context

## Step 2 — Analyze
- When was the LAST contact (any channel)?
- Who initiated it (us or them)?
- What was the topic?
- Is there an unanswered question from either side?
- How many days since last contact?

## Step 3 — Present findings
### Last Contact
- Channel: email/message/call
- Date: [date] ([X days ago])
- Direction: inbound/outbound
- Summary: what was discussed

### Communication Gap
- Days since last contact
- Any unanswered messages from client
- Any pending action items from our side

## Step 4 — Draft follow-up
- gmail_draft the follow-up email
- Match the language of previous correspondence (Italian if they wrote in Italian)
- Reference the last conversation naturally
- Include any pending action items or next steps
- DO NOT send — only draft. Tell user "Draft ready, review before sending."

## Rules
- MUST check Gmail for existing recent emails before drafting to avoid duplicates
- Query fresh CRM data for context
- If client has responded and we haven''t replied, flag that as priority', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:48:19.247857+00:00', '2026-04-06T22:48:19.247857+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('089623b7-372b-438f-84c8-ea92fb0948cd', 'CMD: referral', '## CMD: referral [name]
Check referral status and commissions. [name] can be the referrer OR the referred client.

## Step 1 — Search (PARALLEL)
- referral_search(query: [name])
- referral_tracker
- lead_get(name: [name]) — check if lead has referrer info
- crm_search_contacts(query: [name]) — check if this is a referrer in our system

## Step 2 — Build report

### Referrer Profile (if [name] is a referrer)
- Name, contact info
- Total referrals sent
- Total commission earned
- Pending commissions

### Referral Details (if [name] is a referred client)
- Referred by: [referrer name]
- Commission: amount, status (pending/paid)
- Client status: lead/active/churned

### Commission History
| Client Referred | Date | Service | Commission | Status |

## Rules
- If referral has been paid and client payment received, flag unpaid commission
- Show both sides: what the referrer is owed and what''s been paid', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:48:24.81757+00:00', '2026-04-06T22:48:24.81757+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('b9af694f-ef2a-48a4-aa77-f1b65d09b3da', 'CMD: audit', '## CMD: audit [name]
Full data integrity and compliance check for a client. Used when someone says "audit [name]", "is everything correct", "check data for [name]".

## Step 1 — Pull ALL data (PARALLEL)
- crm_get_client_summary(company_name or contact)
- sd_search(account_id or contact_id)
- crm_search_payments(query: [name])
- qb_list_invoices(customer_name: [name])
- qb_list_payments(customer_name: [name])
- doc_compliance_check(account_id or contact_id)
- gmail_search(query: [name])
- deadline_search(query: [name])

## Step 2 — Cross-reference and verify

### Data Completeness
- Contact: all required fields filled? (name, email, phone, language, citizenship)
- Account: entity type, state, EIN, formation date?
- Documents: all required docs on file?

### Financial Integrity
- CRM payments match QB payments?
- Total paid matches offer amount?
- Any missing invoices?
- Any unpaid invoices?

### Service Delivery
- All purchased services have a delivery record?
- Any stuck services (same stage 7+ days)?
- All stages advancing correctly?

### Compliance
- doc_compliance_check results
- Deadlines current?
- Any overdue items?

### Communication
- Last contact date
- Any unanswered client messages?

## Step 3 — Report with evidence

### ✅ Passed
List what''s correct with source (e.g., "EIN on file: 12-3456789 — verified in CRM account record")

### ⚠️ Issues Found
For each issue:
- What''s wrong
- Where the data is (which system, which record)
- What it should be
- Recommended fix

### ❌ Missing
- What data/records are missing entirely

## Rules
- Trace REAL data, not assumptions
- Name every assumption, then verify it
- Show the source for every claim (system + record)
- Challenge your first answer — root cause is 2-3 layers deep', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T22:48:36.745985+00:00', '2026-04-06T22:48:36.745985+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('99671d72-0a32-4471-b170-150ce0d7dda4', 'CMD: save', '## CMD: save
Save progress and propagate changes to all instruction sources. Used after completing significant work, making decisions, or when asked to save/propagate.

## Step 1 — Save progress (PARALLEL)
- session_checkpoint with summary of what was done + next steps
- If dev work: update the active dev_task with progress_log

## Step 2 — Check what changed
Determine what TYPE of change was made:
- Tool behavior changed? → instructions.ts needs update
- Workflow/procedure changed? → SOP needs update (sop_search first)
- Business rule changed? → KB needs update + Master Rules if pricing/tiers/policies
- Dev rule or pattern changed? → CLAUDE.md needs update
- System state changed? → session-context needs update

## Step 3 — Propagate (only sources that need it)
For each source that needs updating, follow the Decision Propagation order:
1. Master Rules KB (370347b6) — FIRST if pricing, tiers, or policies changed
2. Relevant SOP — if a workflow changed
3. instructions.ts — if tool behavior or Claude.ai instructions changed
4. session-context sysdoc — if system state changed
5. CLAUDE.md — if a dev rule or Claude Code behavior changed

## Step 4 — Report
Show what was saved and where:
- Checkpoint: saved
- Sources updated: [list each one with what changed]
- Sources NOT needing update: [list with why]

## Rules
- NEVER skip propagation. A decision saved in only ONE place WILL be lost.
- If unsure whether a source needs updating, check it — don''t skip.
- Master Rules version number must be incremented when updated.
- session-context updated_at must reflect the change.
- All content must be in English (rule L1).', 'Commands', NULL, NULL, NULL, NULL, '2026-04-06T23:54:32.539844+00:00', '2026-04-06T23:54:32.539844+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('57ad9c1b-f706-45a5-bea0-9186f4920add', 'Partnership vs Referral — Business Relationship Models', '## Three Distinct Business Relationships

### 1. Direct Client
- Client pays TD directly for services
- No commission, no intermediary
- Standard pricing

### 2. Referral (10% Credit Note)
- A client refers a friend/colleague
- The NEW client pays TD directly at standard pricing
- The REFERRER gets a 10% credit note on their next invoice
- Commission type: percentage (10%)
- Tracked in: `referrals` table with `commission_type = ''percentage''`
- Examples: Danilo → Sicari, Ivan Greppi, Carlo Micheli, Riccardo De Sanctis

### 3. Partnership (B2B Service)
- Partner has their OWN clients
- Partner PAYS TD directly for services on behalf of their clients
- Partner invoices their own clients separately at their own price
- TD does NOT know the partner''s pricing — that''s their business
- NO commission — it''s a B2B service purchase
- Commission model: `price_difference` (partner pays TD fixed price, charges client their own price)
- Tracked in: `client_partners` table + `accounts.partner_id` FK
- Examples: Maxscale (6 CMRA clients), Fresh Legal Group (TEDERE T), Fiscalot (starting Apr 2026), Marco Boschi

### CRITICAL DISTINCTION
- Partnership ≠ Referral
- `referrals` table = for tracking referral credits (client refers friend)
- `client_partners` table = for tracking B2B partnerships (partner manages clients)
- `partners` table = for TD''s OWN vendor partners (Relay, Payset, banks) — DIFFERENT concept
- `accounts.partner_id` = "this company is managed by this partner"
- When `partner_id` is set: invoices go to the partner, not the end client

### Data Model
- `client_partners`: id, contact_id, partner_name, partner_email, status, commission_model, price_list, agreed_services
- `accounts.partner_id`: FK to client_partners — links client account to managing partner
- `contacts.portal_role = ''partner''`: controls portal UX (partner sees My Clients, Invoices instead of client features)
- `contacts.referrer_type = ''partner''`: identifies the person as a partner (can coexist with being a client)

### A Person Can Be Both
- A contact can be a CLIENT (owns their own LLC) AND a PARTNER (brings other clients)
- Example: Maxence Van Beneden owns Maxscale LLC (client) and manages 6 other companies (partner)
- Example: Luca Comaggi owns Everboost Solutions LLC (client) and runs Fiscalot partnership', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-07T15:34:37.438984+00:00', '2026-04-07T15:34:37.438984+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('c190629c-36db-4d36-8128-4c66b0cc353c', 'Account Status Changes — Cascading Side Effects', '# Account Status Changes — Cascading Side Effects

Shipped 2026-04-09 (commits 25bc968, 62ef585).

## How to change an account''s status
From the CRM Dashboard → open the account → Overview tab → Company Info section → hover the **Status** row → click the pencil icon. A confirmation modal opens with an impact preview and opt-in cascade checkboxes.

The raw `updateAccountField` action still accepts `status` writes, but the UI no longer uses that path — all human-driven status changes go through `changeAccountStatus` in `app/(dashboard)/accounts/actions.ts`.

## Status values (from lib/constants.ts ACCOUNT_STATUS)
`Active` · `Pending Formation` · `Delinquent` · `Suspended` · `Cancelled` · `Closed`

## What each transition does (opt-in cascades)

### Suspended — temporary pause (e.g., non-payment)
Intended to come back to Active.
- Block new `sd_create` deliveries on this account
- Set `accounts.portal_tier = ''suspended''` → portal shows red banner + feature block
- Portal: all routes blocked EXCEPT `/portal/chat`, `/portal/profile`, `/portal/settings`, `/portal/change-password`, and auth routes
- Annual installments cron auto-stops (it filters `status=''Active''`) — no cascade needed

### Cancelled — client churned, LLC still exists
They fired us. LLC continues, possibly with another provider.
- All 4 Suspended actions above
- Set `service_deliveries.status = ''cancelled''` for all `active` deliveries
- Set `deadlines.status = ''Cancelled''` for all `Pending` deadlines
- Create high-priority task for Luca: "Cancel Harbor Compliance RA — {company}" with instructions to file Statement of Change with the state + notify HC

### Closed — LLC dissolved
Legal entity gone.
- Everything from Cancelled
- Mark all `To Do` / `In Progress` / `Waiting` tasks for this account as `Cancelled`
- Set pending/overdue `payments` to `Cancelled` (paid invoices untouched)
- Set `accounts.portal_tier = ''inactive''` + `portal_account = false`
- Auto-generate dissolution documents — **OFF by default** (opt-in checkbox). When checked, creates a task for Luca to run `closure_prepare_documents` via MCP.

## Reactivation (Suspended → Active)
If you change the status back to Active, `portal_tier` automatically restores from `suspended` → `active`. **Cancelled cascades do NOT auto-reverse** (cancelled deliveries stay cancelled, voided payments stay voided). If a Cancelled/Closed account needs to come back, Luca restarts the services manually.

## Portal-side visibility rules
- `getPortalAccounts` now returns `status IN (''Active'', ''Suspended'')` — Cancelled/Closed accounts disappear from the portal entirely
- Suspended accounts are kept in the portal so the client can still chat with support
- Reactivation makes the banner disappear on the next page load

## Audit trail
Every status change writes to `action_log` with:
- `summary`: "Status changed: {old} → {new}"
- `details`: `{ oldStatus, newStatus, options, cascadesApplied, cascadesFailed, note }`
- Each cascade is best-effort — if one fails, others still run and the failure is recorded in `cascadesFailed`

The change also appends a dated line to `accounts.notes`: `"YYYY-MM-DD: Status changed from {old} to {new} — {optional note}"`.

## DB constraint
`chk_account_portal_tier` was expanded to allow `suspended` and `inactive` in addition to `lead/onboarding/active`.

## sd_create gate
`sd_create` (MCP tool in `lib/mcp/tools/operations.ts`) refuses to create new deliveries when `account.status` is `Suspended`, `Cancelled`, or `Closed`. Contact-only deliveries (ITIN, Banking Physical) with no `account_id` are NOT gated — by design, since they''re not tied to an LLC.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-09T22:28:26.85224+00:00', '2026-04-09T22:28:26.85224+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('c1560d00-6e82-4302-9cea-452a88875600', 'F1 — Flexibility Principle: State-Aware, Reconciling Design', 'MASTER RULE F1 — FLEXIBILITY PRINCIPLE

This rule applies to ALL planning, implementation, refactoring, fixing, and design work.

CORE RULE: When designing or modifying the system, do NOT default to rigid one-path solutions when a flexible, state-aware, reconciling design is better.

SPECIFIC RULES:

F1.1 DO NOT DISABLE when coexistence + reconciliation is better.
Example: Calendly webhook should write to intake staging with explicit status, not be disabled because an Intake Review page exists.

F1.2 DO NOT REPLACE when linking, matching, or state-aware processing is better.
Example: Chat query should include both contact-only and account messages, not require backfilling one context into another.

F1.3 DO NOT ASSUME one source owns the truth when multiple sources should be reconciled.
Example: CRM actions and MCP tools should call the same backend operations with the same dedup checks.

F1.4 DO NOT CREATE rigid flows when explicit status, checks, and cross-validation can keep the system aligned.
Example: Wizard trigger should check existing wizard_progress state (resume/restart/create), not blindly create.

F1.5 PRESERVE INFORMATION. Do not delete when you can supersede. Do not exclude when you can include with status.
Example: Document regeneration should create new versions, not require deleting old ones.

F1.6 PREFER additive, composable, future-compatible changes.
Example: Add service_context field to offer builder rather than adding more service types to hardcoded sets.

F1.7 ALWAYS ASK whether two parts of the system should check each other before excluding one another.
Example: Create Lead action should check existing contacts/leads by email before creating, not operate blindly.

F1.8 When coding, planning, or correcting, EXPLICITLY CONSIDER whether the design is too rigid and whether a flexible alternative exists.

APPLICATION: This rule must be read and followed when:
- Planning new features
- Implementing code changes
- Refactoring existing code
- Fixing bugs
- Reconciling data
- Designing new workflows
- Revising existing workflows

CANONICAL SOURCE: This article + sysdoc_read(''crm-lifecycle-roadmap'') for the full roadmap.
ALIGNED WITH: Master Rules v3.1, CRM Reflection Parity principle.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-11T16:12:00.515209+00:00', '2026-04-11T16:12:00.515209+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('bffa26b0-223c-46c0-ad33-ac43b189a902', 'Portal Auth: Existing-User Path Must Validate contact_id', '## Rule\n\nWhen `autoCreatePortalUser` (lib/portal/auto-create.ts) encounters an existing auth user, it MUST:\n1. Validate that `contact_id` in auth metadata points to a contact that still exists in the DB\n2. If the contact was deleted (stale reference), clear the contact_id and fall through\n3. Look up a contact by email\n4. Create a contact if no contact exists\n5. NEVER return `success: true` with a stale or missing contact_id\n\n## Why\n\nDiscovered 2026-04-13. When an offer is deleted and recreated for the same email:\n- The auth user persists from the first offer\n- The contact_id in auth metadata may point to a deleted contact\n- The existing-user path trusted this stale UUID without verification\n- Result: portal_tier was set but contact_id was invalid → chat, profile, documents silently redirected\n\n## Root Cause\n\nThe primary bug was NOT offer deletion (Bug A). It was the existing-user path in `createFromEmail` (auto-create.ts:130-176) returning success without guaranteeing a valid contact. Offer deletion only exposed it.\n\n## Lead-Tier Portal Dependency\n\nThree lead-tier features depend on contact_id resolving to a real contact:\n- chat/page.tsx:15 — redirects to /portal if !contactId\n- profile/page.tsx:21 — same\n- documents/page.tsx:30 — same\n\nIf contact_id is null or stale, these features appear in the nav (tier-config.ts allows them) but silently bounce the user.\n\n## Fix Applied\n\nCommits 43c0259 + 98a5288: Three-step contact resolution in existing-user path:\n1. Validate existing contact_id exists in DB (line 135-141)\n2. Email lookup fallback (line 144-152)\n3. Create contact if all lookups fail (line 155-163)\n\nRetested against exact broken scenario: stale contact_id → detected → cleared → new contact created → auth metadata corrected.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-13T22:12:18.761896+00:00', '2026-04-13T22:12:18.761896+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO knowledge_articles (id, title, content, category, tags, version, notes, airtable_id, created_at, updated_at) VALUES ('64f51163-ea3c-48dc-aabd-65b45ae86c44', 'Annual Renewal & account_type classification — 2026 formations + One-Time customers', '## Rule 1 — 2026-formation accounts are excluded from the Annual Renewal 2026 billing cycle

Companies formed in the current calendar year (e.g. 2026 formations in 2026) are EXCLUDED from the Annual Renewal billing cycle for that year. Their first real annual renewal is due in year N+1 (the year after formation).

**Database state for 2026 formations:**
- `service_deliveries.service_type=''Annual Renewal''` row: EXISTS (created at formation) but `stage=NULL` until year N+1 starts
- `stage_order=NULL`, `stage_entered_at=NULL`
- The row stays at NULL through year N. Year N+1 first installment invoice moves it to `Invoice Sent`, then `Payment Received`, then `Services Renewed`.

**Why this matters:**
1. 2026-formation clients DO have "First Installment 2026" / "Second Payment 2026" rows in `payments` — but those are **setup/formation fees**, NOT annual renewal installments. They can be distinguished by `paid_date` being close to (or before) `accounts.formation_date`.
2. The `payments.description` field is freeform text and does not encode category. Automated scripts must not assume "First Installment 2026" always means annual renewal.
3. Applying a blanket "all paid = Payment Received" rule across Annual Renewal SDs will incorrectly count formation fees as annual renewal payments.

**Concrete reference cases (2026-04-15):**
- Skiness LLC (formed 2026-01-02), MDL Advisory LLC (2026-02-24), Datavora LLC (2026-03-02) — zero payment rows in DB. Annual Renewal SD stays NULL.
- PGLS Enterprise LLC (formed 2026-02-13) — has 2 "First Installment 2026" payment rows totaling $2,789, both paid BEFORE or shortly after formation_date. Those are setup fee installments, not annual renewal. Annual Renewal SD stays NULL.

**Related dev task** `a1419604` (high priority) — add a `payment_category` enum column to `payments` so setup fees, annual renewal installments, and one-time services can be distinguished without freeform-text heuristics. Until shipped, classification requires cross-referencing `formation_date`.

---

## Rule 2 — `account_type=''One-Time''` customers have recurring SDs deleted

When a client is reclassified from `Client` → `One-Time` (via `accounts.account_type`), their recurring service_deliveries rows (Annual Renewal, Tax Return, any other year-over-year service) should be **deleted**. Keeping them causes pipeline views to expect recurring billing that will never occur.

**Process:**
1. Verify the account should be `One-Time` (e.g., they bought one shot of a service, not an ongoing relationship).
2. `crm_update_record` on `accounts.id` with `{ account_type: ''One-Time'' }`.
3. `DELETE FROM service_deliveries WHERE account_id = ''...'' AND service_type IN (''Annual Renewal'', ''Tax Return'', ...)` for applicable recurring types.
4. Log in account notes with a dated entry explaining the reclassification.

**Reference case (2026-04-15):** Italiza LLC (account `aea6b705-045e-4883-826a-e1da86090d8e`, formed 2024-02-16, SMLLC) reclassified from `Client` → `One-Time` and its Annual Renewal SD deleted.

**Enum state:** `account_type` is a freeform TEXT column (not enum). Currently in use: `Client` (280 accounts), `One-Time` (31 accounts), `Partner` (2 accounts).

---

## Rule 3 — Annual Renewal SD stage update convention

For bulk or manual Annual Renewal stage transitions:
- Only update the `stage` TEXT column
- Leave `stage_order` and `stage_entered_at` as NULL
- This matches 160 of 167 existing Annual Renewal SDs (verified 2026-04-15 via `SELECT count(*) FILTER (WHERE stage_order IS NOT NULL)` etc.)

Setting `stage_order` / `stage_entered_at` on new rows would establish a competing convention that diverges from legacy state. If the full state machine (SLA reminders, auto-advance) is ever activated for Annual Renewal, a one-shot backfill across all 167 rows is the clean path — not incremental mixing.

Stage progression (Annual Renewal pipeline): `Invoice Sent` → `Payment Received` → `Services Renewed`.

---

## Rule 4 — Suspending an account that had a deleted Annual Renewal SD

When `accounts.status` is moved to `Suspended` (client inactive/paused), the related recurring service_deliveries should also be deleted (same reasoning as Rule 2 — recurring billing views should not show suspended clients).

**Reference case (2026-04-15):** Degasper Real Estate LLC (`91cf902e-9d56-45c6-9b04-de69cf752bd8`, formed 2020-01-13, C-Corp Elected) suspended and Annual Renewal SD deleted. `portal_tier` also flipped to `suspended` to match the account status.

---

## Source & session

- Created: 2026-04-15
- Session workstream: `a56724ea-6a99-4923-ab0f-0a3a51f783d8` — Phase 0 P0.8 data cleanup
- Concrete execution: 124 NULL-stage Annual Renewal SDs bucketed into 106 Payment Received / 11 Invoice Sent / 5 NULL (excluded) / 2 deleted. See dev task for full log.', 'Business Rules', NULL, NULL, NULL, NULL, '2026-04-15T16:58:11.044109+00:00', '2026-04-15T16:58:11.044109+00:00') ON CONFLICT (id) DO NOTHING;

-- sop_runbooks: 17 rows
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('b466d9bd-7f82-44f7-990c-28a34df3b5d8', 'Company Formation', 'Company Formation', '# Company Formation SOP v7.0
_Approved by Antonio — March 23, 2026_
_v7.0: Portal-first rewrite. Everything flows through portal. SS-4 signed in portal. OA + Lease signed in portal. Portal notifications replace emails. Lead/Contact/Account terminology clarified. All English._

## How the Portal Works

The client portal at portal.tonydurante.us is the single interface for clients. Everything a client needs to do happens inside the portal — reviewing offers, signing contracts, paying, filling wizards, signing documents, uploading files, viewing their company status, and communicating with staff.

**There are no emails with attachments, no external links, no separate systems.** The client logs in once and finds everything there.

### Portal Tiers

A person moves through three stages:

| Stage | Portal Tier | What they see | How they get here |
|-------|------------|---------------|-------------------|
| **Lead** | lead | Welcome dashboard with offer, contract, payment flow | portal_create_user creates auth login |
| **Contact** (no account) | onboarding | Welcome dashboard with "Complete Setup" linking to wizard | Lead signs + pays → converted to Contact |
| **Contact** (with account) | active | Full dashboard: company info, services, documents, invoices, deadlines, chat | Wizard submit creates Account (onboarding) or formation_confirm creates Account (formation) |

### Notifications

When staff does something (uploads a document, advances a stage, generates a form for signature), the Contact gets a portal notification (in-app + push). When the Contact does something (signs a document, submits a wizard, sends a chat message), staff gets notified via email to support@tonydurante.us.

### Communication

Portal chat replaces email for day-to-day client communication. Official documents (signed contracts, tax returns, EIN letters) are uploaded to the portal Documents section — the Contact sees them immediately.

### Referrals

Referrals are detected during or after the discovery call, BEFORE the lead pays. The referrer is noted on the lead record at creation (step 4). If a referral exists, a task is created for Antonio to review the referral arrangement.

---

## Overview

New LLC formation for clients who do not have an existing company. The LLC is created by us (state filing, EIN application), then the Contact receives all post-formation documents inside the portal.

**Lifecycle:**
1. Lead arrives → offer created → portal login sent → lead reviews/signs/pays inside portal → becomes Contact
2. Data Collection (portal wizard — formation type)
3. State Filing (Luca files Articles)
4. EIN Application (SS-4 generated + signed inside portal, Luca faxes to IRS)
5. Post-Formation Setup (OA, Lease, Banking — all inside portal)
6. Closing

---

## Phase 0: Sales Pipeline (Lead to Payment)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | Lead arrives | -- | -- | From ANY channel: Calendly, Instagram DM, email, WhatsApp, referral |
| 2 | Discovery call | Antonio | -- | Zoom/phone. Discuss the project. Detect referral if applicable. DO NOT choose LLC names during the call |
| 3 | Circleback records call | System | -- | Extracts content and booking info |
| 4 | Create lead | Claude | lead_create | Auto from Calendly + Circleback, or manual. Include referrer_name if referral detected during call |
| 5 | Create offer | Claude | offer_create(contract_type=formation) | From call data. Linked to lead. Lives inside the portal — NOT sent via email |
| 6 | Send portal login credentials | Claude | portal_create_user(portal_tier=lead) | Lead receives email with login link + temporary password. No Contact, no Account — just authentication. Offer already waiting inside the portal |
| 7 | Lead logs into portal | Lead | portal.tonydurante.us | Dashboard shows progress: Review Proposal → Sign Contract → Make Payment → Complete Setup |
| 8 | Lead reviews offer | Lead | /portal/offer | Full offer with services, pricing, contract — embedded inside the portal |
| 9 | Lead signs contract | Lead | /portal/offer | Contract signed inside the portal |
| 10 | Lead pays | Lead | -- | Whop (card +5%) or bank transfer. Payment details shown in portal dashboard |
| 11 | Payment confirmed | System | -- | Whop webhook or wire transfer check |
| 12 | **Lead → Contact** | System | -- | Lead status → Converted. Contact created in contacts table from lead data (name, email, phone, language). Auth user updated with contact_id. This is the moment the lead becomes a client |
| 13 | Create invoice | Claude | Portal billing system (QB fallback) | Marked as paid |
| 14 | Create SD | Claude | sd_create(service_type=Company Formation) | SD at Stage 1 + auto_tasks |
| 15 | Portal tier → onboarding | System | -- | Dashboard shows "Complete Setup" linking to wizard |

**RULE**: No CRM Account exists yet. Only Lead (Converted) + Contact + SD. The Account is created after SOS confirms the LLC (Phase 2).

---

## Phase 1: Data Collection

SD at stage "Data Collection" (stage_order=1)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 16 | Contact clicks "Complete Setup" | Contact | portal | WelcomeDashboard links to wizard |
| 17 | Contact fills wizard | Contact | /portal/wizard | Auto-detects formation type from SD. Step 1: Owner info (name, email, phone, DOB, nationality, address). Step 2: LLC names (3 choices) + business purpose + state preference. Step 3 (MMLLC): Additional members (name, ownership %, DOB, nationality, address, passport). Step 4: Passport upload + disclaimer |
| 18 | Follow-up if not completed | System | -- | Portal notification: Day 3, Day 5, Day 7 (escalation to Antonio), Day 9 (final) |
| 19 | Contact submits wizard | System | -- | Auto-chain triggers (see below) |
| 20 | Advance to Stage 2 | System | -- | When Luca marks verification task as Done → auto-advance to Stage 2 |

**Passport is MANDATORY.** Wizard blocks submission without passport upload (owner + all MMLLC members).

**NOTE:** For formation, the wizard does NOT create the CRM Account. It only collects personal data + LLC name choices. The Account is created in Phase 2 after SOS confirms the LLC exists.

Fallback: formation_form_create + gmail_send only if portal unavailable.

### Auto-Chain: Wizard Submit (Formation)

| # | Step | Detail |
|---|------|--------|
| 1 | Update Contact | DOB, nationality, address, passport_on_file |
| 2 | Create Leads/{name}/ folder | In Shared Drive |
| 3 | Save data summary PDF | Generated from submitted data |
| 4 | Copy passport to Drive | From Supabase Storage to Leads folder |
| 5 | Check passport | If MISSING: create URGENT task for Luca |
| 6 | Notify Luca | Portal notification + email: all client data + LLC names + next steps |
| 7 | Create Luca task | "Verify data + check LLC name availability" due 3 days |
| 8 | Update SD history | Stage notes updated |

---

## Phase 2: State Filing

SD at stage "State Filing" (stage_order=2, auto_advance=false)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 21 | Verify LLC name availability | Luca | -- | State SOS portal — names from wizard |
| 22 | Confirm name with Contact | Luca | Portal chat | Message via portal chat, NOT email |
| 23 | File Articles of Organization | Luca | -- | State SOS portal |
| 24 | Wait for SOS confirmation | Luca | -- | WY: immediate. FL/NM: wait for email |
| 25 | **SOS confirms → LLC EXISTS** | -- | -- | -- |
| 26 | Create Account + Drive + RA | Claude | formation_confirm(delivery_id) | One tool: CRM Account created, Drive folder with 5 subfolders, RA activation, Contact→Account link |
| 27 | Upload Articles to portal | System | -- | Articles of Organization appear in Contact portal Documents section |
| 28 | Contact notified | System | -- | Portal notification: "Your LLC has been formed! Articles of Organization are available in your Documents" |
| 29 | Rates and services_bundle | Claude | crm_update_record | From signed contract → Account |
| 30 | Activate RA on Harbor | Luca | -- | New activation |
| 31 | Portal tier → active | System | -- | Contact now sees full dashboard with company info |
| 32 | Advance to Stage 3 | Claude | sd_advance_stage(delivery_id) | → EIN Application + auto_tasks |

**Filing costs:** NM $50 same-day | WY $100 immediate | FL $125 3-5 days

---

## Phase 3: EIN Application

SD at stage "EIN Application" (stage_order=3, auto_advance=false)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 33 | Auto-generate SS-4 | System | -- | SS-4 form auto-generated from wizard data + Account data (LLC name, address, responsible party, entity type). Appears in portal as "Pending Signature" |
| 34 | Contact notified | System | -- | Portal notification: "Your SS-4 form is ready for signature" |
| 35 | Contact reviews + e-signs SS-4 | Contact | portal | Contact opens SS-4 in portal → reviews pre-filled data → e-signs |
| 36 | Staff notified | System | -- | Notification to Luca: "SS-4 signed by [Contact], ready to send to IRS" |
| 37 | Fax SS-4 to IRS | Luca | -- | Physical fax (external to portal) |
| 38 | Follow up IRS | Luca | -- | If no response after 7 days |
| 39 | EIN received | Luca | -- | EIN letter arrives |
| 40 | Upload EIN to portal | Claude | -- | EIN letter uploaded to portal Documents + Drive. Account updated with EIN number |
| 41 | Contact notified | System | -- | Portal notification: "Your EIN has been received! It is available in your Documents" |
| 42 | Advance to Stage 4 | Claude | sd_advance_stage(delivery_id) | → Post-Formation Setup |

**Timeline:** US applicant = same day | Non-US (fax) = 4-6 weeks

---

## Phase 4: Post-Formation Setup

SD at stage "Post-Formation Setup" (stage_order=4, auto_advance=true)

Everything appears inside the portal. No emails with attachments, no external links.

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 43 | Auto-generate OA | System | -- | Operating Agreement generated from Account + Contact data. Appears in portal as "Pending Signature" |
| 44 | Auto-generate Lease | System | -- | Lease Agreement generated (suite auto-assigned, $100/mo). Appears in portal as "Pending Signature" |
| 45 | Banking wizard available | System | -- | Banking wizard (Relay USD + Payset EUR) appears in portal. Contact fills when ready |
| 46 | Contact notified | System | -- | Portal notification: "Your Operating Agreement, Lease, and Banking setup are ready. Please review and sign" |
| 47 | Contact signs OA | Contact | portal | E-sign inside portal. Signed PDF auto-saved to Drive + portal Documents |
| 48 | Contact signs Lease | Contact | portal | E-sign inside portal. Signed PDF auto-saved to Drive + portal Documents |
| 49 | Contact fills Banking wizard | Contact | portal | Relay (USD) + Payset (EUR) forms inside portal |
| 50 | Staff notified per completion | System | -- | Each signature/submission triggers notification to staff |
| 51 | Tax data collection | System | -- | Tax wizard available in portal. Contact fills when ready |
| 52 | Compliance check | Claude | doc_compliance_check(account_id) | Score >= 80% |

**RULE:** Welcome Package ONLY if services_bundle includes annual management.

---

## Phase 5: Closing

SD at stage "Closing" (stage_order=5, auto_advance=false)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 53 | Verify all items complete | System | -- | OA signed, Lease signed, Banking submitted, Tax data received |
| 54 | Review request | System | -- | Portal notification to Contact: "Please leave us a review" with Google + Trustpilot links. Antonio approves first |
| 55 | Activate Account | Claude | crm_update_record | status=Active, client_health=green |
| 56 | Auto-create RA Renewal SD | Claude | sd_create(service_type=State RA Renewal) | Track first renewal |
| 57 | Auto-create Annual Report SD | Claude | sd_create(service_type=State Annual Report) | NM excluded |
| 58 | Tax Return record | Claude | -- | If applicable |
| 59 | Contact notified | System | -- | Portal notification: "Your setup is complete! Your dashboard is now fully active" |
| 60 | Close SD | Claude | sd_advance_stage(delivery_id) | → completed |

Post-closing: daily cron checks RA + Annual Report. If SD already exists, skip.

---

## Drive Folder Structure

formation_confirm creates: Companies/{State}/{Company Name} - {Owner Name}/ with 5 subfolders:
1. Company/ — Articles, OA, Lease, EIN Letter
2. Contacts/ — Passport, ID docs
3. Tax/ — Tax returns, extensions
4. Banking/ — Bank docs
5. Correspondence/ — Communications

Pre-SOS: documents in Leads/ by contact name. Post-SOS: permanent folder in Companies/.

---

## Pricing

| Entity Type | Setup Fee | Annual (Year 2+) |
|-------------|----------|-------------------|
| SMLLC | Custom (from offer) | $2,000/year (2 x $1,000) |
| MMLLC | Custom (from offer) | $2,500/year (2 x $1,250) |

**Post-September Rule:** LLC formed after September 1 → skip 1st installment (January) next year. First payment = 2nd installment (June).

---

## Invoicing

| System | Status | Usage |
|--------|--------|-------|
| Portal billing system | Official | Create invoices, send to client, track payments, PDF |
| QuickBooks | Fallback (transition) | Only if portal billing unavailable |

---

## Rules

| Rule | Detail |
|------|--------|
| Portal = single interface | Everything the Contact does happens inside the portal. No email attachments, no external links |
| Portal wizard = default | formation_form_create is fallback only |
| Offer inside portal | Lead sees offer inside the portal after login. No offer email sent |
| Portal billing = official | QuickBooks is fallback only |
| Portal chat = communication | Day-to-day communication via portal chat, not email |
| Portal notifications = alerts | Contact gets in-app + push notifications for every action |
| SS-4 signed in portal | Auto-generated, e-signed inside portal, Luca faxes to IRS |
| OA + Lease signed in portal | Auto-generated, e-signed inside portal, PDF auto-saved |
| Banking wizard in portal | Relay + Payset forms inside portal |
| Account = LLC | ONLY after SOS confirmation via formation_confirm |
| LLC names in wizard | NEVER during discovery call |
| Referral at lead creation | Detected during call, noted on lead record |
| SD created at payment | Stage 1 |
| Filing = Luca | Luca files Articles + faxes SS-4 |
| Post-September | Skip 1st installment next year |
| Follow-up | Portal notifications: Day 3, 5, 7 (escalation), 9 |
| Official documents | Uploaded to portal Documents, not emailed as attachments |
| Review | Google + Trustpilot at closing |
| Post-closing | Auto-create RA Renewal + Annual Report SD |
| TD logo | NEVER on client legal documents |
| Passport mandatory | Wizard blocks submission without passport |

---

## Tools

| Tool | What it does |
|------|-------------|
| Portal wizard (formation type) | Primary data collection |
| Portal billing system | Official invoicing |
| Portal chat | Client communication |
| Portal notifications | In-app + push alerts to Contact |
| Portal document signing | OA, Lease, SS-4 signed inside portal |
| portal_create_user | Creates portal login (auth user). NOT a CRM Account |
| formation_confirm | Creates CRM Account + Drive + RA link after SOS confirmation |
| doc_compliance_check | Verify document score |
| formation_form_create | Static form. Fallback only |

---

## Proposals for New Portal Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **SS-4 in Portal** | Auto-generate SS-4 from wizard data. Contact e-signs in portal. Staff gets notification when signed | Eliminates email back-and-forth for SS-4 signature |
| **EIN Status Tracker** | Contact sees EIN application progress in Services: SS-4 Submitted → Waiting for IRS → EIN Received | Contact stops asking "where is my EIN?" |
| **Post-Formation Checklist** | Dashboard checklist: Sign OA, Sign Lease, Banking Setup, Tax Info. Auto-checks on completion | Contact always knows what is left to do |
| **Review in Portal** | Review prompt inside portal. Contact writes review, staff copies to Google/Trustpilot | Less friction, higher completion rate |
| **Document Expiry Alerts** | Portal shows upcoming document expirations (passport, RA, annual report) | Proactive compliance |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01 | Initial |
| 3.0 | 2026-03 | Pipeline 5 stages |
| 5.0 | 2026-03-17 | Full step-by-step, formation_confirm, follow-up cadence |
| 6.0 | 2026-03-19 | Auto-chain, passport mandatory, task notifications, referral detection |
| 7.0 | 2026-03-23 | Portal-first rewrite. Everything flows through portal. SS-4 signed in portal. OA + Lease signed in portal. Portal notifications replace emails. Portal chat replaces email communication. Lead/Contact/Account terminology clarified. All English. |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete reference.

### OFFER PAYMENT RULE (P12)
Every offer MUST include BOTH payment methods: Whop checkout link (card +5% surcharge) AND bank transfer details. EUR offers → Airwallex IBAN (DK8989000023658198). USD offers → Relay account (200000306770). The lead always chooses how to pay.

---

## Multi-Contract Offers (April 2026 — commits 1ca20f0, 978d730)

Phase 0 step 9 now involves signing ALL contracts, not just one. Each service in the offer carries a `contract_type` field (from SERVICE_CATALOG via CRM dialog). Services matching the offer''s main type go into the main MSA+SOW. Services with a different contract_type (e.g., ITIN on a formation offer) render as separate standalone agreements. Client must sign ALL contracts before checkout.

Even free/included services (e.g., Tax Return at $0) require their own standalone agreement signed.

The CRM offer dialog now includes:
- **Payment Gateway**: Stripe (default, deferred checkout) or Whop (plan at offer creation)
- **Bank Account**: Auto (EUR→Airwallex, USD→Relay), Relay, Mercury, Revolut, Airwallex

Per-service contract_type is passed from SERVICE_CATALOG through the dialog into servicesJson.', '7.2', '[Migrated metadata]
Service Code: SVC-FORMATION
---
Trigger: Deal enters Company Incorporation pipeline. A prospect accepts the formation offer and pays (or payment is confirmed). A Deal is created/advanced to ''Payment Received''.
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Signed service agreement / engagement letter (DocuSign)
- Client onboarding data (owner details, residential address, passport copy)
- Company details: entity type (single-member, multi-member, LLC elected as C-Corp), state (WY/FL/DE/etc.)
- Preferred company name(s) (if needed for new formation)
- WorkDrive folder created (Company Name)
---
Completion Criteria: - Company is formed and active in the state
- EIN is obtained and saved (CRM + WorkDrive)
- Client receives final formation package and confirmation email
- Any purchased add-on workstreams are created and assigned (Banking/ITIN/CMRA/etc.)
- Portal account created and documents uploaded
---
Exceptions:
- Client delays payment: Keep Deal in ''Payment Pending''; store delay request screenshot in Deal Notes; set follow-up reminders
- State rejects filing/name: Request updated info from client; update Deal Notes; re-file and track new receipt
- EIN delays: Log follow-up attempts; keep evidence in Notes; escalate if beyond expected window
---
Antonio-Only: None
---
Portal Rules: Create portal AFTER incorporation confirmed.

Steps:
1. Log in to Portal Admin
2. Create client''s Portal account
3. Portal automatically sends access email
4. Upload Articles of Organization to Portal
5. When EIN/SS-4 received → upload to Portal
6. Update client dashboard progressively
---
Pipeline: Company Formation (Ticket)
---
Stages: New Request → Document Collection → State Filing → EIN Application → Post-Formation Setup → Quality Check → Completed
---
Task Template: 12 tasks (3 rules):
- Auto-create standardized task checklist for formation steps and assign owner (Luca/Tony)
- Auto-create WorkDrive folder (if missing) and link it on the Account record
- Auto-trigger DocuSign send + reminder sequence until signed', 'rec4IK4vXd2bl9DC6', '2026-03-03T18:51:06.916429+00:00', '2026-04-04T18:20:33.877637+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('8cc51013-274e-4a7e-8d14-a2b2c70a3c07', 'Public Notary', 'Public Notary', '# Public Notary SOP v1.1
19 Marzo 2026
v1.1: Google Drive references updated.

## Steps
1. Create Notary Service task linked to client (unless bundled inside another service like CMRA).
2. Request documents and signer IDs. Review completeness.
3. Schedule notarization (in-person or remote per Florida notary rules).
4. Perform notarization. Produce notarized document set.
5. Scan notarized documents. Send scanned copy to client for confirmation.
6. Store notarized documents in Google Drive.
7. If originals must be shipped, trigger Shipping SOP.

## Rules
- Antonio-Only: perform notarization (Antonio is licensed Florida notary)
- Identity verification per Florida notary rules
- Save all notarized copies to Google Drive
- If shipping needed, always via Shipping SOP

## Version History
| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | WorkDrive -> Google Drive |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.
Categories: Payment (P1-P11), Client (C1-C6), Services (S1-S5), Communication (M1-M4), Banking (B1-B5), Drive (D1-D7), Technical (T1-T5), Renewal (R1-R5).', '2.0', '[Migrated metadata]
Service Code: SVC-NOTARY
---
Trigger: Deal enters Payment Received in Public Notary pipeline. Client requests notarization (standalone or as part of Authorized Signer/CMRA workflows) and pays.
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Document(s) to notarize (PDF or original)
- Signer identity verification requirements per notary rules
- Client instructions (where to send originals/scans)
---
Completion Criteria: - Notarized documents delivered to client (scan and/or originals shipped)
- WorkDrive contains notarized copies
---
Exceptions:
- Identity verification fails or signer not available: Keep status pending and reschedule; record notes
---
Antonio-Only: Perform notarization (Antonio is a licensed notary)
---
Portal Rules: None
---
Pipeline: Public Notary (Ticket)
---
Stages: New Request → Document Review → Appointment Scheduled → Notarized → Completed
---
Task Template: 5 tasks (1 rule):
- On ''Docs Received'': Auto-create notarization checklist tasks', 'recZ6zfE3hMiCYMFX', '2026-03-03T18:51:06.916429+00:00', '2026-03-20T15:48:42.460564+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('1aef7643-a978-497c-a06a-03325193bba3', 'Tax Return SOP v7.0', 'Tax Return', '# Tax Return SOP v7.0
_Approved by Antonio — March 23, 2026_
_v7.0: Two scenarios (annual client vs one-time customer). Portal wizard replaces static form. Portal billing = official (QB fallback). Extension corrected: India team files in bulk, list sent by February 1. Corp auto P&L + Balance Sheet. All English._

## Overview

Two scenarios with different entry points but same preparation/filing workflow.

| | Scenario 1: Annual Client | Scenario 2: One-Time Customer |
|---|---|---|
| **Who** | Active client with annual contract | Anyone who buys only tax return service |
| **Entry** | 1st installment paid (January) | Lead from any channel → portal login → offer → sign → pay |
| **Payment** | 2 installments (Jan + Jun) | Single payment upfront ($1,000 SM / $1,500 MM/Corp) |
| **Invoicing** | Portal billing system (QB fallback) | Portal billing system (QB fallback) |
| **Data Collection** | Portal wizard (tax type) | Portal wizard (tax type) |
| **Extension** | India files in bulk | India files in bulk |
| **2nd Payment Gate** | YES — blocks India until June paid | NO — already paid in full |
| **Post-September Rule** | Applies (skip 1st installment) | N/A |
| **Send to India** | After 2nd payment confirmed | After data received (no gate) |
| **Review + Filing** | Same | Same |

**Lifecycle order:**
1. Entry + Payment
2. Data Collection (portal wizard) — parallel with extension
3. Extension (India bulk)
4. Payment Gate (Scenario 1 only — wait for 2nd installment)
5. Send to India for preparation
6. Review (Antonio) + Contact signature + Filing

---

## Entity Types — IRS Forms + Data Requirements

| | SMLLC | MMLLC | Corp (LLC elected as C-Corp) |
|---|---|---|---|
| **IRS Forms** | Form 1120 + Form 5472 | Form 1065 + Schedule K-1 per member | Form 1120 |
| **What it is** | Information return (related-party transactions) | Partnership income return | Corporate income tax return |
| **Bank statements** | Optional (reference for India) | YES (CSV preferred — auto-parsed) | YES (CSV preferred — auto-parsed) |
| **Auto P&L** | NO | YES (dual currency USD + original) | YES (dual currency USD + original) |
| **Auto Comparative Balance Sheet** | NO | YES | YES |
| **K-1 allocation** | NO | YES (per member by ownership %) | NO |
| **Original deadline** | April 15 | March 15 | April 15 |
| **Extended deadline** | October 15 | September 15 | October 15 |

### What each entity type collects in the wizard:

**SMLLC (Form 1120 + 5472):**
- Step 1: Owner info (11 fields) + 5472 ownership questions (are you 100% direct owner? does ultimate owner hold 25%+? if yes: ultimate owner name, address, country, tax ID)
- Step 2: Company info (LLC name, EIN, incorporation date, state, business activities, website)
- Step 3: Financials — direct amounts: formation costs, bank contributions, distributions/withdrawals, personal expenses + related party transactions repeater (company name, address, country, VAT, amount, description)
- Step 4: Documents — bank statements (optional), financial statements (optional), prior year return (optional) + disclaimer

**MMLLC (Form 1065 + K-1):**
- Step 1: Owner info (11 fields) + member repeater (name, ownership %, ITIN/SSN, tax residency, address)
- Step 2: Company info (7 fields) + has W-2 employees? + payroll details
- Step 3: Financials — 17 yes/no questions: prior returns filed, financial statements prepared, payroll, ownership change, foreign partners, assets >$50K, 1099s received/issued, crypto transactions, real estate, foreign bank accounts, related party transactions, debt forgiveness, vehicle business use, home office, retirement plan, health insurance + additional comments
- Step 4: Documents — bank statements (CSV strongly preferred), financial statements, prior year Form 1065 + disclaimer

**Corp (Form 1120):**
- Step 1: Owner info (11 fields) + ownership structure description + foreign ownership 25%+ question + details
- Step 2: Company info (7 fields) + has W-2 employees? + payroll details + state revenue breakdown + new activities/markets
- Step 3: Financials — contributions, distributions, dividends paid, estimated taxes paid (Form 1120-W), rental/passive income, debt modifications/forgiveness, minute book updated, 1099s received, vehicle ownership + additional comments
- Step 4: Documents — bank statements (CSV preferred), financial statements, prior year return + disclaimer

### What is auto-generated after wizard submission:

| | SMLLC | MMLLC | Corp |
|---|---|---|---|
| Bank statement parsing | NO | YES | YES |
| P&L Excel (dual currency) | NO | YES | YES |
| Comparative Balance Sheet | NO | YES | YES |
| K-1 allocation per member | NO | YES | NO |
| Data summary PDF | YES | YES | YES |

---

## SCENARIO 1: Annual Client

### Phase 0: Activation (January)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | 1st installment paid | Contact | -- | January payment confirmed via portal billing + Gmail + Whop |
| 2 | Create invoice | Claude | Portal billing system (QB fallback) | Invoice for 1st installment, marked as paid |
| 3 | Create tax_returns record | Claude | tax_update | tax_year, return_type (SMLLC/MMLLC/Corp), paid=true |
| 4 | Status: Activated | Claude | tax_update | status: "Activated - Need Link" |

**Post-September Rule**: LLC formed after September 1 of previous year enters as Activated WITHOUT payment. Setup fee covers services until December 31. First real payment = 2nd installment (June). Create tax_returns with first_year_skip=true.

---

## SCENARIO 2: One-Time Customer

### Phase 0: Lead to Payment

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | Lead arrives | -- | -- | From ANY channel: Calendly, Instagram DM, email, WhatsApp, referral, tax_quote form |
| 2 | Create lead | Claude | lead_create | Source, channel, reason: "Tax Return" |
| 3 | Create offer | Claude | offer_create(contract_type=tax_return) | $1,000 SMLLC / $1,500 MMLLC / $1,500 Corp. Linked to lead |
| 4 | Send portal login credentials | Claude | portal_create_user(portal_tier=lead) | Lead receives email with login link + temporary password. No Contact, no Account — just authentication. Offer already waiting inside the portal |
| 5 | Lead logs into portal | Lead | portal.tonydurante.us | Views offer, signs contract, pays |
| 6 | Payment confirmed | System | -- | Whop webhook or wire transfer check |
| 7 | **Lead → Contact** | System | -- | Lead status → Converted. Contact created from lead data. Auth user updated with contact_id |
| 8 | Create invoice | Claude | Portal billing system (QB fallback) | Single payment invoice, marked as paid |
| 9 | Portal tier → onboarding | System | -- | portal_tier advances after payment |
| 10 | Create tax_returns record | Claude | tax_update | paid=true, status: "Activated - Need Link" |
| 11 | Create SD | Claude | sd_create(service_type=Tax Return) | SD at Stage 1 |

---

## PHASE 1: Data Collection (SAME for both scenarios)

Portal wizard replaces static tax form. Contact fills wizard inside the portal.

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 12 | Contact accesses portal wizard | Contact | portal.tonydurante.us/portal/wizard | Auto-detects tax type from SD service_type. Fields vary by entity type (see above) |
| 13 | Contact fills wizard | Contact | -- | 4 steps: owner info, company info, financials, documents + disclaimer |
| 14 | Follow-up if not completed | System | -- | Portal notification: Day 3, Day 5, Day 7 (escalation to Antonio), Day 9 (final) |
| 15 | Wizard submit triggers auto-chain | System | -- | CRM updated. MMLLC+Corp: bank statements parsed, P&L + Balance Sheet auto-generated. All docs saved to Drive /3. Tax/{year}/ |
| 16 | Status: Data Received | Claude | tax_update | data_received=true, data_received_date=today |
| 17 | Antonio reviews data | Antonio | -- | Verify data before proceeding |

Fallback: tax_form_create + gmail_send only if portal unavailable.

---

## PHASE 2: Extension (PARALLEL with Phase 1)

India team files extensions in bulk. Not per-client. This is a safety layer filed for ALL clients regardless of whether data has been received.

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 18 | Generate extension list | Claude | tax_extension_list(tax_year) | CSV of ALL clients needing extension |
| 19 | Send list to India | Claude | tax_extension_list(tax_year, send_to_email=tax@adasglobus.com) | Bulk email with complete client list. Send by February 1 |
| 20 | India files ALL extensions with IRS | India team | -- | Bulk filing via Form 7004 |
| 21 | India sends back confirmation IDs | India team | -- | Submission IDs per client |
| 22 | Update all records | Claude | tax_extension_update(tax_year, extensions[]) | Bulk update: extension_filed=true + submission_id per client |

**Deadlines:**
- MMLLC: original March 15 → extended to September 15
- SMLLC/Corp: original April 15 → extended to October 15

**Extension list sent by February 1** — one list, all clients, India handles the rest.

**Follow-up if India does not respond:**
- Day 3: reminder to tax@adasglobus.com
- Day 5: 2nd reminder
- Day 7: escalation to Antonio

---

## PHASE 3: Payment Gate (DIFFERENT per scenario)

### Scenario 1: Annual Client

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 23 | Check 2nd installment | Claude | Portal billing / crm_search_payments | Due June 1 |
| 24 | If not paid | Claude | -- | Follow-up: Day 15 reminder, Day 30 2nd reminder, Day 45 escalation to Antonio |
| 25 | If paid | Claude | -- | Advance to Phase 4 |

**CRITICAL RULE**: Tax return is NOT sent to India until 2nd installment is paid. No exceptions.

Post-September first year: this IS their first payment. Same gate applies.

If 2nd installment is already paid, skip this phase entirely.

### Scenario 2: One-Time Customer

**SKIP this phase entirely.** Contact already paid in full upfront. Go directly to Phase 4.

---

## PHASE 4: Send to India (SAME for both scenarios)

Prerequisites: payment confirmed + data complete + Antonio review OK.

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 26 | Send to India | Claude | tax_send_to_accountant(account_id, tax_year) | Auto-bundles from Drive: Tax Organizer PDF, P&L Excel (MMLLC+Corp), prior year return, bank statements. Emails to tax@adasglobus.com. Subject: [Company] - [Contact] - [EIN] - [Type] |
| 27 | Track India progress | Claude | tax_update | india_status: Sent - Pending → In Progress → Completed |
| 28 | India returns completed TR | India team | -- | Tax return PDF ready for review |

**India follow-up:** Week 2: check status. Week 3: 2nd follow-up. Week 4: escalation to Antonio.

India = "filing team" or "preparation team". Never call them CPA or accountant.

---

## PHASE 5: Review and Filing (SAME for both scenarios)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 29 | Review completed TR | Antonio | -- | Antonio only. Verify all data correct |
| 30 | Upload TR to portal | Claude | -- | Tax return PDF uploaded to portal Documents + Drive /3. Tax/{year}/. Contact notified via portal |
| 31 | Contact reviews + signs TR | Contact | portal | Contact e-signs inside portal |
| 32 | Staff notified | System | -- | Notification: "TR signed by [Contact], ready for filing" |
| 33 | India files with IRS | India team | -- | Final filing |
| 34 | Upload filed TR | Claude | -- | Final filed version to portal Documents + Drive |
| 35 | Contact notified | System | -- | Portal notification: "Your tax return has been filed" |
| 36 | Close | Claude | tax_update + sd_advance | status: "TR Filed", SD completed |

---

## PHASE 6: Non-Payment Termination

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 37 | Contact does not pay after full follow-up | -- | -- | No work proceeds |
| 38 | Mark terminated | Claude | tax_update | status: "Terminated - Non Payment" |
| 39 | If late payment caused IRS penalty | Antonio | -- | $500 assistance fee applies |

---

## Timeline

| When | What |
|------|------|
| January | Scenario 1: 1st installment + activate. Scenario 2: anytime |
| February 1 | Send bulk extension list to India (ALL clients — MMLLC + SMLLC/Corp) |
| March 15 | Original deadline MMLLC (extension already filed by India) |
| April 15 | Original deadline SMLLC/Corp (extension already filed by India) |
| June | Scenario 1: 2nd installment gate. Scenario 2: already sent to India |
| September 15 | Extended deadline MMLLC |
| October 15 | Extended deadline SMLLC/Corp |

---

## Pricing

| Entity Type | Annual Client (included in contract) | One-Time Customer |
|-------------|--------------------------------------|-------------------|
| SMLLC | $2,000/year (2 x $1,000) | $1,000 |
| MMLLC | $2,500/year (2 x $1,250) | $1,500 |
| C-Corp | Custom | $1,500 |

---

## Invoicing

| System | Status | Usage |
|--------|--------|-------|
| Portal billing system | Official | Create invoices, send to client, track payments, PDF |
| QuickBooks | Fallback (transition) | Only if portal billing unavailable |

---

## Rules

| Rule | Detail |
|------|--------|
| Portal wizard = default | Static form is fallback only |
| Portal = single interface | Contact fills wizard, reviews TR, signs — all inside portal |
| Offer inside portal | Lead sees offer inside the portal after login. No offer email sent |
| Portal billing = official | QuickBooks is fallback only |
| No service until paid | Never send data to India without payment confirmed |
| 2nd payment = gate (Scenario 1) | India blocked until June installment paid |
| No gate (Scenario 2) | Paid upfront, no gate |
| Post-September | LLC formed after September 1: skip 1st installment, gate at 2nd |
| Extension = India bulk | Claude sends list by February 1, India files, India sends back IDs |
| Extension is parallel | Happens alongside data collection, not sequential |
| India = filing team | Never call them CPA or accountant |
| Email format to India | [Company] - [Contact] - [EIN] - [Type] to tax@adasglobus.com |
| Antonio reviews twice | Data (Phase 1) and completed TR (Phase 5) |
| Auto P&L | MMLLC + Corp only. SMLLC collects direct amounts, no auto P&L |
| TR signed in portal | Contact e-signs inside portal, not via email |
| Late payment fee | $500 for IRS penalty management |
| Upload | Drive /3. Tax/{year}/ + Portal Documents |
| Lead → Contact at payment | Lead becomes Contact when they sign + pay |
| Follow-up | Portal notifications: Day 3, 5, 7 (escalation), 9 |
| Official documents | Uploaded to portal Documents section |

---

## Tools

| Tool | What it does |
|------|-------------|
| Portal wizard (tax type) | Primary data collection. Replaces tax_form_create |
| Portal billing system | Official invoicing. Replaces QuickBooks |
| Portal document signing | TR signed inside portal |
| tax_send_to_accountant | Bundles all docs from Drive, emails India |
| tax_extension_list | Generates bulk CSV of all clients, emails India |
| tax_extension_update | Bulk marks extensions as filed with confirmation IDs |
| tax_search / tax_tracker | Search and visual dashboard |
| tax_update | Update workflow fields |
| tax_form_create / tax_form_review | Static form. Fallback only |
| tax_quote_create | Quote form for prospects. Auto-creates lead + draft offer |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial |
| 4.0 | 2026-03-16 | Post-September, extension tracking |
| 5.0 | 2026-03-20 | Auto-chain, P&L, bulk extension |
| 6.0 | 2026-03-23 | Comparative Balance Sheet, tax_send_to_accountant |
| 7.0 | 2026-03-23 | Two scenarios. Portal-first (wizard + signing + billing). Extension list by February 1. Corp auto P&L. India bulk extension. Lead/Contact terminology clarified. All English. |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete reference.

### OFFER PAYMENT RULE (P12)
Every offer MUST include BOTH payment methods: Whop checkout link (card +5% surcharge) AND bank transfer details. EUR offers → Airwallex IBAN (DK8989000023658198). USD offers → Relay account (200000306770). The lead always chooses how to pay.

---

## Bundled Tax Return — Standalone Agreement Required (April 2026)

When Tax Return is bundled in a formation or onboarding offer — even when marked as "Included" at $0 — it renders as a **separate standalone agreement** that the client must sign independently. This is because the Tax Return service has `contract_type: tax_return` which differs from the offer''s main `contract_type`.

The client sees both contracts on the signing page (main MSA+SOW + Tax Return standalone agreement) and must sign ALL before checkout.

Even though the Tax Return is free/included in the bundle, the standalone agreement is legally required and must be signed.

The CRM offer dialog now includes Payment Gateway (Stripe/Whop) and Bank Account (Auto/Relay/Mercury/Revolut/Airwallex) dropdowns (commit 978d730).', '7.1', '[Migrated metadata]
Service Code: SVC-TAX
---
Trigger: Tax season for ACTIVE paid clients. Tax season workflow opens each year for clients who are ACTIVE and have paid/are compliant per the annual contract (especially Installment 1).
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Company Type on Account: Single-member disregarded / Multi-member partnership / LLC elected as C-Corp
- Tax year (e.g., 2025 filing in 2026)
- Correct year-specific Zoho Form(s) for data collection
- Client has paid and is eligible
---
Completion Criteria: - Extension filed and recorded
- Tax return filed and deliverables sent to client
- All documents stored in WorkDrive and attached in CRM
- Uploaded to Client Portal
---
Exceptions:
- Late payment after tax deadline: Send IRS-penalty disclaimer; apply $500 assistance fee
- Missing client data: Keep status ''Waiting on Client''; do not hand off to India until complete
- Form changes per year/company type: Workflow must NOT run until correct year forms are confirmed updated
---
Antonio-Only: Review form (Antonio), Review filed return (Antonio)
---
Portal Rules: Upload to portal
---
Pipeline: Tax Return (Ticket)
---
Stages: 1st Installment Paid → Data Link Sent → Extension Sent to India → Extension Filed → Data Received → Awaiting 2nd Payment → Preparation → TR Completed → TR Filed → Terminated - Non Payment
---
Task Template: 10 tasks (2 rules):
- Form readiness checklist (internal)
- Gated email: only send link if ACTIVE and paid
- Auto-create tasks on form submission', 'recOWSZiE10aFJ8bg', '2026-03-03T18:51:06.916429+00:00', '2026-04-04T18:20:50.240486+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('a3edcc08-01ef-40da-b19d-e627faa559bd', 'Shipping', 'Shipping', '# Shipping SOP v1.1
19 Marzo 2026
v1.1: Google Drive references updated.

## Steps
1. Create Shipping task linked to client Account and originating service (CMRA/banking/notary/ITIN).
2. Confirm shipping address and contents with client. Confirm who pays and preferred speed/carrier.
3. Create shipment in ShipStation. Purchase label and print.
4. Pack and ship item(s). Record tracking number.
5. Send tracking number to client. Store proof in Google Drive (5. Correspondence/).
6. Close Shipping task as completed.

## Rules
- Shipping is ALWAYS paid by client
- No shipping until payment received
- Track all shipments with tracking numbers
- Save shipping receipts and tracking to Google Drive
- Common triggers: CMRA mail forwarding, debit cards, notarized documents, ITIN signed docs

## Version History
| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | WorkDrive -> Google Drive |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.
Categories: Payment (P1-P11), Client (C1-C6), Services (S1-S5), Communication (M1-M4), Banking (B1-B5), Drive (D1-D7), Technical (T1-T5), Renewal (R1-R5).', '2.0', '[Migrated metadata]
Service Code: SVC-SHIPPING
---
Trigger: Deal enters Payment Received in Shipping pipeline. Client requests shipment (mail forwarding, debit cards, signed documents) and accepts/pays the shipping quote.
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Client''s shipping address and recipient details
- Item(s) to ship and any special handling instructions
- Payment confirmation for shipping fee
- ShipStation access
---
Completion Criteria: - Shipment delivered (or shipped with tracking provided)
- Tracking stored and client notified
---
Exceptions:
- Client delays shipping payment: Keep shipping record pending; store delay evidence in Notes if requested
---
Antonio-Only: None
---
Portal Rules: None
---
Pipeline: Shipping (Ticket)
---
Stages: New Request → Package Received → Processing → Shipped → Completed
---
Task Template: 5 tasks (1 rule):
- On payment received: Auto-create ShipStation shipment draft and task for label printing
- Auto-email client tracking once tracking number is entered', 'recjHEAbOOChI0BTR', '2026-03-03T18:51:06.916429+00:00', '2026-03-20T15:48:42.460564+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('4d17419f-2d22-4bb5-8462-6f1595bad385', 'Company Closure', 'Company Closure', '# Company Closure SOP v4.0
_Approvato da Antonio — 20 Marzo 2026_
_v4.0: Two scenarios (Client vs One-Time), auto-chain, system auto-prepares dissolution + EIN docs, final TR always for clients._

## Two Scenarios

### SCENARIO A: CLIENT (annual management contract)
No pending payments allowed. Data already in CRM — skip form.

| # | Step | Chi | Type | Dettaglio |
|---|------|-----|------|----------|
| A1 | Verify no pending payments | System | AUTO | P8: all installments must be paid |
| A2 | Skip data collection | System | AUTO | Data in CRM, go to Stage 2 |
| A3 | State compliance check | Luca | MANUAL | Check state portal for outstanding items |
| A4 | System prepares Articles of Dissolution | System | AUTO | closure_prepare_documents auto-generates PDF |
| A5 | Task: print + mail or file online | Luca | TASK | WY/DE: mail. NM/FL: state portal |
| A6 | Wait for state confirmation | -- | WAIT | WY:15d, DE:2-4w, NM/FL:few days |
| A7 | Save confirmation to Drive | System | AUTO | 1. Company/ |
| A8 | System prepares EIN closure letter | System | AUTO | Auto-generates PDF |
| A9 | Task: print + mail EIN letter to IRS | Luca | TASK | IRS Cincinnati OH |
| A10 | File final tax return | India | ALWAYS | Regardless of income. India prepares, we mail |
| A11 | Wait for IRS confirmation | -- | WAIT | 4-6 weeks |
| A12 | Task: remove RA on Harbor Compliance | Luca | TASK | Harbor portal |
| A13 | Cancel CMRA/lease | System | AUTO | lease_update(status: expired) |
| A14 | Cancel all active SDs | System | AUTO | RA, AR, Tax, CMRA -> cancelled |
| A15 | Task: cancel QB recurring invoices | Team | TASK | If exists |
| A16 | Account -> Inactive | System | AUTO | crm_update_record |
| A17 | Deactivate portal | System | AUTO | portal_enabled: false |
| A18 | Close all open tasks | System | AUTO | All tasks -> Done |
| A19 | Task: email confirmation closure complete | Team | TASK | Notify client |

### SCENARIO B: ONE-TIME customer (standalone closure service)
Client buys closure service. May have no data in CRM.

| # | Step | Chi | Type | Dettaglio |
|---|------|-----|------|----------|
| B1 | Client buys closure | Client | -- | Via offer + payment |
| B2 | Send closure form | System | AUTO | closure_form_create |
| B3 | Client submits form | Client | -- | LLC name, EIN, state, RA, tax history |
| B4 | Auto-chain fires | System | AUTO | Drive + email + task + SD |
| B5 | Review form data | Luca | MANUAL | Verify completeness |
| B6 | State compliance check | Luca | MANUAL | Outstanding taxes/fees |
| B7 | Resolve outstanding obligations | Luca | MANUAL | Client pays arrears |
| B8 | System prepares Articles of Dissolution | System | AUTO | closure_prepare_documents |
| B9 | Task: mail or file online | Team | TASK | WY/DE: mail. NM/FL: portal |
| B10 | Wait for state confirmation | -- | WAIT | Per state |
| B11 | Save confirmation to Drive | System | AUTO | Leads/ or account folder |
| B12 | System prepares EIN closure letter | System | AUTO | Auto-generates PDF |
| B13 | Task: print + mail to IRS | Team | TASK | Physical mail |
| B14 | Wait for IRS confirmation | -- | WAIT | 4-6 weeks |
| B15 | Task: closure complete, email client | Team | TASK | Email confirmation |
| B16 | Close SD | System | AUTO | -> completed |

NOTE: One-time scenario does NOT include final tax return. If client wants it, that is a separate service they purchase.

## Auto-Chain: closure-form-completed
When closure form submitted, /api/closure-form-completed auto-executes:
1. Save data PDF + uploads to Drive
2. Ensure Closure SD exists
3. Email team with LLC details + next steps
4. Create task for Luca
5. Update SD history
6. Log action

## Pipeline (5 Stages)
1. Data Collection - Form sent (one-time) or skipped (client)
2. State Compliance Check - Outstanding taxes, fees, annual reports
3. State Dissolution Filing - System prepares docs, team mails/files
4. IRS Closure - System prepares EIN letter, team mails. Final TR for clients.
5. Closing - Cancel RA, CMRA, SDs, QB, portal. Account Inactive. Notify client.

## Regole Operative
- Compliance BEFORE filing (never file with outstanding obligations)
- Closure fee does NOT include state taxes/fees (client pays separately)
- Every offer MUST include BOTH payment methods: Whop checkout (card +5%) AND bank transfer. EUR → Airwallex. USD → Relay. Lead chooses. (Master Rule P12)
- Final tax return: ALWAYS for clients, NEVER automatic for one-time
- System auto-prepares Articles + EIN letter (Luca prints/mails)
- Client scenario: no resolve obligations step (already paid)
- Stage 5 auto-cancels: all SDs, portal, tasks. Manual: Harbor, QB invoices

## Version History
| Ver | Data | Modifiche |
|-----|------|-----------|
| 1.0 | 2026-01 | Iniziale |
| 2.0 | 2026-02 | 5 stage pipeline |
| 3.0 | 2026-03 | Full step-by-step |
| 4.0 | 2026-03-20 | Two scenarios (Client vs One-Time), auto-chain, system prepares docs, final TR always for clients |

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.

---

## ⚠️ FLAGGED FOR REWRITE (2026-04-04)

This SOP is still partially in Italian (v4.0). No direct conflict with multi-contract system, but inconsistent with all other SOPs now in English v7.x. Scheduled for full English rewrite in next SOP update cycle.

Note: The CRM offer dialog now includes Payment Gateway (Stripe/Whop) and Bank Account (Auto/Relay/Mercury/Revolut/Airwallex) dropdowns (commit 978d730) — relevant for Scenario B standalone closure offers.', '4.1', '[Migrated metadata]
Service Code: SVC-CLOSURE
---
Trigger: Client requests closure + payment confirmed.
---
Task Trigger Type: TBD
---
Completion Criteria: - LLC dissolved with the state
- EIN closed (if applicable)
- Account marked INACTIVE
- All active services cancelled
- Portal account deactivated
---
Exceptions:
N/A — pipeline TBD by James
---
Antonio-Only: Multiple steps require Antonio''s involvement
---
Portal Rules: Deactivate portal
---
Pipeline: Company Closure (Ticket)
---
Stages: New Request → Document Collection → State Dissolution → Tax Clearance → Final Notifications → Completed
---
Task Template: TBD', 'recyYoWLppr19LNCW', '2026-03-03T18:51:06.916429+00:00', '2026-04-04T18:20:55.285539+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('91b1bd12-9d38-4aba-afe3-103329e5330a', 'State Annual Report', 'State Annual Report', '# State Annual Report SOP v7.0
_Approved by Antonio — March 26, 2026_
_v7.0: English rewrite. Portal notification when filed (for portal-enabled clients). Matches pipeline_stages v7 (fixed task→title bug, English)._

## Overview

Annual state filing (Annual Report / Franchise Tax Report) for all active clients. Filed by staff — client provides no data. Cost included in annual management fee.

**Key facts:**
- Filed by Luca on state portal — client does nothing
- NM: no annual report required → skip automatically
- DE: deadline varies by entity type (LLC = June 1, Corp = March 1)
- Zero cost to client (included in annual fee). State fee paid by TD
- SD created at formation/onboarding CLOSING or by Billing Annual Renewal payment (Year 2+)
- Not in bundled_pipelines

---

## State Deadlines and Fees

| State | Deadline | State fee | Portal | Notes |
|-------|----------|-----------|--------|-------|
| Wyoming (WY) | 1st day of formation anniversary month | $60 | sos.wyo.gov | Always $60 — our clients have no declared assets |
| Florida (FL) | May 1 every year | $138.75 | sunbiz.org | Same deadline for all entity types |
| Delaware (DE) | June 1 (LLC) / March 1 (Corp) | $300 | corp.delaware.gov | Check entity_type: SMLLC/MMLLC → Jun 1, Corp → Mar 1 |
| New Mexico (NM) | NOT REQUIRED | — | — | NM does not require annual report for LLC. Auto-skip |
| Massachusetts (MA) | Formation anniversary | $500 | sec.state.ma.us | Same logic as WY — anniversary date |

---

## Phase 1: Upcoming

**Pipeline stage:** Upcoming (stage_order=1)
**Auto-tasks:** Verify account active and payment current, Create task with state deadline

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | SD auto-created | System | cron | 45 days before state deadline |
| 2 | Verify account active | System | -- | accounts.status = Active |
| 3 | Check payment status | System | -- | Verify current installment paid |
| 4 | If NOT paid | System | -- | Status → "Blocked — Payment Overdue". Task for Antonio: "Annual Report blocked — {company} unpaid" |
| 5 | If NM | System | -- | Close SD as "Not Applicable". NM has no annual report |
| 6 | If offboarding/closure | System | -- | Verify with Antonio whether to file or skip |
| 7 | Create task for Luca | System | -- | "File Annual Report for {company_name} — deadline {date} — portal {url}" |
| 8 | Advance to Stage 2 | Claude | sd_advance_stage | → In Progress |

---

## Phase 2: In Progress

**Pipeline stage:** In Progress (stage_order=2)
**Auto-tasks:** Access state portal and submit Annual Report, Pay state fee and download confirmation, Save to Drive and update CRM

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 9 | Access state portal | Luca | Browser | Use saved credentials for the state |
| 10 | Find company | Luca | Browser | Search by exact company_name |
| 11 | Verify data | Luca | Browser | Check: company name, registered address, registered agent. No changes should be needed |
| 12 | Submit Annual Report | Luca | Browser | Fill online form and submit |
| 13 | Pay state fee | Luca | Browser | Company credit card. WY $60, FL $138.75, DE $300, MA $500 |
| 14 | Download confirmation | Luca | Browser | Download PDF receipt from state portal |
| 15 | Save to Drive | Claude | drive_upload_file | Companies/{State}/{Company Name}/Compliance/Annual Report {year}.pdf |
| 16 | Update CRM | Claude | crm_update_record | Update filing confirmation number and date |
| 17 | Advance to Stage 3 | Claude | sd_advance_stage | → Completed |

---

## Phase 3: Completed

**Pipeline stage:** Completed (stage_order=3)
**Auto-tasks:** Close service delivery

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 18 | Portal notification | System | -- | For portal-enabled clients: "Your Annual Report for {state} has been filed for {year}." |
| 19 | Close SD | System | -- | SD status → completed |

---

## SLA

| Deadline | Action |
|----------|--------|
| 30 days before | Target: filing completed |
| 15 days before | Alert: verify filing status. Urgent if not done |
| 7 days before | Escalation: Antonio intervenes directly |

---

## Pricing

| Who pays | Amount | Detail |
|----------|--------|--------|
| TD to state | $60-$500 per state | State filing fee |
| Client to TD | $0 | Included in annual management fee |

---

## Rules

| Rule | Detail |
|------|--------|
| Client does nothing | Staff files everything. Client provides no data |
| NM = skip | New Mexico has no annual report. Auto-close SD as "Not Applicable" |
| DE = check entity_type | LLC deadline June 1, Corp deadline March 1 |
| Zero client cost | Included in annual fee. Never invoice separately |
| Block if unpaid | Unlike RA Renewal, Annual Report is blocked if payment overdue |
| If offboarding | Verify with Antonio before filing |
| Portal notification | Notify portal-enabled clients when filed |
| Not in bundled_pipelines | Annual Report SD created at closing or by annual cron |

---

## Tools

| Tool | What it does |
|------|-------------|
| sd_create | Cron creates Annual Report SD 45 days before deadline |
| sd_advance_stage | Advance through pipeline |
| drive_upload_file | Save state confirmation to Drive |
| crm_update_record | Update filing confirmation |
| Portal notifications | Notify portal-enabled clients on completion |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 3.0 | 2026-03-15 | Step-by-step with who/what/tool |
| 3.1 | 2026-03-15 | State deadlines and fees table |
| 7.0 | 2026-03-26 | English rewrite. Portal notification when filed. Block if unpaid (unlike RA Renewal). Matches pipeline_stages v7 |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.', '7.0', '[Migrated metadata]
Service Code: SVC-STATE
---
Trigger: Scheduled workflow by state. For ACTIVE, paid clients who have the service included, based on the state-driven due date.
---
Task Trigger Type: Scheduled Workflow
---
Required Documents:
- State of incorporation (Account)
- State compliance due date (Account master date)
- Proof client is paid/active under contract (Installment compliance)
- Any state portal credentials/instructions as applicable
---
Completion Criteria: - Annual Report/renewal filed and confirmed
- Registered Agent renewed/confirmed
- Client notified; WorkDrive contains receipts
- Uploaded to Client Portal
---
Exceptions:
- Client unpaid: Stop workflow; set status ''Blocked — Payment Overdue''
- State portal rejects filing: Correct data; re-file; log issue
---
Antonio-Only: None
---
Portal Rules: Upload to portal
---
Pipeline: State Annual Report + RA Renewal (Tickets)
---
Stages: State Annual Report: Upcoming → In Progress → Filed → Completed
RA Renewal: Upcoming → Renewed → Completed
---
Task Template: 14 tasks total (WY 4, FL 4, DE 4, NM 2):
- Automatic task creation X days before due date
- Block execution if Account is not ACTIVE/paid', 'recanWhVVu8Ptxppt', '2026-03-03T18:51:06.916429+00:00', '2026-03-26T18:39:51.70094+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('25b61842-a912-4f6f-b138-b7c3728bb243', 'Offboarding', 'Client Offboarding', '# Client Offboarding SOP v2.0
_Updated 2026-04-04_
_v2.0: Removed Zoho references, updated to current system (Supabase CRM, Google Drive, Portal, QuickBooks). Multi-contract system noted._

## Trigger
Client cancels (by November 1 written notice + both installments paid) OR terminated for non-payment.

## Steps
1. Verify eligibility to cancel (timing + payment compliance). Antonio decision required.
2. Record cancellation request evidence in Account Notes (email/portal chat screenshot).
3. Mark Account as INACTIVE (critical - excludes from all workflows/emails/reminders).
4. Cancel/stop future recurring invoices in Portal billing system (QuickBooks fallback).
5. Close or block all open Tasks/Deals with reason code (Cancelled / Non-payment).
6. Cancel Registered Agent on Harbor Compliance.
7. Cancel CMRA / mailing address if active.
8. Deactivate portal account (portal_tier → inactive).
9. Notify client of cancellation confirmation via email (official communication) and what is excluded going forward.
10. Archive/organize documents in Google Drive. Ensure final state is complete.

## Rules
- Antonio-Only: eligibility verification and approval
- Not eligible = keep ACTIVE, respond with contract terms, continue payment follow-ups
- Client receives no further automated communications after offboarding
- All open work properly closed or handed back to client
- Cancel ALL active services: RA, CMRA, banking, recurring invoices
- If client had multiple contracts (main + addon standalone agreements), ALL are terminated

## Version History
| Version | Date | Changes |
|---------|------|--------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | Zoho -> QuickBooks, WorkDrive -> Google Drive, Harbor Compliance + portal deactivation added |
| 2.0 | 2026-04-04 | Removed remaining Zoho references. Updated to current system: Supabase CRM, Portal billing, Google Drive. Multi-contract awareness added. |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete reference.
Categories: Payment (P1-P12), Client (C1-C6), Services (S1-S5), Communication (M1-M4), Banking (B1-B5), Drive (D1-D7), Technical (T1-T5), Renewal (R1-R5).', '2.0', '[Migrated metadata]
Service Code: SVC-OFFBOARD
---
Trigger: Cancellation request by Oct 31 + both installments paid. Client cancels (only permitted by contract: cancellation request by October AND prior installments paid), or client is terminated for non-payment per policy.
---
Task Trigger Type: Manual
---
Required Documents:
- Cancellation request evidence (email/WhatsApp/Telegram screenshot in Notes)
- Payment status for installments
- List of active services and open workstreams
---
Completion Criteria: - Client is no longer considered ACTIVE anywhere in Zoho
- Client receives no further automated communications
- All open work is properly closed or handed back to client
- Portal account deactivated
---
Exceptions:
- Not eligible = keep ACTIVE: Cancellation requested but not eligible → Keep Account ACTIVE; respond with contract terms; continue payment follow-ups
---
Antonio-Only: Antonio decision (eligibility verification and approval)
---
Portal Rules: Deactivate portal
---
Pipeline: Offboarding (Ticket)
---
Stages: Initiated → Service Termination → Final Billing → Completed
---
Task Template: None — manual process', 'recV8pLBLhA3c3tmq', '2026-03-03T18:51:06.916429+00:00', '2026-04-04T18:20:18.695243+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('95a19ea3-1a0f-429b-9e43-f938a10e2cf3', 'CMRA / Mailing Address', 'CMRA', '# CMRA / Mailing Address SOP v7.0
_Approved by Antonio — March 26, 2026_
_v7.0: Portal-first rewrite. All English. Lease auto-generated by onboarding/formation auto-chain. Client signs lease in portal. CMRA SD tracks annual renewal lifecycle. Matches pipeline_stages v7._

## Overview

CMRA (Commercial Mail Receiving Agency) provides clients with a certified US business address at our Florida office (10225 Ulmerton Rd, Suite 3D, Largo FL 33771). Includes mail receiving, scanning, and forwarding services.

**Key facts:**
- Lease auto-generated by onboarding/formation wizard auto-chain (not manually created)
- Client signs lease inside the portal (e-signature)
- Lease period: annual, through December 31
- Renewal date: December 31 each year (stored in accounts.cmra_renewal_date)
- CMRA SD is created at formation/onboarding CLOSING (Phase 3), NOT in bundled_pipelines
- Year 2+: CMRA SD created by Billing Annual Renewal payment

**Lifecycle:**
1. Lease auto-generated → client signs in portal
2. USPS Form 1583 preparation + notarization
3. CMRA activated on USPS portal
4. Mail handling (ongoing)
5. Annual renewal

---

## Phase 1: Lease Created

**Pipeline stage:** Lease Created (stage_order=1)
**Auto-tasks:** Verify lease auto-generated in portal

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | Lease auto-generated | System | -- | Formation/onboarding auto-chain creates lease (suite auto-assigned, $100/mo, 12 months). Appears in portal "Sign Documents" |
| 2 | Verify lease in portal | Luca | -- | Check lease appears correctly with suite number, dates, amounts |
| 3 | Contact signs lease | Contact | portal | E-sign inside portal. Signed PDF auto-saved to Drive (1. Company/) + portal Documents |
| 4 | Follow-up | System | -- | Portal notifications: Day 3, Day 5, Day 7 (escalation), Day 9 |
| 5 | Advance to Stage 2 | System | sd_advance_stage | → Lease Signed (auto on signature) |

---

## Phase 2: Lease Signed

**Pipeline stage:** Lease Signed (stage_order=2)
**Auto-tasks:** Activate CMRA address and update account

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 6 | Prepare USPS Form 1583 | Luca | -- | Fill Form 1583 with client data from CRM |
| 7 | Collect required IDs | Luca | -- | Two forms of ID from client (already in portal Documents: passport + one more) |
| 8 | Notarize Form 1583 | Antonio | -- | In-house notarization. Antonio signs as notary |
| 9 | Upload to USPS CMRA portal | Luca | -- | Submit Form 1583 + IDs on USPS online system |
| 10 | Confirm CMRA acceptance | Luca | -- | USPS approves the CMRA registration |
| 11 | Update CRM | Claude | crm_update_record | Set cmra_renewal_date = Dec 31 current year |
| 12 | Save documents | Claude | drive_upload_file | Signed lease + Form 1583 to Drive (1. Company/) |
| 13 | Portal notification | System | -- | "Your business address is now active! Suite [number], 10225 Ulmerton Rd, Largo FL 33771" |
| 14 | Advance to Stage 3 | Claude | sd_advance_stage | → CMRA Active |

---

## Phase 3: CMRA Active

**Pipeline stage:** CMRA Active (stage_order=3)
**Auto-tasks:** None (service running, cron handles renewals)

Service is active. No tasks auto-created — ongoing mail handling and renewal tracked by cron.

### Mail Handling (Ongoing)

| # | Step | Who | Detail |
|---|------|-----|--------|
| 15 | Mail received | Luca | Log receipt in CRM, notify client via portal notification |
| 16 | Client requests scan | Contact | Luca scans mail, saves to Drive (5. Correspondence/), portal notification |
| 17 | Client requests forwarding | Contact | Trigger Shipping SOP. Paid shipping — client pays first |
| 18 | Debit cards received | Luca | Hold securely. Trigger Shipping SOP (paid). No ship until client pays |

### Annual Renewal

| # | Step | Who | Detail |
|---|------|-----|--------|
| 19 | Renewal reminder (30 days) | System | Cron checks cmra_renewal_date. Portal notification + task for Luca |
| 20 | Renewal reminder (15 days) | System | Second reminder |
| 21 | Renewal reminder (7 days) | System | Final reminder |
| 22 | New lease generated | System | Auto-generate new lease for next year. Appears in portal |
| 23 | Client signs new lease | Contact | Portal e-signature |
| 24 | CMRA renewed | Luca | Update cmra_renewal_date. New CMRA SD created by Billing Annual Renewal |

---

## Pricing

CMRA is included in annual management fee. No separate charge for active clients.
- Lease: $100/month ($1,200/year)
- Security deposit: $150
- Mail forwarding: paid per occurrence (Shipping SOP)

---

## Rules

| Rule | Detail |
|------|--------|
| Lease auto-generated | By formation/onboarding auto-chain. Not manually created |
| Portal signing = default | Client signs lease in portal. No email with links |
| Portal notifications = alerts | Replace email notifications |
| CMRA only for paid clients | status = Active. If unpaid: Blocked |
| Mail forwarding = always paid | No shipping until client pays |
| Renewal Dec 31 | Annual lease, tracked by cmra_renewal_date |
| Not in bundled_pipelines | CMRA SD created at closing (Phase 3), not at payment |
| Year 2+: via Billing Annual Renewal | Payment triggers new CMRA SD |
| Drive storage | Signed lease + Form 1583 to 1. Company/ |
| Portal billing = official | QuickBooks is fallback only |

---

## Tools

| Tool | What it does |
|------|-------------|
| Portal Sign Documents | Client signs lease in portal |
| Portal notifications | In-app + push alerts to Contact |
| Portal chat | Client communication |
| lease_create / lease_send | Manual creation/sending. Fallback only (auto-chain handles this) |
| drive_upload_file | Save documents to Drive |
| crm_update_record | Update cmra_renewal_date |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | Pipeline stages, lease tools, digital signature |
| 2.0 | 2026-03-19 | Version bump |
| 7.0 | 2026-03-26 | Portal-first rewrite. All English. Lease auto-generated. Portal signing. CMRA SD at closing not payment. Renewal lifecycle. Matches pipeline_stages v7 |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.', '7.0', '[Migrated metadata]
Service Code: SVC-CMRA
---
Trigger: Deal enters Payment Received in Mailing Address pipeline. CMRA is purchased by a client (as part of onboarding/formation or standalone) OR requested by a partner via email.
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Signed CMRA/lease agreement (DocuSign) for Jan 1-Dec 31
- USPS Form 1583 information and IDs
- Notarization capability (Public Notary)
- Client communication channel for mail notifications
---
Completion Criteria: - USPS 1583 approved and CMRA ACTIVE
- Client can receive mail; notifications handled
- All CMRA documents stored in WorkDrive
---
Exceptions:
- Partner purchase: Keep partner email as evidence; treat as standalone Deal
- Client unpaid: Do not activate; set status Blocked
- Mail forwarding = always paid; no shipping until payment received
---
Antonio-Only: None
---
Portal Rules: None
---
Pipeline: CMRA (Ticket)
---
Stages: New Request → Document Collection → USPS Form 1583 → Notarization → Activation → Completed
---
Task Template: 8 tasks (2 rules):
- Renewal reminders: 30/15/7-day before CMRA contract renewal
- Mail received logging: auto-create task on ''mail received''', 'rec6YedbNMMpiPikV', '2026-03-03T18:51:06.916429+00:00', '2026-03-26T18:38:21.549153+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('bcf88e7e-abd8-40a6-88c3-c57494b80cc4', 'Client Onboarding', 'Client Onboarding', '# Client Onboarding SOP v7.0
_Approved by Antonio — March 23, 2026_
_v7.0: Portal-first rewrite. Everything flows through portal. Wizard auto-creates CRM Account on submit (no manual review). OA + Lease signed in portal. Portal notifications replace emails. Lead/Contact/Account terminology clarified. All English._

## How the Portal Works

_(Same as Formation SOP — see Company Formation SOP v7.0 "How the Portal Works" section for the full explanation of portal tiers, notifications, communication, and referrals.)_

---

## Overview

Onboarding for clients with an EXISTING LLC who want annual management services. The LLC already exists — the Contact provides company data and documents through the portal wizard, which automatically creates the CRM Account.

**Key difference from Formation:** No state filing, no EIN application. Contact uploads existing Articles + EIN letter. The wizard creates the CRM Account automatically on submission — no staff review required. The Contact knows their own company information.

**Lifecycle:**
1. Lead arrives → offer created → portal login sent → lead reviews/signs/pays inside portal → becomes Contact
2. Data Collection (portal wizard — onboarding type) → wizard auto-creates CRM Account
3. Post-Onboarding Setup (OA, Lease, Banking — all inside portal)
4. Closing

---

## Phase 0: Sales Pipeline (Lead to Payment)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | Lead arrives | -- | -- | From ANY channel: Calendly, Instagram DM, email, WhatsApp, referral |
| 2 | Discovery call | Antonio | -- | Zoom/phone. Detect referral if applicable |
| 3 | Circleback records call | System | -- | Extracts content |
| 4 | Create lead | Claude | lead_create | Auto or manual. Include referrer_name if referral detected during call |
| 5 | Create offer | Claude | offer_create(contract_type=onboarding) | From call data. Linked to lead. Lives inside the portal — NOT sent via email |
| 6 | Send portal login credentials | Claude | portal_create_user(portal_tier=lead) | Lead receives email with login link + temporary password. No Contact, no Account — just authentication. Offer already waiting inside the portal |
| 7 | Lead logs into portal | Lead | portal.tonydurante.us | Dashboard shows progress: Review Proposal → Sign Contract → Make Payment → Complete Setup |
| 8 | Lead reviews offer | Lead | /portal/offer | Full offer with services, pricing, contract — embedded inside the portal |
| 9 | Lead signs contract | Lead | /portal/offer | Contract signed inside the portal |
| 10 | Lead pays | Lead | -- | Whop (card +5%) or bank transfer. Payment details shown in portal dashboard |
| 11 | Payment confirmed | System | -- | Whop webhook or wire transfer check |
| 12 | **Lead → Contact** | System | -- | Lead status → Converted. Contact created in contacts table from lead data (name, email, phone, language). Auth user updated with contact_id. This is the moment the lead becomes a client |
| 13 | Create invoice | Claude | Portal billing system (QB fallback) | Marked as paid |
| 14 | Portal tier → onboarding | System | -- | Dashboard shows "Complete Setup" linking to wizard |

**RULE**: NO CRM Account exists yet. Only Lead (Converted) + Contact. The wizard creates the CRM Account automatically when the Contact submits.

---

## Phase 1: Data Collection + Auto Account Creation

No CRM Account, no SD — the wizard creates everything automatically on submission.

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 15 | Contact clicks "Complete Setup" | Contact | portal | WelcomeDashboard links to wizard |
| 16 | Contact fills wizard | Contact | /portal/wizard | Auto-detects onboarding type from lead/offer contract_type. Step 1: Owner info (name, email, phone, DOB, nationality, address, ITIN if available). Step 2: Company info (LLC name, state, formation date, EIN, filing ID, business purpose, registered agent, tax return questions). Step 3 (MMLLC): Additional members (name, ownership %, DOB, nationality, address). Step 4: Documents (passport, Articles, EIN letter, SS-4 optional) + disclaimer |
| 17 | Follow-up if not completed | System | -- | Portal notification: Day 3, Day 5, Day 7 (escalation to Antonio), Day 9 (final) |
| 18 | **Contact submits → auto-chain** | System | -- | Everything happens automatically. No staff review required |

**No staff review step.** The Contact knows their own company information. Submission triggers automatic CRM setup.

Fallback: onboarding_form_create + gmail_send + onboarding_form_review(apply_changes=true) only if portal unavailable.

### Auto-Chain: Wizard Submit (Onboarding)

When Contact submits onboarding wizard, system auto-executes ALL of the following:

| # | Step | Detail |
|---|------|--------|
| 1 | Create CRM Account | From wizard data: company_name, EIN, state_of_formation, formation_date. account_type derived from contract rates (Client if annual, One-Time if no installments). services_bundle and rates from signed contract |
| 2 | Link Contact → Account | account_contacts junction (role=Owner) |
| 3 | Create Drive folder | Companies/{State}/{Company Name} - {Owner Name}/ with 5 subfolders |
| 4 | Copy documents to Drive | Passport → 2. Contacts/. Articles + EIN letter → 1. Company/. Register in documents table |
| 5 | Update Contact | DOB, nationality, address, ITIN from wizard data |
| 6 | Create SD | sd_create(service_type=Client Onboarding) with price from offer |
| 7 | Auto-generate OA | Operating Agreement created from Account + Contact data. Appears in portal as "Pending Signature" |
| 8 | Auto-generate Lease | Lease Agreement created (suite auto-assigned, $100/mo, 12 months). Appears in portal as "Pending Signature" |
| 9 | Banking wizard available | Relay (USD) + Payset (EUR) forms appear in portal |
| 10 | Create tasks | WhatsApp group (Luca), RA change on Harbor (Luca) |
| 11 | Tax return check | If Contact answered "No" to tax return questions → auto-create tax_return + SD Tax Return. "Not sure" does NOT trigger |
| 12 | Set renewal dates | ra_renewal_date = today, cmra_renewal_date = Dec 31, annual_report_due_date = per state |
| 13 | Portal tier → active | Contact immediately sees full dashboard with their company |
| 14 | Contact notified | Portal notification: "Your account is set up! Please review and sign your Operating Agreement, Lease, and complete your Banking setup" |
| 15 | Notify staff | Email to support@tonydurante.us + task for Luca |
| 16 | Save to submissions | Data saved to onboarding_submissions for reference |

---

## Phase 2: Post-Onboarding Setup

Everything appears inside the portal. No emails with attachments, no external links.

**Prerequisite:** ONLY if services_bundle includes annual management.
**Auto-trigger:** OA, Lease, and Banking wizard are auto-generated by wizard submit (Phase 1).

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 19 | Contact signs OA | Contact | portal | E-sign inside portal. Signed PDF auto-saved to Drive + portal Documents |
| 20 | Contact signs Lease | Contact | portal | E-sign inside portal. Signed PDF auto-saved to Drive + portal Documents |
| 21 | Contact fills Banking wizard | Contact | portal | Relay (USD) + Payset (EUR) forms inside portal |
| 22 | Contact fills Tax wizard | Contact | portal | Tax data collection. Available when ready |
| 23 | Staff notified per completion | System | -- | Each signature/submission triggers notification to staff |
| 24 | Luca changes RA on Harbor | Luca | -- | Provider change to Harbor Compliance (external) |
| 25 | Classify documents | Claude | doc_bulk_process(account_id) | Auto-classify all uploaded docs |
| 26 | Compliance check | Claude | doc_compliance_check(account_id) | Score >= 80% |

**Follow-up:** Portal notifications at Day 3, 5, 7 (escalation), 9 for each unsigned/incomplete item.

---

## Phase 3: Closing

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 27 | Verify all items complete | System | -- | OA signed, Lease signed, Banking submitted, Tax data received, RA changed |
| 28 | Review request | System | -- | Portal notification to Contact with Google + Trustpilot links. Antonio approves first |
| 29 | Activate Account | Claude | crm_update_record | status=Active, client_health=green |
| 30 | Auto-create RA Renewal SD | Claude | sd_create(service_type=State RA Renewal) | Track first renewal |
| 31 | Auto-create Annual Report SD | Claude | sd_create(service_type=State Annual Report) | NM excluded |
| 32 | Tax Return record | Claude | -- | If applicable |
| 33 | Contact notified | System | -- | Portal notification: "Your setup is complete! Your dashboard is now fully active" |
| 34 | Close SD | Claude | sd_advance_stage(delivery_id) | → completed |

Post-closing: daily cron checks RA + Annual Report. If SD already exists, skip.

---

## Formation vs Onboarding — Key Differences

| Aspect | Formation | Onboarding |
|--------|-----------|------------|
| LLC | To be created | Already exists |
| CRM Account created by | formation_confirm after SOS confirmation | Wizard submit (automatic, no staff review) |
| Articles | Filed by Luca, uploaded to portal | Uploaded by Contact in wizard |
| EIN | SS-4 signed in portal, Luca faxes to IRS | Uploaded by Contact in wizard |
| SS-4 | Auto-generated in portal, Contact e-signs | Not needed (EIN already exists) |
| SD created | At payment | By wizard submit |
| Post-formation/onboarding docs | Available in portal after EIN received | Available in portal immediately after wizard submit |
| RA Harbor | New activation | Provider change |
| ra_renewal_date | = formation_date | = date of RA change (today) |
| Drive folder | formation_confirm creates it | Wizard submit creates it |

---

## Drive Folder Structure

Wizard submit creates: Companies/{State}/{Company Name} - {Owner Name}/ with 5 subfolders:
1. Company/ — Articles, OA, Lease, EIN Letter
2. Contacts/ — Passport, ID docs
3. Tax/ — Tax returns, extensions
4. Banking/ — Bank docs
5. Correspondence/ — Communications

---

## Data Flow — Authoritative Source

| Data | Source | Destination |
|------|--------|-------------|
| Services and prices | offers.services (JSONB) | -- |
| Annual rates | contracts (signed contract) | accounts.installment_1/2_amount |
| services_bundle | contracts (signed contract) | accounts.services_bundle |
| account_type | Derived from rates | accounts.account_type (Client/One-Time) |
| Owner details | contracts + wizard | contacts |
| LLC data | wizard | accounts |
| ra_renewal_date | = date of RA change on Harbor | accounts.ra_renewal_date |
| SD price | offer.services (recommended) | service_deliveries.amount |

---

## Pricing

| Entity Type | Annual Fee |
|-------------|-----------|
| SMLLC | $2,000/year (2 x $1,000) |
| MMLLC | $2,500/year (2 x $1,250) |

**Post-September Rule:** Onboarding after September 1 → skip 1st installment (January) next year. First payment = 2nd installment (June).

---

## Invoicing

| System | Status | Usage |
|--------|--------|-------|
| Portal billing system | Official | Create invoices, send to client, track payments, PDF |
| QuickBooks | Fallback (transition) | Only if portal billing unavailable |

---

## Renewal (Year 2+)

1st installment payment triggers 4 recurring SDs:
- CMRA Mailing Address
- State RA Renewal
- State Annual Report (NM excluded)
- Tax Return

---

## Rules

| Rule | Detail |
|------|--------|
| Portal = single interface | Everything the Contact does happens inside the portal. No email attachments, no external links |
| Portal wizard = default | onboarding_form_create is fallback only |
| Offer inside portal | Lead sees offer inside the portal after login. No offer email sent |
| Portal billing = official | QuickBooks is fallback only |
| Portal chat = communication | Day-to-day communication via portal chat, not email |
| Portal notifications = alerts | Contact gets in-app + push notifications for every action |
| Wizard auto-creates Account | No staff review step. Contact data is trusted |
| OA + Lease signed in portal | Auto-generated by wizard, e-signed inside portal, PDF auto-saved |
| Banking wizard in portal | Relay + Payset forms inside portal |
| Lead → Contact at payment | Lead becomes Contact when they sign + pay. NOT at wizard submit |
| Tax trigger | ONLY "No" to tax questions. "Not sure" does NOT create tax return |
| Referral at lead creation | Detected during call, noted on lead record |
| ra_renewal_date | = date of RA change on Harbor, NOT formation_date |
| Follow-up | Portal notifications: Day 3, 5, 7 (escalation), 9 |
| Official documents | Uploaded to portal Documents section |
| Review | Google + Trustpilot at closing |
| Post-closing | Auto-create RA Renewal + Annual Report SD |
| TD logo | NEVER on client legal documents |

---

## Tools

| Tool | What it does |
|------|-------------|
| Portal wizard (onboarding type) | Primary data collection + auto CRM Account creation |
| Portal billing system | Official invoicing |
| Portal chat | Client communication |
| Portal notifications | In-app + push alerts to Contact |
| Portal document signing | OA, Lease signed inside portal |
| portal_create_user | Creates portal login (auth user). NOT a CRM Account |
| doc_compliance_check / doc_bulk_process | Document compliance |
| onboarding_form_create + onboarding_form_review | Static form + manual review. Fallback only |

---

## Proposals for New Portal Features

| Feature | Description | Benefit |
|---------|-------------|---------|
| **Post-Onboarding Checklist** | Dashboard checklist: Sign OA, Sign Lease, Banking, Tax Info. Auto-checks on completion | Contact always knows what is left to do |
| **Document Expiry Alerts** | Portal shows upcoming expirations (passport, RA, annual report) | Proactive compliance |
| **Review in Portal** | Review prompt inside portal. Contact writes review, staff copies to Google/Trustpilot | Less friction, higher completion rate |
| **Auto Follow-up** | Portal automatically sends reminders for unsigned documents at Day 3, 5, 7, 9 | Staff does not need to manually track |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01 | Initial |
| 5.0 | 2026-03-17 | Follow-up cadence |
| 6.0 | 2026-03-20 | Auto-chain, renewal dates, task notifications |
| 7.0 | 2026-03-23 | Portal-first rewrite. Everything flows through portal. Wizard auto-creates Account (no manual review). OA + Lease signed in portal. Banking wizard in portal. Portal notifications replace emails. Portal chat replaces email communication. Lead/Contact/Account terminology clarified. All English. |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete reference.

### OFFER PAYMENT RULE (P12)
Every offer MUST include BOTH payment methods: Whop checkout link (card +5% surcharge) AND bank transfer details. EUR offers → Airwallex IBAN (DK8989000023658198). USD offers → Relay account (200000306770). The lead always chooses how to pay.

---

## Multi-Contract Offers (April 2026 — commits 1ca20f0, 978d730)

Phase 0 step 9 now involves signing ALL contracts, not just one. Each service in the offer carries a `contract_type` field (from SERVICE_CATALOG via CRM dialog). Services matching the offer''s main type go into the main MSA+SOW. Services with a different contract_type (e.g., ITIN on an onboarding offer) render as separate standalone agreements. Client must sign ALL contracts before checkout.

Even free/included services (e.g., Tax Return at $0) require their own standalone agreement signed.

The CRM offer dialog now includes:
- **Payment Gateway**: Stripe (default, deferred checkout) or Whop (plan at offer creation)
- **Bank Account**: Auto (EUR→Airwallex, USD→Relay), Relay, Mercury, Revolut, Airwallex

Per-service contract_type is passed from SERVICE_CATALOG through the dialog into servicesJson.

### Data Flow Addition
| Data | Source | Destination |
|------|--------|-------------|
| Per-service contract_type | SERVICE_CATALOG via CRM dialog | offers.services JSONB |
| Payment gateway | CRM dialog | offers.payment_gateway |
| Bank preference | CRM dialog | offers.bank_preference |', '7.2', '[Migrated metadata]
Service Code: SVC-ONBOARDING
---
Trigger: Deal enters Payment Received in Onboarding pipeline. A client with an existing LLC accepts the onboarding/management offer and pays the first annuality up-front.
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Signed engagement letter/contract (DocuSign) covering Jan 1-Dec 31 contract-year terms
- Articles/Certificate of Organization (or equivalent formation documents)
- EIN confirmation letter and/or SS-4 copy
- Owner passport copy
- Client residential address (NOT current business address)
- Any existing state identifiers (filing ID) if available
---
Completion Criteria: - Client is fully onboarded in CRM as an ACTIVE managed client
- All required documents are stored in WorkDrive
- All purchased service workstreams are created/activated
- Portal account created and documents uploaded
---
Exceptions:
- Docs missing/incomplete: Keep Deal in ''Awaiting Client Info'' and send reminders
- Client cancels before onboarding completion: Mark Account as INACTIVE and stop automations
---
Antonio-Only: None
---
Portal Rules: Create portal ONLY after Articles + EIN + passport are complete.

Steps:
1. Log in to Portal Admin
2. Create client''s Portal account
3. Portal automatically sends access email
4. Upload collected company documents to Portal
5. Populate dashboard fields (company name, EIN, address)
---
Pipeline: Client Onboarding (Ticket)
---
Stages: Welcome → KYC Verification → Document Collection → System Setup → Service Activation → Orientation Complete → Completed
---
Task Template: 9 tasks (2 rules):
- On ''Onboarding Paid'': Auto-send standardized document request email checklist
- Auto-create tasks for each required document with due dates and reminders', 'rechjQ7xsKBfaxh85', '2026-03-03T18:51:06.916429+00:00', '2026-04-04T18:20:31.425025+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('efb7db81-d540-4b7b-9e06-50c14bd07f19', 'EIN Application', 'EIN Application', '# EIN Application SOP v7.0
_Approved by Antonio — March 26, 2026_
_v7.0: Portal-first rewrite. All English. SS-4 signed in portal (e-signature). Auto-generated via ss4_create. Articles of Organization attached. Luca faxes signed SS-4 to IRS. Matches pipeline_stages v7._

## Overview

EIN (Employer Identification Number) application for newly formed LLCs or existing LLCs without an EIN. The SS-4 form is auto-generated from CRM data, appears in the portal for client e-signature, then Luca faxes the signed form to the IRS.

**Key facts:**
- SS-4 auto-generated via ss4_create from CRM account + contact data
- Client reviews and e-signs SS-4 inside the portal (Sign Documents page)
- Articles of Organization attached as supporting documentation
- Luca faxes signed SS-4 to IRS (physical step)
- Processing: fax = same day to 4-6 weeks. Follow up after 7 business days
- EIN is part of Company Formation pipeline (Stage 3). Can also be standalone

**Lifecycle:**
1. SS-4 auto-generated → appears in portal for signing
2. Client e-signs in portal
3. Luca faxes signed SS-4 to IRS
4. Wait for IRS response
5. EIN received → upload to portal, update CRM

---

## Context: Formation vs Standalone

| Context | How EIN SD is created | Prerequisites |
|---------|----------------------|---------------|
| Company Formation | Part of Formation pipeline Stage 3 (EIN Application). No separate SD — same formation SD | Account exists with company_name, state, formation_date. Articles filed |
| Standalone | Separate offer with bundled_pipelines = ["EIN"]. SD created at payment | Account must exist with company_name, state, formation_date |

For **Company Formation**, the EIN steps below are Phase 3 of the Formation SOP. The standalone pipeline mirrors the same steps.

---

## Phase 1: SS-4 Preparation

**Pipeline stage:** SS-4 Preparation (stage_order=1)
**Auto-tasks:** Currently empty — tasks created manually or by formation pipeline

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | Generate SS-4 | Claude | ss4_create(account_id) | Auto-fills from CRM: company name, EIN type (SMLLC → "Other: Foreign owned disregarded entity", MMLLC → "Partnership"), owner name, address, formation date. Articles of Organization attached |
| 2 | Admin preview | Antonio | -- | Review SS-4 at URL with ?preview=td. Check: company name, entity type, owner info, formation date |
| 3 | SS-4 appears in portal | System | -- | Sign Documents page shows "SS-4 (EIN Application)" with status "Ready for Signature" |
| 4 | Portal notification | System | -- | "Your EIN application (SS-4) is ready for review and signature." |
| 5 | Advance to Stage 2 | Claude | sd_advance_stage | → SS-4 Submitted (after client signs) |

---

## Phase 2: SS-4 Submitted (Client Signs + Luca Faxes)

**Pipeline stage:** SS-4 Submitted (stage_order=2)
**Auto-tasks:** Currently empty

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 6 | Client reviews SS-4 | Contact | portal | Reviews pre-filled SS-4 in portal iframe |
| 7 | Client e-signs | Contact | portal | E-signature in portal. Status → "signed". Luca receives notification |
| 8 | Download signed SS-4 | Luca | -- | Signed PDF available for download |
| 9 | Fax SS-4 to IRS | Luca | -- | Fax signed SS-4 + Articles of Organization to IRS. Fax number: (855) 641-6935 |
| 10 | Record fax confirmation | Luca | -- | Save fax confirmation number in CRM notes |
| 11 | Advance to Stage 3 | Claude | sd_advance_stage | → Awaiting EIN |

---

## Phase 3: Awaiting EIN

**Pipeline stage:** Awaiting EIN (stage_order=3)
**Auto-tasks:** Currently empty

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 12 | Wait for IRS response | -- | -- | Fax: same day to 4-6 weeks. Online (SMLLC only): immediate |
| 13 | Follow up after 7 days | Luca | -- | If no response after 7 business days, call IRS |
| 14 | If IRS rejection | Luca/Antonio | -- | Analyze reason, correct data, re-submit |
| 15 | EIN confirmation received | Luca | -- | IRS sends EIN confirmation letter (fax or mail) |
| 16 | Advance to Stage 4 | Claude | sd_advance_stage | → EIN Received |

---

## Phase 4: EIN Received

**Pipeline stage:** EIN Received (stage_order=4)
**Auto-tasks:** Currently empty

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 17 | Scan EIN letter | Luca | -- | Scan IRS EIN confirmation letter |
| 18 | Save to Drive | Claude | drive_upload_file | EIN letter to Companies/{State}/{Company}/1. Company/EIN Letter.pdf |
| 19 | Update CRM | Claude | crm_update_record(accounts, {ein_number}) | Save EIN number on account record |
| 20 | Upload to portal | Luca | -- | EIN letter in portal Documents section |
| 21 | Portal notification | System | -- | "Your EIN has been received! Number: XX-XXXXXXX" |
| 22 | If Formation: trigger next phase | System | -- | Advance Formation SD to Stage 4 (Post-Formation + Banking). Auto-generates OA, Lease, Banking wizard |
| 23 | Close SD (standalone only) | Claude | sd_advance_stage | → completed |

---

## Entity Type Rules

| Entity type | SS-4 Line 9a | Title on SS-4 | Member count |
|-------------|-------------|---------------|-------------|
| SMLLC | "Other: Foreign owned disregarded entity" | Owner | 1 |
| MMLLC | "Partnership" | Member | From account_contacts count |
| Corporation | "Corporation" | President | 1+ |

---

## Pricing

| Context | Price |
|---------|-------|
| Part of Formation | Included in formation fee |
| Standalone | Per quote (typically EUR 500) |

---

## Rules

| Rule | Detail |
|------|--------|
| SS-4 signed in portal | E-signature. No printing, no mailing for SS-4 signing |
| Fax preferred | Fax to IRS for speed. Online available for SMLLC only |
| Follow up 7 days | If no IRS response after 7 business days, call IRS |
| EIN letter to Drive | Save immediately when received |
| Portal notification | Notify client when SS-4 ready and when EIN received |
| Formation trigger | EIN received → advance Formation SD to Post-Formation phase |
| Articles attached | Articles of Organization included with SS-4 fax |

---

## Tools

| Tool | What it does |
|------|-------------|
| ss4_create | Auto-generates pre-filled SS-4 from CRM data |
| ss4_get | Check SS-4 status and details |
| Portal Sign Documents | Client reviews and e-signs SS-4 |
| Portal notifications | In-app + push alerts |
| drive_upload_file | Save EIN letter to Drive |
| crm_update_record | Save EIN number on account |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | Pipeline stages, Google Drive |
| 2.0 | 2026-03-19 | Version bump |
| 7.0 | 2026-03-26 | Portal-first rewrite. All English. SS-4 signed in portal (e-signature). Auto-generated via ss4_create. Matches pipeline_stages v7 |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.', '7.0', '[Migrated metadata]
Service Code: SVC-EIN
---
Trigger: EIN needed for newly formed company or standalone client. Triggered automatically after Company Formation state filing, or as standalone service when client has existing LLC without EIN.
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- SS-4 form (prepared by Tony Durante LLC)
- Articles of Organization / Certificate of Formation
- Owner identification (passport copy)
- Company details (address, type, members)
---
Completion Criteria: - EIN received from IRS and confirmed
- EIN stored in CRM Account record and WorkDrive
- Client notified with EIN confirmation letter
- Portal updated with EIN document
---
Exceptions:
- IRS rejects application: Review rejection reason, correct data, resubmit
- Delays beyond 4 weeks: Escalate with IRS phone call
- Multiple EIN attempts: Log each attempt in Notes
---
Antonio-Only: None
---
Portal Rules: Upload EIN confirmation to portal
---
Pipeline: EIN Application (Ticket)
---
Stages: New Request → Document Collection → Application Submitted → IRS Processing → EIN Received → Completed
---
Task Template: 5 tasks (1 rule):
- Auto-create SS-4 prep task on New Request
- Auto-create IRS follow-up task 7 days after submission
- Auto-notify client on EIN Received', 'rec7ozpdDuhNIehAn', '2026-03-03T18:51:06.916429+00:00', '2026-03-26T18:40:40.093285+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('4c012022-ae6d-4b36-9535-87b02957eecb', 'ITIN', 'ITIN', '# ITIN Application SOP v7.0
_Approved by Antonio — March 26, 2026_
_v7.0: Portal-first rewrite. All English. Portal wizard = default data collection. ITIN Renewal support. Portal notifications replace emails. Physical mail step unchanged (wet ink required). Matches pipeline_stages updated in Step 1._

## Overview

ITIN (Individual Taxpayer Identification Number) application for foreign LLC owners who do not have a Social Security Number. ITIN is linked to the **Contact** (person), not the Account (company). Expires every 3 years — renewal uses the same wizard with different W-7 reason code.

**Key facts:**
- ITIN is personal (Contact-level), not company-level
- Physical documents required: client prints, signs with wet ink, mails to TD office
- Antonio is IRS Certified Acceptance Agent (CAA) — certifies passport copies
- Processing time: 7-11 weeks after IRS submission
- Can be bundled in formation/onboarding offer or purchased standalone

**Lifecycle:**
1. Sales Pipeline → payment → portal wizard (data collection)
2. Document Preparation (auto-generate W-7, 1040-NR, Schedule OI)
3. Client Signing — client prints, signs wet ink, mails physical package to TD office
4. Documents Received → CAA Review (Antonio certifies passport)
5. Submitted to IRS → IRS Processing → ITIN Approved

---

## Phase 0: Sales Pipeline (Lead to Payment)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | Discovery call | Antonio | -- | Explain ITIN benefits (Stripe, PayPal, credit cards, US credit score) |
| 2 | Create lead | Claude | lead_create | If standalone ITIN |
| 3 | Create offer | Claude | offer_create(contract_type=itin) | Standalone: EUR 800. Bundled in formation/onboarding: EUR 500 |
| 4 | Send portal login | Claude | portal_create_user(portal_tier=lead) | Lead sees offer inside portal |
| 5 | Lead reviews + signs + pays | Lead | portal | Inside portal. Whop (card +5%) or bank transfer |
| 6 | Payment confirmed | System | -- | Whop webhook or wire check |
| 7 | Lead → Contact | System | -- | Lead Converted, Contact created, auth user updated |
| 8 | Create ITIN SD | System | activate-service | From offer.bundled_pipelines. SD at Stage 1 (Data Collection) |
| 9 | Portal tier → onboarding | System | -- | Wizard becomes available |

**Bundled in formation/onboarding:** ITIN SD created alongside Company Formation/Client Onboarding SD. Same payment covers both.

---

## Phase 1: Data Collection

**Pipeline stage:** Data Collection (stage_order=1)
**Auto-tasks:** Verify ITIN wizard available in portal

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 10 | Contact accesses wizard | Contact | portal | ITIN wizard auto-detected from SD service_type. Available in portal dashboard |
| 11 | Contact fills wizard | Contact | /portal/wizard | Step 1: Personal info (first name, last name, name at birth, DOB, country/city of birth, gender, citizenship). Step 2: Foreign address, foreign tax ID, US visa toggle (Yes: type, number, entry date), passport info, previous ITIN toggle (Yes: ITIN number). Step 3: Review + disclaimer |
| 12 | Follow-up | System | -- | Portal notifications: Day 3, Day 5, Day 7 (escalation to Antonio), Day 9 (final) |
| 13 | Wizard submit → auto-chain | System | -- | See Auto-Chain below |
| 14 | Advance to Stage 2 | System | sd_advance_stage | → Document Preparation |

**Fallback:** itin_form_create + itin_form_send only if portal unavailable.

### Auto-Chain: ITIN Wizard Submit

| # | Step | Detail |
|---|------|--------|
| 1 | Update CRM contact | DOB, nationality, address, visa info, passport details |
| 2 | Save data PDF | Complete data package to Drive (ITIN subfolder) |
| 3 | Advance SD | Data Collection → Document Preparation |
| 4 | Auto-generate docs | W-7 (69 fields) + 1040-NR (171 fields) + Schedule OI (65 fields) uploaded to Drive |
| 5 | Email team | Notification to support@ with data + document status |
| 6 | Create task | Review ITIN documents, assigned to Luca |
| 7 | SD history + action_log | Audit trail |

---

## Phase 2: Document Preparation

**Pipeline stage:** Document Preparation (stage_order=2)
**Auto-tasks:** Generate ITIN documents (W-7 + 1040-NR + Schedule OI)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 15 | Review generated PDFs | Luca | -- | Check W-7: name, DOB, address, reason for applying. Check 1040-NR: header, preparer info. Check Schedule OI: citizenship, visa |
| 16 | If corrections needed | Claude | itin_prepare_documents(token) | Regenerate with corrected data |
| 17 | Antonio reviews | Antonio | -- | Final check before sending to client |
| 18 | Advance to Stage 3 | Claude | sd_advance_stage | → Client Signing |

---

## Phase 3: Client Signing (Physical Mail)

**Pipeline stage:** Client Signing (stage_order=3)
**Auto-tasks:** Upload W-7 + 1040-NR to portal for client signature

**IMPORTANT:** This step requires PHYSICAL documents. Client must print, sign with wet ink, and mail to TD office. This is NOT a digital/portal signature — IRS requires original wet ink signatures on W-7 and 1040-NR.

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 19 | Upload docs to portal | Luca | -- | W-7, 1040-NR, Schedule OI appear in portal Documents for client download |
| 20 | Portal notification | System | -- | "Your ITIN documents are ready. Please download, print, sign, and mail to our office." |
| 21 | Client downloads + prints | Contact | portal | Downloads PDFs from portal Documents section |
| 22 | Client signs (wet ink) | Contact | -- | W-7: Signature of Applicant. 1040-NR page 2: Your signature. TWO copies of each |
| 23 | Client prints passport | Contact | -- | TWO color copies, clear, full pages, no fingers/obstructions |
| 24 | Client mails package | Contact | -- | Mail to: Tony Durante LLC, 10225 Ulmerton Rd Suite 3D, Largo FL 33771 |
| 25 | Follow-up | System | -- | Portal notifications: Day 5, Day 10, Day 14 (escalation to Antonio) |
| 26 | Client confirms mailed | Contact | portal chat | Notifies via portal chat that package is mailed |
| 27 | Advance to Stage 4 | Claude | sd_advance_stage | → Documents Received |

---

## Phase 4: Documents Received

**Pipeline stage:** Documents Received (stage_order=4)
**Auto-tasks:** Verify signed documents received

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 28 | Package received at office | Luca | -- | Log receipt date |
| 29 | Verify contents | Luca | -- | 2x signed W-7, 2x signed 1040-NR + Schedule OI, 2x color passport copies |
| 30 | Check signatures | Luca | -- | W-7: wet ink signature? 1040-NR p2: wet ink signature? |
| 31 | Check passport copies | Luca | -- | Clear, color, both pages visible, no obstructions? |
| 32 | If missing/wrong | Luca | -- | Portal notification to client requesting corrections. Keep at Stage 4 |
| 33 | Advance to Stage 5 | Claude | sd_advance_stage | → CAA Review |

---

## Phase 5: CAA Review (Antonio-Only)

**Pipeline stage:** CAA Review (stage_order=5)
**Auto-tasks:** CAA review and passport certification

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 34 | Review all documents | Antonio | -- | Antonio is IRS Certified Acceptance Agent (CAA) |
| 35 | Certify passport | Antonio | -- | Compare passport copies with form data. Stamp and sign as CAA |
| 36 | Prepare COA | Antonio | -- | Certificate of Accuracy (W-7 COA). Antonio signs as CAA |
| 37 | Assemble IRS package | Antonio | -- | W-7 (signed) + 1040-NR + Schedule OI + certified passport copies + COA. Two complete sets |
| 38 | Advance to Stage 6 | Claude | sd_advance_stage | → Submitted to IRS |

---

## Phase 6: Submitted to IRS

**Pipeline stage:** Submitted to IRS (stage_order=6)
**Auto-tasks:** Mail ITIN package to IRS Austin

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 39 | Create shipment | Luca | ShipStation | Certified mail with tracking |
| 40 | Ship to IRS | Luca | -- | IRS ITIN Operation, PO Box 149342, Austin TX 78714-9342 |
| 41 | Record tracking | Luca | -- | Save tracking number in CRM notes |
| 42 | Notify client | System | -- | Portal notification: "Your ITIN application has been mailed to the IRS. Expected processing: 7-11 weeks." |
| 43 | Advance to Stage 7 | Claude | sd_advance_stage | → IRS Processing |

---

## Phase 7: IRS Processing (Waiting)

**Pipeline stage:** IRS Processing (stage_order=7)
**Auto-tasks:** None (waiting period)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 44 | Month 2 follow-up | Luca | -- | Check tracking: delivered? |
| 45 | Month 3 follow-up | Antonio | -- | If no ITIN received, call IRS CAA line for status |
| 46 | If IRS rejection/notice | Antonio | -- | Analyze reason, request missing items, re-submit |

---

## Phase 8: ITIN Approved

**Pipeline stage:** ITIN Approved (stage_order=8)
**Auto-tasks:** Upload ITIN letter to portal + update contact.itin_number, Notify client via portal notification

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 47 | ITIN letter received | Luca | -- | Scan IRS ITIN letter |
| 48 | Save to Drive | Claude | drive_upload_file | ITIN letter to client Drive folder (ITIN/ or 2. Contacts/) |
| 49 | Update CRM | Claude | crm_update_record(contacts, {itin_number, itin_issue_date}) | Save ITIN number + issue date on contact |
| 50 | Upload to portal | Luca | -- | ITIN letter in portal Documents section |
| 51 | Portal notification | System | -- | "Your ITIN has been approved! Number: XXX-XX-XXXX" |
| 52 | Close SD | Claude | sd_advance_stage | → completed |

---

## ITIN Renewal

ITIN expires every 3 years from issue date. Renewal uses the same wizard and pipeline.

| Aspect | New ITIN | ITIN Renewal |
|--------|----------|-------------|
| SD service_type | ITIN | ITIN (same pipeline) |
| Wizard | Same wizard | Pre-fills has_previous_itin=Yes, previous_itin from contact.itin_number |
| W-7 reason | (a) New | (f) Renewal |
| Deadline | None | June 15, every 3 years from itin_issue_date |
| 1040-NR | Required (header only for non-filers) | Required (current year) |
| How client requests | Offer/payment | Portal "Request a Service" |
| Pricing | EUR 500-800 | EUR 500 |

**Renewal detection:** Cron checks contacts.itin_issue_date. 30 days before June 15 (every 3 years), creates portal notification + task for Luca.

**IMPORTANT:** ITIN renewal requires 1040-NR filing = separate Tax Return service if client does not already have one. The renewal W-7 must be attached to a tax return.

---

## Follow-up Cadence

| Day | Stage | Action | Who |
|-----|-------|--------|-----|
| 3 | Data Collection | Portal notification: reminder | System |
| 5 | Data Collection | Portal notification: 2nd reminder | System |
| 7 | Data Collection | Escalation to Antonio | System → task |
| 9 | Data Collection | Final reminder | System |
| 5 | Client Signing | Portal notification: mail reminder | System |
| 10 | Client Signing | 2nd reminder | System |
| 14 | Client Signing | Escalation to Antonio | System → task |
| 60 | IRS Processing | Month 2: delivery check | Luca |
| 90 | IRS Processing | Month 3: IRS call if no ITIN | Antonio |

---

## Pricing

| Context | Price |
|---------|-------|
| Bundled in Formation/Onboarding | EUR 500 |
| Standalone | EUR 800 |
| Renewal | EUR 500 |

---

## Drive Structure

Client Folder/ITIN/ contains:
- ITIN_Data_Summary_{name}.pdf (from wizard review)
- W-7_{name}.pdf (auto-filled)
- 1040-NR_{name}.pdf (auto-filled)
- Schedule_OI_{name}.pdf (auto-filled)
- IRS_ITIN_Letter_{name}.pdf (when approved)

---

## Rules

| Rule | Detail |
|------|--------|
| Portal wizard = default | itin_form_create is fallback only |
| Portal notifications = alerts | Replace email notifications to client |
| Portal chat = communication | Day-to-day communication via portal chat |
| Antonio-Only | CAA certification, passport review, IRS calls |
| TWO copies | Everything in duplicate (W-7, 1040-NR, passport) |
| Wet ink | W-7 and 1040-NR MUST be signed with pen — no digital signature |
| Passport | Clear, color, full pages, no fingers/obstructions |
| ITIN = Contact-level | Linked to person, not company. Stored on contacts.itin_number |
| Renewal every 3 years | From itin_issue_date. Deadline June 15 |
| Physical mail required | Client prints, signs, mails to TD office. Not digital |
| Portal billing = official | QuickBooks is fallback only |

---

## Tools

| Tool | What it does |
|------|-------------|
| Portal wizard (itin type) | Primary data collection |
| itin_prepare_documents | Auto-fills W-7 + 1040-NR + Schedule OI |
| Portal notifications | In-app + push alerts to Contact |
| Portal chat | Client communication |
| Portal Documents | Client downloads generated PDFs |
| crm_update_record | Save ITIN number on contact |
| drive_upload_file | Save documents to Drive |
| itin_form_create + itin_form_send | Static form + email. Fallback only |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 2.0 | 2026-03-19 | Pipeline stages, auto-fill PDFs, tools |
| 3.0 | 2026-03-19 | Full step-by-step with who/what/tool (49 steps) |
| 4.0 | 2026-03-20 | Auto-chain on form submit, task for team |
| 5.0 | 2026-03-23 | Portal wizard update, ITIN Renewal, conditional fields |
| 7.0 | 2026-03-26 | Portal-first rewrite. All English. Portal wizard = default. Portal notifications replace emails. Portal chat replaces WhatsApp. Matches pipeline_stages v7. ITIN Renewal section. Physical mail step unchanged |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.

### OFFER PAYMENT RULE (P12)
Every offer MUST include BOTH payment methods: Whop checkout link (card +5% surcharge) AND bank transfer details. EUR offers → Airwallex IBAN (DK8989000023658198). USD offers → Relay account (200000306770). The lead always chooses how to pay.

---

## Bundled ITIN — Standalone Agreement Required (April 2026)

When ITIN is bundled in a formation or onboarding offer (EUR 500), it renders as a **separate standalone agreement** that the client must sign independently — in addition to the main MSA+SOW. This is because the ITIN service has `contract_type: itin` which differs from the offer''s main `contract_type` (formation/onboarding).

The client sees both contracts on the signing page and must sign ALL before checkout. The ITIN standalone agreement covers the ITIN-specific scope, procedures, and timeline.

Standalone ITIN offers (EUR 800) work as before — single contract, single signature.

The CRM offer dialog now includes Payment Gateway (Stripe/Whop) and Bank Account (Auto/Relay/Mercury/Revolut/Airwallex) dropdowns (commit 978d730).', '7.2', '[Migrated metadata]
Service Code: SVC-ITIN
---
Trigger: Tasks 1-5: Payment Received. Tasks 6-9: Manual status change. Client purchases ITIN service either during Company Formation (discount EUR500) or later/standalone (EUR800).
---
Task Trigger Type: Workflow Rule + Manual Status Change
---
Required Documents:
- Offer accepted + payment confirmed
- Client passport copy (for COA verification) and mailing address
- W-7 and 1040NR prepared by us (pre-filled)
- Client must print and sign originals and mail package to our office

Pricing:
- In Formation Offer: EUR500
- Standalone: EUR800
---
Completion Criteria: - IRS ITIN letter received, scanned, delivered to client, stored in WorkDrive
- ITIN number stored in CRM
- Uploaded to Client Portal
---
Exceptions:
- Client delays mailing package: Keep status ''Waiting Client Package'' and send reminders
- IRS rejection: Create a ''Rejection Resolution'' sub-step set and track until resolved
---
Antonio-Only: Prepare COA as CAA (Antonio is IRS Certified Acceptance Agent)
---
Portal Rules: Upload to portal
---
Pipeline: ITIN (Ticket)
---
Stages: New Request → Document Collection → W-7 Preparation → CAA Certification → Tax Return Prep → Submission to IRS → IRS Processing → ITIN Received → Completed
---
Task Template: 9 tasks (2 rules):
- Workflow Rule for tasks 1-5 (Payment Received trigger)
- Manual Status Change for tasks 6-9
- Renewal tracking: send reminder every 2 years
- Automated renewal outreach', 'recbJKYnO2B5h1tQ2', '2026-03-03T18:51:06.916429+00:00', '2026-04-04T18:20:45.79789+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('1cfbfe52-28fe-4b8a-bbfb-3a66d9e10e8d', 'Banking Physical', 'Banking Physical', '# Banking Physical SOP v1.1
19 Marzo 2026
v1.1: Pipeline stages aligned, Google Drive references updated.

## Pipeline (4 Stages)
1. Scheduling - Schedule in-person bank appointment in Florida. Email bank relationship manager. Coordinate timing with client.
2. Application Prepared - Prepare checklist of required documents. Send to client. Collect all docs before appointment.
3. Bank Visit - Antonio attends appointment/Zoom call. Support account opening process.
4. Account Opened - Account approved and active. Record bank details in CRM. Notify client.

## Required Documents
- Formation docs (Articles of Organization)
- EIN confirmation letter
- Owner passport/ID
- Proof of address
- Bank-specific requirements

## Rules
- Antonio attends all bank appointments (Antonio-Only)
- Debit cards arrive at CMRA address -> notify client, trigger Shipping SOP (paid)
- Save all bank documents to Google Drive (4. Banking/)
- These are PHYSICAL banks (credit/loans available, unlike fintech)

## Version History
| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | Pipeline stages (4), WorkDrive -> Google Drive |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.
Categories: Payment (P1-P11), Client (C1-C6), Services (S1-S5), Communication (M1-M4), Banking (B1-B5), Drive (D1-D7), Technical (T1-T5), Renewal (R1-R5).', '2.0', '[Migrated metadata]
Service Code: SVC-BANK-PHYS
---
Trigger: Deal enters Payment Received in Physical Bank Account pipeline. Client purchases physical banking support (business account, often with personal account).
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Offer accepted + payment confirmed
- Bank relationship manager contact details
- Client availability for appointment (in-person or remote)
- Required bank docs (formation docs, EIN, passport, etc.)
---
Completion Criteria: - Bank account(s) opened and client informed
- Cards received and shipped if requested/paid
---
Exceptions:
- Appointment rescheduled/cancelled: Update record and set reminders
- Bank requests additional documents: Request from client; track until resolved
---
Antonio-Only: Attend appointment (Antonio)
---
Portal Rules: None
---
Pipeline: Banking Physical (Ticket)
---
Stages: New Request → Document Collection → Appointment Scheduled → Bank Visit → Application Processing → Account Active → Completed
---
Task Template: 7 tasks (2 rules):
- Auto-email RM template + auto-create appointment coordination tasks', 'rec8tZgvXutp8mzav', '2026-03-03T18:51:06.916429+00:00', '2026-03-20T15:48:42.460564+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('fa499599-dc5a-40b7-99ff-5591aaea1fe3', 'Support', 'Support', '# Support SOP v1.1
19 Marzo 2026
v1.1: KB search integration, conv_log for tracking, Google Drive references.

## Steps
1. Client message received on support channel (WhatsApp/Telegram/Email).
2. Classify: service delivery request or general support?
3. If service delivery -> create/update appropriate Service Delivery ticket instead.
4. If general support -> create Support task.
5. Research/prepare response: kb_search for business rules, check approved_responses for templates.
6. Antonio reviews and approves response.
7. Send response to client on same channel.
8. Log conversation with conv_log (topic, channel, direction, response).
9. If follow-up needed: set task status to Waiting.
10. When resolved: close task.

## Tools
- kb_search: find business rules and approved response templates
- conv_log: log all client conversations for history
- conv_search: check previous conversations with client
- msg_inbox / msg_read_group: read WhatsApp/Telegram messages
- gmail_search / gmail_read: read email support requests

## Rules
- Antonio-Only: approve all outgoing responses, strategic/billing decisions
- Billing disputes: ALWAYS escalate to Antonio
- Auto-follow-up if Waiting on contact > 48h
- All conversations must be logged with conv_log
- Check KB before answering client questions

## Version History
| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | KB search + approved_responses, conv_log tracking, WorkDrive -> Google Drive |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.
Categories: Payment (P1-P11), Client (C1-C6), Services (S1-S5), Communication (M1-M4), Banking (B1-B5), Drive (D1-D7), Technical (T1-T5), Renewal (R1-R5).', '2.0', '[Migrated metadata]
Service Code: SVC-SUPPORT
---
Trigger: Client sends a support request via WhatsApp, Telegram, or Email that does not belong to any specific service delivery pipeline. General questions, billing inquiries, document requests, etc.
---
Task Trigger Type: Manual + Automation
---
Required Documents:
N/A — varies by request
---
Completion Criteria: - Client question answered
- Ticket closed
- Conversation logged
---
Exceptions:
- Escalation to Antonio for complex/strategic questions
- Billing disputes: always escalate to Antonio
---
Antonio-Only: Approve all outgoing responses. Strategic/billing decisions.
---
Portal Rules: None
---
Pipeline: Support Pipeline (Ticket)
---
Stages: New → Waiting on contact → Waiting on us → Closed
---
Task Template: 2 tasks:
- Auto-create response task on New
- Auto-follow-up if Waiting on contact > 48h', 'recHInNs7nSVcdv8l', '2026-03-03T18:51:06.916429+00:00', '2026-03-20T15:48:42.460564+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('0e278dc1-af9b-4767-8991-f77ce4567365', 'Banking Fintech', 'Banking Fintech', '# Banking Fintech SOP v7.0
_Approved by Antonio — March 26, 2026_
_v7.0: Portal-first rewrite. All English. Banking wizard in portal = default. No "send banking form". Staff monitors application status. Matches pipeline_stages v7._

## Overview

Banking setup for LLC clients: Relay (USD business account) and Payset (EUR IBAN). The banking wizard is available inside the portal — client fills application forms directly. Staff submits applications to providers on client behalf.

**Key facts:**
- Two providers: Relay (USD) and Payset (EUR)
- Mercury: chat assistance only — client submits their own application
- Banking SD is typically bundled in formation/onboarding offer
- Can also be standalone service
- Debit cards arrive at CMRA address → trigger Shipping SOP (paid shipping)

**Lifecycle:**
1. Banking wizard available in portal (after onboarding/formation wizard submit)
2. Client fills banking application forms in portal
3. Staff submits applications to Relay/Payset
4. Provider KYC verification
5. Account opened → client notified

---

## Phase 0: Activation

Banking Fintech SD is created in one of two ways:
- **Bundled:** Part of formation/onboarding offer bundled_pipelines. SD created at payment by activate-service
- **Standalone:** Separate offer with bundled_pipelines = ["Banking Fintech"]. Client pays, SD created

In both cases, the banking wizard becomes available in the portal automatically.

---

## Phase 1: Data Collection

**Pipeline stage:** Data Collection (stage_order=1)
**Auto-tasks:** Verify banking wizard available in portal

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | Banking wizard available | System | -- | After onboarding/formation wizard submit (or after payment for standalone). Relay + Payset forms appear in portal |
| 2 | Contact fills Relay form | Contact | portal | USD business account: company info, owner info, business details, expected volume |
| 3 | Contact fills Payset form | Contact | portal | EUR IBAN: same data collection for European banking |
| 4 | Follow-up | System | -- | Portal notifications: Day 3, Day 5, Day 7 (escalation), Day 9 |
| 5 | Luca verifies data | Luca | -- | Review submitted application data for completeness |
| 6 | Advance to Stage 2 | Claude | sd_advance_stage | → Application Submitted |

**Fallback:** banking_form_create + banking_form_review only if portal unavailable.

---

## Phase 2: Application Submitted

**Pipeline stage:** Application Submitted (stage_order=2)
**Auto-tasks:** Submit banking application

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 7 | Submit Relay application | Luca | Relay portal | Submit on behalf of client using wizard data |
| 8 | Submit Payset application | Luca | Payset portal | Submit on behalf of client using wizard data |
| 9 | Record submission | Luca | -- | Note submission date and reference numbers in CRM |
| 10 | Advance to Stage 3 | Claude | sd_advance_stage | → Awaiting Verification |

---

## Phase 3: Awaiting Verification

**Pipeline stage:** Awaiting Verification (stage_order=3)
**Auto-tasks:** None (waiting period)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 11 | Monitor KYC status | Luca | -- | Check provider portals for KYC progress |
| 12 | If additional docs needed | Luca | -- | Portal notification to client: "Your bank needs additional verification" |
| 13 | Help client with KYC | Luca | -- | Guide client through identity verification if needed |
| 14 | If rejected | Luca | -- | Notify Antonio. Analyze reason. Re-apply or try alternative provider |
| 15 | When approved | Luca | -- | Advance to Stage 4 |
| 16 | Advance to Stage 4 | Claude | sd_advance_stage | → Account Opened |

---

## Phase 4: Account Opened

**Pipeline stage:** Account Opened (stage_order=4)
**Auto-tasks:** Notify client of account opening

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 17 | Portal notification | System | -- | "Your bank account has been opened! Check your portal for account details." |
| 18 | Save bank documents | Claude | drive_upload_file | Save account confirmation, welcome docs to Drive (4. Banking/) |
| 19 | Update CRM | Claude | crm_update_record | Update account.bank_details with account numbers, routing info |
| 20 | Debit card handling | Luca | -- | If debit cards arrive at CMRA → trigger Shipping SOP (paid shipping, client pays first) |
| 21 | Close SD | Claude | sd_advance_stage | → completed |

---

## Providers

| Provider | Type | How | Detail |
|----------|------|-----|--------|
| Relay | USD business account | Staff submits on client behalf | Direct application. Debit card included |
| Payset | EUR IBAN | Staff submits on client behalf | Direct application. European banking |
| Mercury | USD business account | Client submits themselves | Chat assistance only. No direct application |
| Wise | EUR exchange ONLY | Client manages | ONLY for receiving EUR. NEVER for outgoing payments. Risk of account closure |

---

## Pricing

Banking Fintech is typically included in formation/onboarding fee (no separate charge). Standalone: per quote.

---

## Rules

| Rule | Detail |
|------|--------|
| Portal wizard = default | banking_form_create is fallback only |
| Portal notifications = alerts | Replace email notifications to client |
| Portal chat = communication | Day-to-day communication via portal chat |
| Relay + Payset only | Only these two are direct applications by staff |
| Mercury = chat only | Client does their own application |
| Wise = EUR receive only | NEVER for outgoing payments — risk of account closure |
| Debit cards = paid shipping | Cards arrive at CMRA. No ship until client pays |
| Stripe → Relay | Direct USD payout to Relay. Avoid double conversion through Wise |
| Drive storage | All bank documents to 4. Banking/ subfolder |
| Portal billing = official | QuickBooks is fallback only |

---

## Tools

| Tool | What it does |
|------|-------------|
| Portal banking wizard | Primary data collection (Relay + Payset forms) |
| Portal notifications | In-app + push alerts to Contact |
| Portal chat | Client communication |
| drive_upload_file | Save bank docs to Drive |
| crm_update_record | Update account.bank_details |
| banking_form_create + banking_form_review | Static form + review. Fallback only |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 1.1 | 2026-03-19 | Pipeline stages, banking_form tools |
| 2.0 | 2026-03-19 | Version bump |
| 7.0 | 2026-03-26 | Portal-first rewrite. All English. Banking wizard in portal = default. Portal notifications replace emails. Matches pipeline_stages v7 |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.', '7.0', '[Migrated metadata]
Service Code: SVC-BANK-FIN
---
Trigger: Deal enters Payment Received in Online Bank Account pipeline. Client requests fintech banking either (a) as existing client after formation/onboarding, or (b) as standalone prospect.
---
Task Trigger Type: Workflow Rule
---
Required Documents:
- Required bank documents (formation docs, EIN, passport, etc.)
- Client email for KYC/identity verification steps
- Bank portal access (Relay/Payset)
---
Completion Criteria: - Account opened and client confirmed
- Any cards received are shipped/handled per client request
---
Exceptions:
- KYC fails or bank requests more info: Request from client; update status; keep evidence in Notes
- Cards received at CMRA = paid shipping: Hold securely and keep shipping pending until paid
---
Antonio-Only: None
---
Portal Rules: None
---
Pipeline: Banking Fintech (Ticket)
---
Stages: New Request → Document Collection → Application Submitted → Verification → Account Active → Completed
---
Task Template: 6 tasks (2 rules):
- Auto-send bank document request email template based on bank type
- Auto-create follow-up tasks if KYC pending beyond X days', 'rec41ZtxSqYlTwXdv', '2026-03-03T18:51:06.916429+00:00', '2026-03-26T18:37:38.477381+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('0f534069-1103-43c5-a7c9-fe2d3924e6f4', 'RA Renewal', 'State RA Renewal', '# State RA Renewal SOP v7.0
_Approved by Antonio — March 26, 2026_
_v7.0: English rewrite. Portal notification on completion (for portal-enabled clients). Matches pipeline_stages v7 (fixed task→title bug, English)._

## Overview

Annual Registered Agent renewal on Harbor Compliance for all active clients. Non-postponable — renew even if payment is pending. Cost: $35/year paid by TD to Harbor. Zero cost to client (included in annual management fee).

**Key facts:**
- Provider: Harbor Compliance ($35/year per client)
- Non-postponable: renew even if client payment is pending
- Only exception: confirmed offboarding/closure by Antonio → do NOT renew
- ra_renewal_date varies by client origin (see below)
- Do NOT notify client — routine internal task (except portal notification for portal-enabled clients)

---

## ra_renewal_date — Critical Rule

| Client origin | ra_renewal_date | Reason |
|---------------|----------------|--------|
| Company Formation | = formation_date (incorporation anniversary) | Harbor activated at formation |
| Client Onboarding | = date of RA change on Harbor (≈ onboarding date) | RA provider changed to Harbor during onboarding |

### How it is set
- **Formation:** Account creation (Stage 2) sets ra_renewal_date = formation_date
- **Onboarding:** Wizard auto-chain sets ra_renewal_date = today

---

## Phase 1: Upcoming

**Pipeline stage:** Upcoming (stage_order=1)
**Auto-tasks:** Verify account is active and not offboarding, If active: proceed with renewal (non-postponable)

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 1 | SD auto-created | System | cron | 30 days before ra_renewal_date. sd_create(service_type=State RA Renewal) |
| 2 | Verify account active | System | -- | accounts.status = Active |
| 3 | Check offboarding/closure | System | -- | If Company Closure or Offboarding SD exists → do NOT renew. Cancel SD as "Cancelled — Offboarding". Save $35 |
| 4 | Check payment status | System | -- | Even if NOT paid → PROCEED. RA renewal is non-postponable |
| 5 | Create task for Luca | System | -- | "Renew RA on Harbor for {company_name} — expires {ra_renewal_date}" |
| 6 | Advance to Stage 2 | Claude | sd_advance_stage | → Renewal |

---

## Phase 2: Renewal

**Pipeline stage:** Renewal (stage_order=2)
**Auto-tasks:** Log into Harbor Compliance and authorize renewal, Confirm payment $35 and download confirmation, Save confirmation to Drive and update ra_renewal_date

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 7 | Log into Harbor Compliance | Luca | Browser | harborcompliance.com with company credentials |
| 8 | Find client | Luca | Browser | Search by company_name |
| 9 | Verify RA status | Luca | Browser | Confirm RA is active and due for renewal |
| 10 | Authorize renewal | Luca | Browser | Click "Renew" and confirm |
| 11 | Confirm payment $35 | Luca | Browser | Company card. Verify $35 charge |
| 12 | Download confirmation | Luca | Browser | Download PDF/email confirmation from Harbor |
| 13 | Save to Drive | Claude | drive_upload_file | Companies/{State}/{Company Name}/Compliance/RA Renewal {year}.pdf |
| 14 | Update CRM | Claude | crm_update_record | ra_renewal_date = ra_renewal_date + 1 year |
| 15 | Advance to Stage 3 | Claude | sd_advance_stage | → Completed |

---

## Phase 3: Completed

**Pipeline stage:** Completed (stage_order=3)
**Auto-tasks:** Close service delivery

| # | Step | Who | Tool | Detail |
|---|------|-----|------|--------|
| 16 | Portal notification | System | -- | For portal-enabled clients only: "Your Registered Agent has been renewed for another year." |
| 17 | Close SD | System | -- | SD status → completed |

---

## SLA

| Deadline | Action |
|----------|--------|
| 20 days before expiry | Target: renewal completed |
| 10 days before expiry | Alert: urgent notification to Antonio + Luca |
| 5 days before expiry | Escalation: Antonio intervenes directly |

---

## Pricing

| Who pays | Amount | Detail |
|----------|--------|--------|
| TD to Harbor | $35/year | Per client, per renewal |
| Client to TD | $0 | Included in annual management fee |

---

## Rules

| Rule | Detail |
|------|--------|
| Non-postponable | Renew ALWAYS, even if client unpaid. Never let RA expire — legal consequences (loss of good standing, administrative dissolution) |
| Only exception | Confirmed offboarding/closure by Antonio → do NOT renew, save $35 |
| Zero client cost | Included in annual fee. Never invoice separately |
| Do not notify client | Routine internal task. Exception: portal notification for portal-enabled clients |
| ra_renewal_date varies | Formation = formation_date. Onboarding = RA change date. Never assume they match |
| If unpaid but active | Renew anyway, recover payment through standard follow-up cadence |
| Not in bundled_pipelines | RA Renewal SD created at closing (Phase 3) or by annual cron |

---

## Tools

| Tool | What it does |
|------|-------------|
| sd_create | Cron creates RA Renewal SD 30 days before expiry |
| sd_advance_stage | Advance through pipeline |
| drive_upload_file | Save Harbor confirmation to Drive |
| crm_update_record | Update ra_renewal_date |
| Portal notifications | Notify portal-enabled clients on completion |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02 | Initial SOP (migrated from Zoho) |
| 3.0 | 2026-03-15 | Step-by-step with who/what/tool |
| 3.1 | 2026-03-15 | ra_renewal_date origin rules |
| 7.0 | 2026-03-26 | English rewrite. Portal notification on completion. Matches pipeline_stages v7. Non-postponable rule emphasized |

---

## Fixed Business Rules
All workflows must comply with the MASTER RULES (KB article: 370347b6).
Search: kb_search("MASTER RULES") for the complete 43-rule reference.', '7.0', NULL, NULL, '2026-03-15T14:11:46.084529+00:00', '2026-03-26T18:39:00.023023+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('b23eb156-3187-4548-b72f-465337d419d0', 'Offer Preparation from Call Notes', 'Client Onboarding', 'OFFER PREPARATION FROM CALL NOTES

WHEN TO USE: After Antonio has consultation calls with leads and says "prepare offers" or "send the offers".

PREPARATION (before creating anything):
1. Pull the most recent sent offer as reference: offer_list(status=sent, limit=2) then offer_get(token) -- copy the structure, do not invent a new one
2. Pull call notes: cb_list_calls + cb_get_call for Circleback recordings, cal_list_bookings + cal_get_event_details for Calendly booking details
3. If a call has no Circleback recording, check if Antonio has a local recording (ask or check Zoom folder)
4. For each lead, extract from the call notes:
   - Pricing discussed (NEVER assume -- the deal makes the price)
   - Services discussed (formation, ITIN, tax return, onboarding, closure)
   - Add-ons mentioned (ITIN is the most common)
   - Referrer name and type (client or partner)
   - Relocation plans (Malta, Portugal, etc.) -- for intro text context

LEAD SETUP:
1. lead_search for each person -- check if lead already exists
2. If not: lead_create with status=Call Done, call_date, referrer, reason, notes from call
3. If exists: lead_update with call notes and any new info
4. portal_create_user for each lead (email + full_name) -- creates portal login

OFFER CREATION:
1. Language: match the client language. Italian offers: intro_it, next_steps, strategy in Italian. Contract content (services, cost_summary, recurring_costs) ALWAYS in English.
2. Per-service contract_type: Each service in the offer MUST have a contract_type field from SERVICE_CATALOG. The CRM create-offer dialog auto-populates this. Services matching the offer''s main contract_type go into the main MSA+SOW. Services with a different contract_type (e.g., ITIN on a formation offer) render as separate standalone agreements.
3. Services structure:
   - Main service (e.g. Company Formation): NOT optional, recommended=true, pipeline_type set, contract_type matching offer
   - Add-ons discussed (e.g. ITIN): optional=true, recommended=true if discussed favorably, pipeline_type set, contract_type=itin (or tax_return, etc.)
   - Annual maintenance: informational line, price with /year, NO pipeline_type. Not a current charge.
4. Multi-contract signing: Client MUST sign ALL contracts (main + addon standalone agreements) before checkout. Even free/included services (e.g., Tax Return at $0) need their own standalone agreement signed.
5. cost_summary: show FULL total including all optional services. Offer page dynamically adjusts when client deselects.
6. bank_details: Selected via Bank Account dropdown in CRM dialog (Auto/Relay/Mercury/Revolut/Airwallex). Auto = EUR→Airwallex, USD→Relay. Reference = "Surname - Formation LLC YEAR"
7. payment_gateway: Selected via Payment Gateway dropdown in CRM dialog. Stripe (default, deferred checkout at signing) or Whop (plan created at offer creation).
8. bundled_pipelines: include ALL possible pipelines (including optional ones). Deselected pipelines auto-removed at signing.
9. payment_type: checkout (Stripe session created at sign time, not at offer creation)
10. referrer_name + referrer_type (client or partner)
11. Client Portal: The SOW now includes a Client Portal section describing LLC Management tools, Business Tools, Communication (portal chat required), and Mobile App (PWA) installation.

VERIFICATION:
1. Preview each offer: append ?preview=td to the offer URL
2. Check: correct language, correct total, ITIN toggleable, annual maintenance NOT in payment total
3. Verify multi-contract rendering: if addon services present, check standalone agreements appear below main contract
4. Show preview links to Antonio for approval

SENDING (only after Antonio approves):
1. offer_send for each approved offer
2. lead_update status to Offer Sent
3. Action items from calls: intro emails to Malta/Portugal contacts if discussed

COMMON MISTAKES TO AVOID:
- Do NOT hardcode prices -- extract from call notes
- Do NOT write next_steps in English for Italian offers
- Do NOT include annual maintenance in one-time payment total
- Do NOT create Stripe sessions at offer creation -- they are deferred to sign time
- Do NOT send without Antonio reviewing the preview first
- Do NOT forget per-service contract_type on each service
- Do NOT put addon services (ITIN, Tax Return) into the main MSA setup fee -- they have their own standalone agreements', '7.2', NULL, NULL, '2026-04-04T01:49:15.369561+00:00', '2026-04-04T18:18:07.796628+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO sop_runbooks (id, title, service_type, content, version, notes, airtable_id, created_at, updated_at) VALUES ('9ea1e78a-d984-4463-b960-ce144556e98d', 'Articles of Organization → SS-4 retroactive workflow', 'Company Formation', '# Articles of Organization → SS-4 Retroactive Workflow

## When to use
Client LLC has been formed with a state Secretary of State, but CRM was not updated through the normal formation wizard — so the account has no formation_date, no filing_id, possibly wrong state_of_formation, no Company Formation service_delivery, and no SS-4. The Articles PDF is already in Drive (admin uploaded manually or received from filing agent).

Reference case: Valerio Siclari / Nova Ecom Legacy LLC (2026-04-15).

## Prerequisites
- Articles of Organization PDF exists in client Drive folder ``/1. Company/`` subfolder
- Account row exists in ``accounts`` with at least ``id``, ``company_name``, ``entity_type``, ``drive_folder_id``
- Contact row linked to account via ``account_contacts`` (role=Owner)
- Admin user has MCP tool access

## Background: why this is manual today
The system has a document classification rule for Articles of Organization (``lib/classifier.ts:177-180``) but classification is passive — it runs ONLY when someone explicitly calls ``doc_process_file``, ``doc_bulk_process``, or ``doc_process_folder``. There is NO cron or webhook that auto-scans client folders to extract formation_date/filing_id and advance the Company Formation pipeline. Every step below must be triggered manually.

## Step-by-step playbook

### 1. Locate the Articles PDF
Call: ``drive_list_folder(folder_id = "<account drive folder /1. Company subfolder id>")``
Grab the Google Drive file_id of the Articles PDF (filename typically contains "Articles of Organization" or "Certificate of Formation").

### 2. OCR the PDF and extract fields
Call: ``docai_ocr_file(file_id = "<pdf_file_id>", page_mode = "full", max_chars = 8000)``

From extracted text, manually pull:
- **company_name** — confirm match against accounts.company_name
- **state_of_formation** — US state name (e.g. "New Mexico"). DO NOT confuse with contact residence
- **filing_id / File #** — state-issued number
- **formation_date / Date Filed** — normalize to YYYY-MM-DD
- **registered_agent_provider + address** — from Articles
- **entity_type confirmation** — manager-managed, member-managed, SMLLC vs MMLLC

### 3. Write account fields via crm_update_record (NEVER execute_sql for CRM writes per R018)
``crm_update_record(table="accounts", id="<account_id>", updates={"state_of_formation":"...", "formation_date":"YYYY-MM-DD", "filing_id":"...", "registered_agent_provider":"...", "registered_agent_address":"..."})``

### 4. Process the PDF into the documents table (classify + link)
Call: ``doc_process_file(file_id = "<pdf_file_id>", account_id = "<account_id>")``
Result: row in ``documents`` with document_type = "Articles of Organization", category = Company, confidence=high, linked to account.

### 5. Rename Drive folder if needed
Check for typos in folder name (common: double "LLC LLC" when selectedName already includes LLC and ensureCompanyFolder at lib/drive-folder-utils.ts:221 appends another " LLC"). Also correct any owner-name spelling.
``drive_rename(file_id = "<drive_folder_id>", new_name = "<Company> - <Owner>")``

### 6. Create Company Formation service_delivery
``sd_create(account_id="<id>", service_type="Company Formation", contact_id="<primary_contact_id>", assigned_to="Luca", notes="Retroactive creation <date> — Articles filed <filing_date>, Filing ID <id>. SS-4 to follow.")``

This creates SD at stage "Data Collection" and auto-generates 2 stale tasks ("Verify wizard data and passport uploaded", "Check LLC name availability on state portal") which will be closed in step 8.

### 7. Advance stage directly to EIN Application (skip Data Collection + State Filing)
``sd_advance_stage(delivery_id="<sd_id>", target_stage="EIN Application", notes="Retroactive advance: LLC already formed <date> in <state>. Skipping Data Collection + State Filing stages.")``

target_stage with intermediate stage names causes sd_advance_stage to skip and NOT auto-create intermediate stage tasks. At "EIN Application", 2 new auto-tasks are created: "Generate SS-4 for portal signing" and "Fax signed SS-4 to IRS".

### 8. Close the 3 retroactively-satisfied tasks
Query tasks for account via crm_search_tasks, then close with crm_update_record (table=tasks, id=<task_id>, fields {status=Done, completed_date=<today>, notes=<why>}):
- "Verify wizard data and passport uploaded" — passport already in Drive ``/2. Contacts/``
- "Check LLC name availability on state portal" — moot, already filed
- "Generate SS-4 for portal signing" — will be done in step 9

Leave "Fax signed SS-4 to IRS" OPEN — Luca handles it after client signs.

### 9. Create SS-4 via ss4_create
``ss4_create(account_id="<id>", contact_id="<primary_contact_id>", entity_type="SMLLC")`` (or MMLLC / Corporation)

Prerequisite: accounts.formation_date must NOT be null — enforced at lib/mcp/tools/ss4.ts:25. If step 3 was skipped, this call fails.

Returns: ss4_applications row with token ``ss4-<slug>-<year>`` and admin preview URL ``https://app.tonydurante.us/ss4/<token>/<access_code>?preview=td``.

NOTE: ss4_create tool may timeout in MCP client (API still commits). After timeout, verify with ``ss4_get(account_id="<id>")`` — if returned, SS-4 was created successfully.

### 10. Share admin preview link with Antonio for review
Provide the ``?preview=td`` URL. He verifies entity type, member/owner, address, signature placeholder before notifying client.

### 11. Verify portal visibility BEFORE notifying client
Confirm contact can reach ``/portal/sign``:
- contacts.portal_tier can be ''onboarding'' or ''active'' — middleware.ts:134-143 only gates on role=''client'', no tier check
- lib/portal/queries.ts:10-29 filters accounts by status IN (Active, Suspended)
- app/portal/sign/page.tsx:85-91 ss4 query filters only by account_id, no status/tier filter
- raw_app_meta_data.contact_id must be set on auth user (check auth.users via execute_sql)

### 12. Notify client via portal chat + conv_log
``portal_chat_send(account_id="<id>", message="<Italian or English per contact.language>")``

For Italian clients: "Ciao <name>, l''SS-4 è pronto per essere firmato. Puoi firmarlo nel portale (sezione ''Firma Documenti'') per procedere con la richiesta dell''EIN."

Log the interaction: ``conv_log(account_id="<id>", contact_id="<id>", channel="Portal", direction="Outbound", category="Onboarding", topic="SS-4 ready for signature notification", response_sent="<message>", response_language="<it|en>", handled_by="Claude")``

## After the client signs
- SS-4 status flips from draft → signed automatically
- "Fax signed SS-4 to IRS" task (from step 7) becomes actionable — Luca faxes
- After IRS returns EIN → upload EIN letter to Drive → doc_process_file → crm_update_record accounts.ein_number → sd_advance_stage to "EIN Submitted" → "Post-Formation + Banking" → welcome_package_prepare for OA/Lease/banking

## Common data quality issues to watch for
1. **state_of_formation = contact residence** (e.g. "Dubai", "Milano") — always wrong, should be US state
2. **Contact full_name misspelled** — rename via crm_update_record (UI edit is blocked today, see dev_task d99e36a4)
3. **Drive folder has double "LLC LLC"** — ensureCompanyFolder at lib/drive-folder-utils.ts:221 appends " LLC" to selectedName; if selectedName already contains "LLC", you get the duplicate
4. **Empty shell contact folder at TD Clients/Contacts/<Name>/** — migrateContactToCompany at lib/drive-folder-utils.ts:279-339 moves files but does not delete the source folder by design. Leave it.
5. **contact.portal_tier vs account.portal_tier desync** — tracked separately in P0.8.f, do not touch unless Antonio asks', '1.0', 'Created 2026-04-15 based on Valerio Siclari / Nova Ecom Legacy LLC reference case. Every step verified against live MCP tool invocations during that session. If the system ever grows an automated Articles→SS-4 pipeline (classification webhook + auto field extraction + auto SS-4 generation), this SOP becomes a fallback for edge cases. Related dev_tasks: d99e36a4 (contact name edit UI), 809aa59d (invoice-number fallback). Related commits: 8e3d213 (portal chats), a65b475 (TD invoice reminder delegate).', NULL, '2026-04-15T16:24:18.228281+00:00', '2026-04-17T23:13:22.394536+00:00') ON CONFLICT (id) DO NOTHING;

-- approved_responses: 77 rows
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('431939c0-ed42-4c96-b2fd-03e56208dff8', 'TEMPLATE — Wise vs Banca Americana (Compliance + CRS + Relay)', 'Banking', '["Wise", "Relay", "IBAN EUR", "compliance", "Banking"]', NULL, 'Italian', '[NOME], Wise permette di aprire un conto a una LLC americana semplicemente perché la agevola nell''avere un IBAN. Chi utilizza la LLC per vendere in Europa usa Wise per incassare nella valuta in cui vende.

Però dopo che incassi, su Wise devi convertire in dollari e portare tutto nella banca americana. Perché? Perché è lì che Wise guadagna — sulla conversione. Se usi Wise così com''è in euro, Wise non guadagna mai su di te e prima o poi ti chiude il conto.

È sempre meglio avere un piano B. Relay ti dà anche l''IBAN. Se non ce l''hai ancora possiamo aprirlo noi d''ufficio, gratuitamente.

Nota CRS: Quando utilizzi Wise in euro, quelle transazioni sono alla luce del sole nel sistema CRS (Common Reporting Standard). Tu hai fatto la LLC per un motivo: in modo che tutte le transazioni in dollari rimangano in America.', 0, NULL, 'Scenario: Cliente che usa Wise in euro con la LLC
Trigger: Un cliente chiede di pagare in euro, usa Wise per spendere in euro con la LLC, o non capisce perché deve operare in dollari', 'recGgLwRdADPifK7Z', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('c007ceb2-b14a-450f-829b-a493f5d4ff41', 'Tax return deadline March 15th', 'Tax', '["tax return", "deadline", "Tax"]', NULL, 'English', 'Hey Peter! The tax return deadline is March 15th this year.

If you want us to handle it like last year, it''s $1,500. Just give us the green light and we''ll send the invoice. As soon as the IRS starts accepting returns, we''ll kick off the data collection process.

Let me know!', 0, NULL, 'Scenario: Client: Peter. Channel: WhatsApp/Email. Topic: Tax return deadline March 15th', 'rec2sceU8JwKqaDJH', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('bd9ea597-3331-4d9a-a99e-cfe50ca3b13d', 'Address-only service', 'Onboarding', '["address", "Onboarding"]', NULL, 'Italian', 'Ciao William! Sì, vendiamo anche il servizio di solo indirizzo.

Il costo è $1.500/anno per i singoli che lo richiedono.

Per i partner che ne vendono almeno 3 al mese, il costo scende a $1.200/anno. Se ti interessa diventare partner per rivendere il servizio, possiamo parlarne.

Però se si tratta di una LLC, considerando che poi ci sono i costi di gestione, supporto, tax return, ecc. — conviene fare direttamente la gestione completa con noi. Alla fine il rapporto qualità/prezzo è molto migliore.

Fammi sapere!', 0, NULL, 'Scenario: Client: William. Channel: WhatsApp. Topic: Address-only service', 'rec2z7Pd0gzc6UDxv', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('40da9e85-0a0e-4216-9f0d-abd6036c0216', 'Post-contract acceptance', 'Onboarding', '["onboarding"]', NULL, 'Italian', 'Ciao Valerio,

abbiamo ricevuto il contratto firmato e il pagamento, grazie mille!

Quando puoi, inviaci 3 nomi da dare alla società in ordine di preferenza, così prendiamo il primo disponibile.

Per quanto riguarda il passaporto, appena lo hai pronto faccelo avere subito così procediamo.

Grazie e a presto!', 0, NULL, 'Scenario: Client: Valerio. Channel: Email. Topic: Post-contract acceptance', 'rec355cw44BQ2qoLq', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('fd45e7e7-f2bc-4c18-8933-24acfb245a3d', 'Secured Card - Come Funziona + Percorso Credit Score', 'Banking', '["credit score", "Banking"]', NULL, 'Italian', 'Ciao [NOME]! La Secured Card funziona con un deposito cauzionale — il tuo limite di credito sarà uguale a quello che depositi (di solito $200-$500).

Il suo scopo principale è costruire il tuo credit score americano. Lascia sempre il 3-5% del saldo come debito residuo — non ripagarla mai al 100%.

Se vuoi accelerare il processo, puoi aprire più di una Secured Card con banche diverse.

Per monitorare il credit score: Equifax, Experian, Credit Karma, MyFICO, True Finance, Bilt App, Firstcard, Ava Finance, BuildUp.

Percorso: Secured Card → utilizzo corretto → monitori score → carte vere con limiti alti.', 0, NULL, 'Scenario: Secured Card usage, credit score building, monitoring platforms
Trigger: Client asks about Secured Card, credit score, how to build credit in the US
Channel: WhatsApp
Key Points: - Secured Card = deposito cauzionale, limite basso ($200-$500)
- NON ripagare mai al 100%, lasciare sempre 3-5% del saldo
- Si possono aprire più Secured Card per accelerare
- Lista piattaforme monitoraggio con ITIN
- Percorso: Secured → score cresce → carte vere (Amex/Chase)
Do NOT Say: - Non consigliare carte specifiche
- Non garantire tempistiche per il credit score
- Non dire che la Secured Card è buona per business spending quotidiano', 'rec4k1lRqAD8ZUQft', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('75e207a2-f673-4f0c-bf6e-f6ef1d437a7d', 'Onboarding vs annual management clarification', 'Billing', '["onboarding", "Billing"]', NULL, 'Italian', 'Ciao Loren!

Apprezzo la precisione, quindi ti rispondo con altrettanta chiarezza.

A dicembre 2023 hai pagato $849 di onboarding — e quello copriva l''ingresso e l''avvio del rapporto, ok.

A gennaio 2024 hai pagato $129, ma quelli non c''entrano niente con la gestione: erano per il BOI, la nuova normativa FinCEN entrata in vigore a gennaio 2024. Stop. Quindi in totale $978 — e ti abbiamo fatto $849 + $129 proprio per non farti pagare di più.

A febbraio 2025 hai pagato la gestione 2025. A dicembre 2025 hai pagato sempre il 2025. E ora continui con il 2026. È così che funziona.

Ti chiarisco anche un altro punto: non esistono \"due quote separate\" — una per il rinnovo e una per le tasse. Tu stai pagando un contratto di assistenza e consulenza con uno studio qui negli Stati Uniti. Funziona così: è un contratto unico, non è diviso \"una rata per una cosa e una rata per un''altra\".

Visto che sei così preciso e fiscale — cosa che apprezziamo — ti invieremo anche il contratto da firmare, così è tutto nero su bianco.

Però, siccome i pagamenti sono tutti legittimi e tutto è chiaro, ci stiamo perdendo su un bel po'' di messaggi che mi stanno facendo perdere molto tempo stamattina.

Se per voi va bene, procediamo così. Altrimenti ne parliamo.

Fammi sapere!', 0, NULL, 'Scenario: Client: Loren. Channel: WhatsApp. Topic: Onboarding vs annual management clarification', 'rec4wVF0EdSmOmucE', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('4d5aae6c-e368-4066-b49b-58b9ad4a0800', 'Manager-managed structure concerns', 'LLC Structure', '["manager-managed", "LLC Structure"]', NULL, 'English', 'Hi Mike,

Thanks for the clarification.

However, I have some concerns about this structure that I''d like to share.

1. Management structure disclosure:
While it''s true that Wyoming doesn''t require listing managers in the Articles of Organization, the management structure (member-managed vs. manager-managed) is a fundamental aspect that should be clearly established.

2. IRS Responsible Party requirements:
This is where my main concern lies. According to the IRS, the EIN Responsible Party for an LLC must be an LLC Member (owner). In a Single-Member LLC, the EIN Responsible Party must be the sole LLC Member. The IRS is very clear: the responsible party must be an individual who has control over, or entitlement to, the funds or assets in the entity.

Furthermore, the IRS does not allow you to name a nominee as your responsible party on your EIN application. A manager can only be the responsible party if he or she is also a general partner or owner of the business.

3. Private agreements vs. official filings:
Having a private management agreement where FreshOps is designated as manager is fine for internal purposes. However, the manager carries responsibilities, and managers are named in the operating agreement.

4. Bank account opening:
Stefano, as the owner, can absolutely open bank accounts on behalf of the LLC — not because FreshOps delegates this authority to him through a document, but because he is the actual owner of the company.

The procedure you''ve described — where FreshOps acts as manager through private agreements and then \"delegates\" authority back to the owner — creates unnecessary complexity and potential confusion with banks and the IRS.

I''m happy to discuss this further if needed.

Best,
Tony', 0, NULL, 'Scenario: Client: Mike. Channel: Email. Topic: Manager-managed structure concerns', 'rec6DCyJXT3S2gztC', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('5841c9f2-0271-4e9a-b04b-003477856ecb', 'NIUM document request from Relay', 'Banking', '["Relay", "NIUM", "Banking"]', NULL, 'Italian', 'Buongiorno Dante!

Ho visto la richiesta di Relay. Tranquillo, contattiamo il nostro responsabile per capire bene come gestire la cosa e poi ti aiutiamo insieme a preparare le risposte e i documenti necessari.

Tra l''altro, questo tipo di richieste è sintomo che NIUM è una piattaforma molto seria e affidabile — fanno le cose per bene!

Ti aggiorno appena ho novità!', 0, NULL, 'Scenario: Client: Dante Basco. Channel: WhatsApp. Topic: NIUM document request from Relay', 'rec6JvJ8dQGXNJ2Fy', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('de237d4a-2c27-4627-892f-30e17ff869f2', 'Payment confirmation and onboarding', 'Onboarding', '["onboarding", "payment confirmation"]', NULL, 'English', 'Hi Michael,

Thank you for your payment — we have successfully received the $1,800 USD.

Regarding the invoices not arriving automatically, we''ll look into this on our end to ensure you receive them properly going forward.

We will proceed with the onboarding of your LLC today and will be in touch shortly with the next steps.

If you have any questions in the meantime, feel free to reach out.

Best regards,
Tony Durante LLC', 0, NULL, 'Scenario: Client: Michael. Channel: Email. Topic: Payment confirmation and onboarding', 'rec6RRt1k6o2YPCDR', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('b41062fd-a944-48e2-9fd2-0ac3f6f28711', 'Relay documents (Operating Agreement + portfolio)', 'Banking', '["Relay", "Banking"]', NULL, 'Italian', 'Ciao Antonio! Sì, certo che ti aiutiamo.

Per il punto 1 (documentazione su management e shareholding), ti prepariamo noi l''Operating Agreement da inviare.

Per il punto 2 (portfolio prodotti o partner agreements), hai per caso un accordo con la società per la quale lavori — quella che fa gli impianti? Se sì, mandacelo che lo inviamo. Altrimenti dimmi cosa hai e vediamo insieme cosa possiamo preparare.

Fammi sapere!', 0, NULL, 'Scenario: Client: Antonio Aruta. Channel: WhatsApp. Topic: Relay documents (Operating Agreement + portfolio)', 'rec8Fpa9Q219sIVtD', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('2dcc6bff-5fe1-4ee6-ac4c-f4b0ecfd576d', 'LLC Closure - Complete procedure', 'Closure', '["closure"]', NULL, 'Italian', 'Ciao Matteo!

Per la chiusura della LLC, la procedura è questa:

1. Chiudere tutti i conti bancari associati alla LLC
2. Saldare eventuali debiti o obblighi pendenti
3. Fare il Tax Return finale (nel 2027 per l''anno fiscale 2026)
4. Chiudere l''EIN presso l''IRS
5. Fare la dissolution formale presso lo Stato
6. Cancellare il Registered Agent

Prima di procedere, ti consiglio di fissare una call con noi per valutare bene la situazione e assicurarci che sia la scelta giusta.

Fammi sapere!', 0, NULL, 'Scenario: Client: Matteo Carasso. Channel: WhatsApp. Topic: LLC Closure - Complete procedure', 'rec8ISaozjKOBS7Mp', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('25841870-8092-4434-a72f-3c8d3fab4768', 'Relay stability + physical US account', 'Banking', '["Relay", "Banking"]', NULL, 'Italian', 'Ciao Filippo! Ti dico molto francamente: quello che si dice nei gruppi a me interessa poco. A me interessa quello che succede ai miei clienti.

Relay è una banca superstabile e molto efficiente. Noi abbiamo dei contatti diretti con loro in qualità di commercialisti americani, e questo ci permette di avere un rapporto interno e risolvere i problemi quando si presentano. Quello che succede ad altri che non sono miei clienti, purtroppo non ne posso rispondere — se hanno problemi, l''unica cosa che possono fare è chiedere aiuto a chi li segue.

Per quanto riguarda Sokin: non è una banca, è un exchange come Wise o Airwallex. Non devi richiedere nessuna carta lì — l''unica carta che vuoi usare è quella delle banche americane (Relay, Mercury).

Per il conto fisico in America: non c''è modo di aprirlo a distanza, devi venire di persona. Non puoi delegare a me perché le banche americane sono molto rigide su questo, non si può fare.

L''unica alternativa possibile sarebbe aprire un conto con Pacific National Bank, che ha sede a Miami ed è una banca fisica. Però per farlo dovremmo registrare la tua LLC in Florida solo ai fini bancari — da lì poi si può aprire il conto, anche da remoto. Se ti interessa questa opzione, ne parliamo.

Nel frattempo stai tranquillo con Relay. Se c''è un problema, possiamo intervenire. Ti consiglio comunque di avere sempre un secondo conto (tipo Mercury) come piano B.

Fammi sapere!', 0, NULL, 'Scenario: Client: Filippo Giorgioni. Channel: WhatsApp. Topic: Relay stability + physical US account', 'rec8vJ29bpEQYIrkg', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('5f188ba7-f844-4a25-9a01-453b1bcf67e4', 'Payment clarification 2023-2026', 'Billing', '["Billing"]', NULL, 'Italian', 'Ciao Lorenc!

Grazie per aver scritto tutto in modo così dettagliato — apprezzo che tu voglia chiarire, e lo voglio anch''io perché ci tengo che il rapporto sia trasparente.

Provo a riallinearci sui numeri:

Quando sei passato con noi a fine 2023, il costo è stato $850 + $129 (per la pratica FinCEN/BOI che c''era in quel periodo) — quindi in totale $979, non $2.000. Quello era il costo di ingresso/transizione, non una gestione annuale completa.

Per quanto riguarda l''IRS 2023 ($700), ci eravamo accordati su quella cifra ridotta proprio perché avevi già sostenuto dei costi con i precedenti commercialisti.

Però il costo standard della gestione annuale con Tony Durante LLC è di $2.000 all''anno.

Se guardi i pagamenti:
- 11 dicembre 2024 → $1.000 (prima metà gestione 2025)
- 29 dicembre 2025 → $1.000 (seconda metà gestione 2025)
- Gennaio 2026 → $1.000 (prima metà gestione 2026)
- Giugno 2026 → $1.000 (seconda metà gestione 2026)

Sono $2.000 per il 2025 e $2.000 per il 2026 — la gestione annuale standard.

Il pagamento di dicembre 2024 si riferiva al 2025, non al 2024. Se avessimo considerato quel pagamento come \"gestione 2024\", allora avremmo dovuto fatturarti di nuovo a febbraio 2025 e poi a dicembre 2025 — e ti saresti ritrovato con fatture ravvicinate. Invece abbiamo cercato di spalmare i pagamenti in modo più ordinato.', 0, NULL, 'Scenario: Client: Lorenc. Channel: WhatsApp. Topic: Payment clarification 2023-2026', 'recBosAZL044hE3bd', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('cf7c18f3-a343-4dc2-b29b-9842f2d47edd', 'TEMPLATE — Piattaforme Credit Score Monitoring (con ITIN)', 'Banking', '["credit score", "ITIN", "Banking"]', NULL, 'Italian', '1. Equifax (my.equifax.com) — inserisci l''ITIN nel campo SSN, VantageScore 3.0 gratis
2. Experian (experian.com)
3. Credit Karma — monitoraggio continuo gratuito
4. MyFICO (myfico.com)
5. True Finance (jointrue.com) — VantageScore 3.0 da Equifax
6. Bilt App — accesso al FICO 9 di Experian
7. Firstcard — accetta ITIN, passaporto e visa
8. Ava Finance — credit building + monitoraggio
9. BuildUp', 0, NULL, 'Scenario: Lista piattaforme per controllare il credit score con ITIN (no SSN)
Trigger: Messaggio standard per clienti che chiedono come monitorare il credit score', 'recCB7u7qkJqLtEj3', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('d2e09d84-2c43-4297-8067-def376d6d30a', 'Pricing clarification', 'Billing', '["pricing", "Billing"]', NULL, 'Italian', 'Ciao Davide, ho controllato tutto. Gli $800 erano per il rinnovo annuale della gestione. Questi $800 per il 2025 non sono stati fatturati.

Per il 2026: $1000 a gennaio e $800 a giugno.

Riepilogando:
- $800 → saldo 2025 (da fatturare ora)
- $1000 → gennaio 2026
- $800 → giugno 2026

Fammi sapere!', 0, NULL, 'Scenario: Pricing clarification and 2025 billing
Channel: WhatsApp', 'recIRJzRVFXMYfMoo', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('c00a78ed-76e8-4580-9dc3-371a10dfa117', 'Payment confirmation', 'General', '["payment confirmation", "General"]', NULL, 'Italian', 'Buongiorno Alida! Quanto tempo, ci fa piacere sentirti! Spero che tu stia bene.

Ne approfittiamo per farti gli auguri di buon anno!

Sì, quelli sono i dati corretti per fare il bonifico. Magari avvisaci appena lo hai fatto, grazie!', 0, NULL, 'Scenario: Payment confirmation and bank details
Channel: WhatsApp', 'recIvJDyA0p891UWa', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('f8b96d66-91c8-45b5-ad85-00f3237296ee', 'Personal vs business account - wrong answers', 'Banking', '["Pacific Bank", "personal vs business", "Banking"]', NULL, 'Italian', 'Ciao Riccardo,

la banca ha revisionato la documentazione che abbiamo inviato e ci ha risposto che, in base alle informazioni fornite, ritiene che tu abbia bisogno di un conto business e non di un conto personale.

Il motivo è che alcune descrizioni che hai scritto fanno chiaramente riferimento ad attività business. Ti riporto i punti critici:

Purpose of Account:
\"Personal savings, receiving payments from international freelance software consulting contracts, and daily living expenses...\"

Account purposes:
- \"Receiving payments from international software consulting clients (wire transfers)\"
- \"Incoming wire transfers from clients (monthly payments for software development services)\"

Source of Income:
\"Self-employed software consultant specializing in full-stack development and IT consulting\"
\"Company Name: Taurus Agency (independent contractor/sole proprietorship)\"

Come puoi vedere, queste descrizioni indicano chiaramente un''attività professionale/business (clienti, contratti, pagamenti per servizi, nome azienda, ecc.).

Per procedere con l''apertura del conto PERSONALE, devi rivedere completamente queste risposte e riscriverle in modo che riflettano un utilizzo esclusivamente personale del conto, senza riferimenti a clienti, contratti, servizi professionali o attività lavorativa.

Ti chiedo quindi di rimandarci l''email con le risposte corrette il prima possibile.', 0, NULL, 'Scenario: Client: Riccardo Neamtu - Pacific Bank. Channel: Email. Topic: Personal vs business account - wrong answers', 'recCk9bO0QdJyFNcO', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('cc8cd534-6029-4dd2-a173-614f00bf1c76', 'Client intro - banking infrastructure', 'Onboarding', '["Onboarding"]', NULL, 'English', 'Hey Mike!

Thanks for reaching out — happy to help your client.

Sure, no problem at all. Before we proceed, it would be helpful to know a bit more about him:
- What type of business does he have?
- What type of LLC does he already have (single-member, multi-member)?
- What kind of banking is he looking for — fintech (like Mercury, Relay) or traditional physical banks?
- Does he need multi-currency accounts or just standard US banking?

Regarding the address service, he will need it regardless, because without a physical US address with a lease agreement, banks are very unlikely to open accounts.

As for the ITIN, no problem at all — we handle that regularly.

Feel free to make the intro directly. Just send an email to both of us so we''re all connected, and we''ll take it from there.

Looking forward to it!

Best regards,
Tony', 0, NULL, 'Scenario: Client: Michael Darby. Channel: Email. Topic: Client intro - banking infrastructure', 'recFVg5T33uweBcGX', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('315a153f-a8eb-4977-b692-1db05a6439be', 'Taxes on transactions between LLCs', 'LLC Structure', '["inter-LLC transactions", "LLC Structure"]', NULL, 'Italian', 'Ciao Matteo! Ottima domanda, te la chiarisco subito.

No, tu non devi pagare nessuna tassa sui soldi che invii, ricevi o scambi con altre LLC americane. Le transazioni business-to-business tra LLC non generano tasse aggiuntive per te.

Il tuo amico gestirà quel pagamento in base alla situazione della sua LLC — ma quello è affar suo, non tuo.

Quindi tranquillo: fai business normalmente, nessuna tassa extra da pagare sopra!

Fammi sapere se hai altri dubbi!', 0, NULL, 'Scenario: Client: Matteo Mangili. Channel: WhatsApp. Topic: Taxes on transactions between LLCs', 'rec2jPi4GAKhldGKw', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('5709aafc-87fb-408d-ba51-0244a9ac3a92', 'Pricing clarification and 2025 billing', 'Billing', '["pricing", "Billing"]', NULL, 'Italian', 'Ciao Davide,

ho controllato tutto questa mattina. Gli $800 erano effettivamente per il rinnovo annuale della gestione, come ti avevo detto — quindi a voi è stato applicato uno sconto ulteriore di $49 rispetto al prezzo standard di $849.

Il punto è che questi $800 per il 2025 non sono stati fatturati. Quindi per chiudere il 2025 dobbiamo ancora fatturarvi questi $800.

Per il 2026, come promesso, restiamo sulla parola data: noi non aumentiamo i prezzi e non ci rimangiamo gli accordi. Quindi sarà $1000 a gennaio e $800 a giugno — sempre per farvi una cortesia e mantenere il rapporto.

Ci dispiace per il disguido della mancata fatturazione nel 2025, anzi ti ringraziamo per averlo fatto emergere.

Riepilogando:
- $800 → saldo 2025 (da fatturare ora)
- $1000 → gennaio 2026
- $800 → giugno 2026

Se tutto va bene, continuiamo così. Se invece preferiste non continuare il rapporto, ci dispiacerebbe tantissimo, però gli $800 del saldo 2025 restano comunque dovuti.

Fammi sapere!', 0, NULL, 'Scenario: Client: Davide Pio Guerra. Channel: WhatsApp. Topic: Pricing clarification and 2025 billing', 'recGoZxj01betdgkh', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('2f6f0592-1b11-41cc-9e40-571eec53619f', 'Relay international wires reactivated', 'Banking', '["Relay", "wire transfer", "Banking"]', NULL, 'Italian', 'Ciao Claudia! Buon anno anche a te!

Ottime notizie: Relay ha riattivato i bonifici internazionali! Hanno fatto un accordo con una piattaforma molto stabile, quindi ora dovresti poter ricevere i pagamenti senza problemi.

Per attivarli, vai nelle impostazioni di Relay, cerca la voce \"International Wire\" e segui la procedura per completare la configurazione.

Fammi sapere se hai bisogno di aiuto!', 0, NULL, 'Scenario: Client: Claudia Taffarello. Channel: WhatsApp. Topic: Relay international wires reactivated', 'recHUpoqvw2CtIzXP', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('39bade75-7fe9-49ee-b62e-370f96345b08', 'Card payment + 5% fee', 'General', '["card payment fee", "General"]', NULL, 'Italian', 'Ciao Claudio!

No, tranquillo — non c''è nessun problema ad aver tenuto l''indirizzo italiano associato alla LLC per tutto questo tempo. Non cambia assolutamente nulla.

Per quanto riguarda il pagamento con carta: sì, ti alleghiamo il link per il pagamento. Però tieni presente che il servizio di incasso con carta di credito applica una commissione del 5%.

Quindi valuta tu se preferisci pagare con carta (con il 5% in più) oppure procedere con un bonifico bancario.

Fammi sapere!', 0, NULL, 'Scenario: Client: Claudio. Channel: WhatsApp. Topic: Card payment + 5% fee', 'recHjm7v7Q6ayOXd7', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('053b817a-bd5e-4d51-87a1-694ded58de8e', 'Shopify Payments US deactivated', 'CMRA', '["Shopify", "CMRA"]', NULL, 'Italian', 'Ciao Manuel!

Per quanto riguarda Shopify Payments US disattivato, ho bisogno di capire meglio la situazione:

1. Che regione hai dichiarato quando hai attivato Shopify Payments?
2. Dove vendi effettivamente? (USA, Europa, entrambi?)
3. Che tipo di business fai? (dropshipping, prodotti propri, ecc.)

Inoltre, una precisazione importante: l''indirizzo CMRA (come il nostro) è un indirizzo fisico reale con contratto di locazione — non è un \"virtual address\". Shopify a volte fa confusione su questo punto.

Fammi sapere questi dettagli così capiamo come risolvere!', 0, NULL, 'Scenario: Client: Manuel Chinellato. Channel: WhatsApp. Topic: Shopify Payments US deactivated', 'recIBIJevV0SOuOio', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('6569a924-bf6a-4a78-ba40-688fcc53d79a', 'Mercury application completion', 'Banking', '["Mercury", "application", "Banking"]', NULL, 'Italian', 'Per la domanda \"Which countries will you operate in?\":
Italy va bene (dove lui vive/opera)

Per \"What US business operations do you have that require a US bank account?\":
Può scrivere: \"Receiving payments from US-based clients and international clients, paying for US-based software subscriptions and services.\"

Per \"How much money do you expect to send or receive each month?\":
Deve selezionare un range realistico in base al suo business (es. $1,000 - $10,000 o quello che si aspetta)

Per la domanda su chi ha la responsabilità principale di controllare il business:
Deve selezionare SE STESSO dal menu a tendina — essendo lui il proprietario (owner/member) della LLC.', 0, NULL, 'Scenario: Client: Mercury Application - Guide. Channel: WhatsApp. Topic: Mercury application completion', 'recJBYUfgr8Z1LzfT', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('0f1414bd-51d9-4176-ba7c-821b9b584575', 'Payment confirmation and bank details', 'General', '["payment confirmation", "General"]', NULL, 'Italian', 'Buongiorno Alida! Quanto tempo, ci fa piacere sentirti! Spero che tu stia bene.

Ne approfittiamo per farti gli auguri di buon anno!

Sì, quelli sono i dati corretti per fare il bonifico. Magari avvisaci appena lo hai fatto, grazie!', 0, NULL, 'Scenario: Client: Alida Danjizi. Channel: WhatsApp. Topic: Payment confirmation and bank details', 'recL4gtAbHQoj0vpy', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('bb7c6de8-0951-49d5-a69f-da8728aa9df8', 'Tax return and Florida services agreement', 'Tax', '["tax return", "Florida", "Tax"]', NULL, 'Italian', 'Ciao Gabriele!

Per il Tax Return: la scadenza per la dichiarazione 2025 è ad aprile 2026. Quando ci dai il via, mettiamo in lavorazione e ti inviamo il file per la raccolta dati verso metà febbraio.

Per quanto riguarda l''accordo di servizi con Tony Durante LLC per la gestione della tua LLC Florida, il costo annuale è di $2.350 (diviso in due rate: gennaio e giugno).

Il pacchetto include:
- Tax Return (dichiarazione dei redditi)
- Rinnovo annuale della società
- Registered Agent
- Indirizzo fisico business con lease agreement (siamo CMRA autorizzati USPS)
- Gestione delle comunicazioni con IRS e Stato
- Consulenza operativa durante l''anno
- Assistenza continua su WhatsApp, Telegram, email

Fammi sapere se vuoi procedere!', 0, NULL, 'Scenario: Client: Gabriele Sartori. Channel: Email. Topic: Tax return and Florida services agreement', 'recP44YtjSQAeu5SU', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('5ac09683-ef50-490e-93c0-5273ac77b1f5', 'Procedure and required documents', 'Onboarding', '["required documents", "Onboarding"]', NULL, 'English', 'Dear Anastasia,

Thank you for your email and for confirming you''d like to proceed.

The entity purpose you described works perfectly:
\"International fertility and family-building consulting, administrative coordination, and client support services.\"

Regarding the name \"Ave Fertility Consulting\" — we will check the availability with the Florida Secretary of State and confirm. I suggest you also prepare 2-3 alternative names in case the first choice is not available.

To move forward, we need:
1. A copy of your passport
2. Your residential address

We will send you the invoice with the phrase you requested: \"An invoice is a document confirming the fact of service provision. Service provision period: DD month YYYY – DD month YYYY\".

Once we receive the payment, we will send you the agreement to sign.

Have a great weekend!

Best regards,
Antonio', 0, NULL, 'Scenario: Client: Anastasia. Channel: Email. Topic: Procedure and required documents', 'recPqEk0jIxrm3uh6', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('c8d2958f-bad5-4cfd-89a8-e03c0c2c37d9', 'Delaware RA and compliance', 'Compliance', '["Delaware", "registered agent", "compliance"]', NULL, 'Italian', 'Ciao Emerson! Ho verificato la situazione della tua LLC Delaware:

1. Il Registered Agent attuale è Harvard Business Services. La fee risulta scaduta dal 28 dicembre 2025.
2. Tony Durante LLC non può fare da RA in Delaware perché siamo basati in Florida.
3. Questioni di compliance: Tassa statale 2025 non pagata, Tassa statale 2026 scade a marzo.

Ti consiglio di sistemare prima la situazione con Harvard Business Services.

Fammi sapere come vuoi procedere!', 0, NULL, 'Scenario: Delaware Registered Agent and compliance
Channel: Email', 'recSKn3Iq5eyHFKvP', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('944d3605-c620-4a0d-8e40-cb269cfd17dc', 'Manager responsibility in an LLC', 'LLC Structure', '["LLC Structure"]', NULL, 'English', 'Hey Mark!

Good question — and yes, your LLC is already set up as manager-managed, with me listed as the manager.

However, I want to make sure you understand what \"manager\" actually means in the context of an LLC, because it''s often misunderstood — especially when it comes to immigration purposes.

Being a manager of an LLC isn''t really about having \"limited authority\" over certain things. It''s about taking on responsibilities and potential liabilities for the company''s operations.

Here are some examples of what a manager can be held responsible for:
- Signing contracts on behalf of the LLC — and being accountable if something goes wrong
- Tax compliance — managers can be held personally liable for unpaid payroll taxes or certain filings
- Fiduciary duties — the manager has a legal duty to act in the best interest of the LLC and its members
- Regulatory compliance — if the company violates regulations, the manager may face scrutiny
- Employment decisions — hiring, firing, and workplace compliance issues can fall on the manager

So when immigration lawyers talk about a \"manager-managed structure\" for O-1 purposes, they''re not just looking for a name on paper — they want to see that someone other than the founder is genuinely taking on operational responsibility and oversight.

That''s a different conversation, and honestly, it''s one you should have directly with your immigration attorney to understand exactly what documentation and real-world arrangement they need to satisfy USCIS.

Happy to help with any documents we can provide, but I''d want to make sure we''re aligned with what your lawyer actually needs.

Let me know!', 0, NULL, 'Scenario: Client: Mark. Channel: Email. Topic: Manager responsibility in an LLC', 'recTZd7godOBjVvHk', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('5e0f83b7-c3d9-4842-b307-f6a9e0f61c27', 'Sales Tax — Economic Nexus Thresholds', 'General', '["sales tax", "General"]', NULL, 'Italian', 'La Sales Tax funziona così:

Ogni stato ha le sue soglie — si chiamano "economic nexus thresholds." La maggior parte degli stati usa una soglia di $100,000 di vendite in 12 mesi. Alcuni stati (come New York) hanno soglie più alte ($500,000).

Finché non superi la soglia di uno stato specifico, non devi raccogliere né versare sales tax in quello stato.

Quando superi la soglia: registrarti per la sales tax in quello stato, raccoglierla dai clienti, e versarla con le scadenze previste.', 0, NULL, 'Scenario: Client asks how US Sales Tax works, thresholds, state by state
Trigger: "sales tax", "soglie", "nexus", "devo raccogliere sales tax?"', 'recVkknGyFfpRPKUI', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('49da1941-7950-472c-8be4-4b263ff301dc', 'Google AdSense - W-9 and 1099', 'Tax', '["W-9", "1099", "Google AdSense", "Tax"]', NULL, 'Italian', 'Ciao Angelo!

Per Google AdSense con una Multi-Member LLC:

La tua LLC è considerata un''entità americana (US entity), quindi:

1. Devi compilare il W-9 (non il W-8) — il W-8 è per entità straniere
2. Non c''è ritenuta del 30% — quella si applica solo alle entità non-USA
3. Riceverai il Form 1099 da Google (non il 1042-S)

In pratica, Google ti tratta come un''azienda americana normale perché la LLC è registrata negli USA, indipendentemente dalla residenza dei membri.

Fammi sapere se hai altre domande!', 0, NULL, 'Scenario: Client: Angelo Capalbo Ghelli. Channel: WhatsApp. Topic: Google AdSense - W-9 and 1099', 'recsvxmDMIp80FOP0', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('5673c250-1546-432a-bc4b-e421a36e77f4', 'Relay account + Mercury card + credit line', 'Banking', '["Relay", "Mercury", "credit score", "Banking"]', NULL, 'Italian', 'Ciao Raffaele! Perfetto, procediamo con Relay.

Per la carta di Mercury, falla spedire al nostro ufficio:

10225 Ulmerton Road, Suite 3D, Largo, FL 33771

Quando la riceviamo ti avvisiamo, e poi ci mettiamo d''accordo per la spedizione: se sei in Albania te la spediamo lì, se sei in Italia te la spediamo in Italia. Ti segnalo solo che le spese di spedizione non sono a nostro carico.

Per la domanda sul fido o prestito: purtroppo né Mercury né Relay offrono questa possibilità perché non sono banche fisiche americane. E anche volendo rivolgerti a banche tradizionali USA come Bank of America o Chase, essendo non-resident e vivendo all''estero non potresti accedervi — per chiedere un fido in America ti servirebbe l''ITIN per essere riconosciuto come contribuente e costruire un credit score americano.

L''alternativa più semplice è chiedere il fido come persona fisica nel paese in cui vivi: adesso Malta, domani magari Albania. Lì riceverai i soldi della LLC come dividendi/profitto, e in base a quelli potresti chiedere un fido o un finanziamento normale — tipo comprare la macchina a rate tramite una concessionaria.

Fammi sapere!', 0, NULL, 'Scenario: Client: Raffaele Bontempo. Channel: WhatsApp. Topic: Relay account + Mercury card + credit line', 'recWMtn80ewT2jO83', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('d3534afd-4721-48c1-9282-12197f46e789', 'Single-member vs Multi-member + state', 'Onboarding', '["multi-member", "single-member", "Onboarding"]', NULL, 'English', 'Hi Anastasia! Great to hear from you and happy to know you''re ready to proceed!

Before I send you the updated offer for the single-member LLC, I just wanted to confirm a few things:

Are you still planning to form the company in Florida, or would you prefer to consider a different state? For example, if privacy is important to you, we could look at forming an anonymous LLC in a state like New Mexico or Wyoming.

If you''d like, we can also schedule a quick call to define the best strategy for your specific situation and answer any questions you might have.

Let me know what works best for you!', 0, NULL, 'Scenario: Client: Anastasia. Channel: WhatsApp. Topic: Single-member vs Multi-member + state', 'recXMr8LzBf17KC0V', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('b85a6d6d-e7d9-4545-830a-80891b3bab1c', 'DBA and LLC formation', 'LLC Structure', '["DBA", "LLC Structure"]', NULL, 'Italian', 'Ciao Valerio!

Per il DBA (Doing Business As), devi sapere che non puoi registrare un DBA da solo — deve essere registrato sotto un''entità esistente.

Quindi la procedura corretta è:
1. Prima formi la LLC
2. Poi registri il DBA sotto quella LLC

Il DBA è semplicemente un \"nome commerciale\" alternativo che la tua LLC può usare, ma l''entità legale deve esistere prima.

Se vuoi procedere con la formazione della LLC, fammi sapere e ti mando l''offerta!', 0, NULL, 'Scenario: Client: Valerio Pio Vellucci. Channel: WhatsApp. Topic: DBA and LLC formation', 'recYPnI7Pd1mNaEoE', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('d8d931d5-2046-4c61-921f-777a8eddffda', 'LLC managed by external provider', 'LLC Structure', '["LLC Structure"]', NULL, 'English', 'Hi Mike,

No, this doesn''t impact anything.

As a service provider, FreshOps doesn''t appear on any LLC documents or in any banking procedures. The bank only looks at the LLC''s actual ownership structure — the members and managers listed in the Operating Agreement and formation documents.

So whether you manage 1 or 100 LLCs for your clients, it has no bearing on their ability to open a high street bank account. The bank''s decision will depend entirely on the individual client''s situation: their residency, the LLC''s ownership structure, and whether they can meet the bank''s requirements (usually an in-person visit for traditional banks).

Let me know if you have any other questions!

Best,
Tony', 0, NULL, 'Scenario: Client: Mike. Channel: Email. Topic: LLC managed by external provider', 'reca1xw5U5EFMg8Ie', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('504bbf26-f05b-471f-b09f-3b15b01b3293', 'TEMPLATE — Piattaforme IBAN EUR per LLC US (non-resident)', 'Banking', '["Relay", "NIUM", "IBAN EUR", "Banking"]', NULL, 'Italian', '1. Airwallex — la più veloce da attivare (24-48 ore), IBAN europeo operativo, nessun costo mensile
2. Instarem — piattaforma solida, tempi 2-3 giorni, IBAN dedicato', 0, NULL, 'Scenario: Alternative a Relay/NIUM per ricevere EUR con IBAN
Trigger: Messaggio standard quando Relay non può attivare IBAN EUR
Do NOT Say: Payoneer (feedback negativo da clienti)', 'recaB6k4TXbYGIUpJ', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('6cacf513-1821-4570-bd25-1b441adcd473', 'Tax return and Florida services', 'Tax', '["tax return", "Florida", "Tax"]', NULL, 'Italian', 'Ciao Gabriele! Per il Tax Return: la scadenza per la dichiarazione 2025 è ad aprile 2026.

Per l''accordo di servizi, il costo annuale è di $2.350 (diviso in due rate: gennaio e giugno).

Il pacchetto include: Tax Return, Rinnovo annuale, Registered Agent, Indirizzo fisico business con lease agreement (CMRA autorizzati USPS), Gestione comunicazioni con IRS e Stato, Consulenza operativa, Assistenza continua.

Fammi sapere se vuoi procedere!', 0, NULL, 'Scenario: Tax return and Florida services agreement
Channel: Email', 'recaCKhvdCWT91sai', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('11e8a0a2-75d0-4c15-9f2e-dc1e3b0255f2', 'What''s included in the subscription', 'Onboarding', '["subscription", "Onboarding"]', NULL, 'Italian', 'Ciao Mirko!

Mi sembra una domanda un po'' strana comunque... ricorda che noi siamo una consulting firm con sede in Florida, non un provider online.

Nel pagamento dell''abbonamento è incluso tutto:
- Tax Return (dichiarazione dei redditi)
- Rinnovo annuale della società
- Registered Agent
- Indirizzo fisico business con lease agreement (siamo CMRA autorizzati da USPS per ricevere e gestire tutta la corrispondenza)
- Gestione delle comunicazioni con IRS e Stato
- Consulenza operativa durante l''anno
- Assistenza continua su WhatsApp, Telegram, email

Fammi sapere se hai altre domande!', 0, NULL, 'Scenario: Client: Mirko Falleti. Channel: WhatsApp. Topic: What''s included in the subscription', 'recbL5DMhmGCyIMt2', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('e23b6579-af41-48be-bd82-c17f331a71ed', 'ITIN benefits', 'ITIN', '["ITIN"]', NULL, 'Italian', 'Ciao Angelo!

I benefici dell''ITIN sono principalmente questi:

1. Carte di credito americane (Amex, Chase) — con cashback e vantaggi
2. Conti bancari fisici (Chase, Bank of America) — non solo fintech
3. Costruire un credit score americano — utile per il futuro
4. Maggiore credibilità della LLC con banche e payment gateway

Senza ITIN sei limitato alle fintech (Mercury, Relay, Wise) che comunque funzionano benissimo, ma non hai accesso al \"sistema creditizio\" americano.

Se ti interessa iniziare il processo ITIN, fammi sapere!', 0, NULL, 'Scenario: Client: Angelo Capalbo Ghelli. Channel: WhatsApp. Topic: ITIN benefits', 'reccvmgM7zimdP8Jc', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('1dbf8db9-7186-4176-912f-d0b34b35fd99', 'Revolut address update', 'Banking', '["Revolut", "address", "Banking"]', NULL, 'Italian', 'Ciao Vincenzo! Devi mettere come principal address l''indirizzo che trovi sull''EIN Letter, in modo che corrisponda. Quindi modifica l''indirizzo, metti quello dell''EIN e poi carica il documento come prova.

Fammi sapere come va!', 0, NULL, 'Scenario: Client: Vincenzo Pio Fuggiano. Channel: WhatsApp. Topic: Revolut address update', 'receIWZL9JoVqKKxi', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('47d11c69-d757-4e06-b77f-bcc81d592285', 'Amex, ITIN, Chase, Relay', 'Banking', '["Relay", "Chase", "Amex", "ITIN", "Banking"]', NULL, 'Italian', 'Ciao Lorenzo!

Ti spiego le opzioni:

Per avere una carta Amex americana o aprire un conto Chase, ti serve l''ITIN. Questi strumenti richiedono un credit score americano, e per costruire il credit score ti serve l''ITIN.

Chase è una banca fisica americana — per aprire un conto devi andare di persona negli USA.

Relay invece è una fintech — puoi aprire il conto da remoto senza problemi. Relay offre anche una carta di credito che non richiede ITIN o credit score.

Quindi le tue opzioni sono:
1. Se vuoi Amex/Chase → prima devi fare l''ITIN (2-4 mesi), poi costruire credit score
2. Se vuoi qualcosa subito → Relay (carta inclusa, no ITIN richiesto)

Fammi sapere cosa preferisci!', 0, NULL, 'Scenario: Client: Lorenzo Pravatà. Channel: WhatsApp. Topic: Amex, ITIN, Chase, Relay', 'rechGF5mTGIhKFfMN', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('a55587d4-d2c9-49d2-b5da-1ab41c700ae7', 'Delaware taxes clarification', 'Tax', '["Delaware", "Tax"]', NULL, 'Italian', 'Ciao Emerson!

Ti chiarisco la situazione delle tasse Delaware:

L''email che hai ricevuto il 1 gennaio 2025 mostrava che il 2024 era ancora non pagato.

A marzo 2025 si è aggiunta la tassa 2025 (che risulta ancora non pagata).

La tassa 2026 non è ancora disponibile sul portale — comparirà a marzo 2026.

Quindi in questo momento hai da saldare:
- 2024 (se non già pagato)
- 2025

Fammi sapere se hai bisogno di aiuto per sistemare!', 0, NULL, 'Scenario: Client: Emerson Lerardi. Channel: Email. Topic: Delaware taxes clarification', 'rechQZF6Ioj6OcZaJ', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('0e7929ab-d8d9-41c5-b3fc-1afc5b8fc6e3', 'Florida application update - delays', 'General', '["Florida", "General"]', NULL, 'Italian', 'Ciao Riccardo!

Oggi siamo riusciti a contattare direttamente lo Stato della Florida per avere un aggiornamento sulla tua pratica.

Purtroppo ci hanno confermato che sono ancora parecchio indietro con l''elaborazione delle registrazioni. A causa delle festività hanno accumulato un arretrato significativo e i tempi di lavorazione si sono allungati.

Da parte nostra stiamo facendo tutto il possibile: continuiamo a monitorare e sollecitare. La prossima settimana invieremo un nuovo sollecito per cercare di accelerare i tempi.

Capisco che l''attesa sia frustrante e mi dispiace non poterti dare tempistiche più precise, ma purtroppo dipende interamente dai tempi dello Stato.

Ti aggiorniamo non appena abbiamo novità!', 0, NULL, 'Scenario: Client: Riccardo. Channel: WhatsApp. Topic: Florida application update - delays', 'reci0JUN4jKIi9XNB', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('21f9c0a6-5b6d-4196-9878-deb3dfff116e', 'Tax Return for closed LLC', 'Tax', '["tax return", "Tax"]', NULL, 'Italian', 'Ciao Simone! Come stai? Spero tutto bene. Certo che mi ricordo di voi! Ne approfitto per farvi gli auguri di buon anno!

Per quanto riguarda la LLC che è stata chiusa, per chiudere definitivamente l''anno bisogna fare il Tax Return, cioè la dichiarazione dei redditi della società. Questo serve per chiudere il discorso una volta per tutte.

Il costo per la dichiarazione dei redditi è di €1.000. La scadenza è il 15 aprile.

Se ci dai il via, mettiamo subito in lavorazione e ti inviamo il file da compilare verso metà febbraio. Se sei d''accordo ti mandiamo già la fattura — indicami solo a chi intestarla se ti serve.

Fammi sapere!', 0, NULL, 'Scenario: Client: Simone Pallavera. Channel: WhatsApp. Topic: Tax Return for closed LLC', 'recibCBbutcQGXDOn', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('598daaca-682c-432e-9f2e-9d0c132fed07', 'ITIN receipt confirmation', 'General', '["ITIN", "General"]', NULL, 'Italian', 'Ciao Marco!

Ti confermiamo che in data odierna abbiamo ricevuto il tuo ITIN. Ti abbiamo appena inviato via email la comunicazione ufficiale.

Puoi confermarci di aver ricevuto l''email?

Grazie!', 0, NULL, 'Scenario: Client: Marco. Channel: WhatsApp. Topic: ITIN receipt confirmation', 'reciwKpY6DQKJKYSw', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('fa72e0bb-ada9-4492-bcc4-27e63983a98c', 'Relay Application Completed', 'Banking', '["Relay", "application", "Banking"]', NULL, 'Italian', 'Ciao Marco! Abbiamo completato l''application Relay per Horus LLC.

Dovresti aver ricevuto un''email da Relay con un invito. Ecco cosa fare:
1. Apri l''email da Relay e accetta l''invito
2. Segui le istruzioni a video per completare la verifica

Una volta completato, ci vorranno 1-2 giorni lavorativi per l''approvazione.', 0, NULL, 'Scenario: Relay Application Completed — Invito inviato
Channel: Telegram', 'reclxLxvk6tSfaBHI', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('320c272b-0719-49f6-89dd-b8c1a8770edb', 'Bounced email + address', 'General', '["address", "bounced email", "General"]', NULL, 'Italian', 'Ciao Claudio!

Sì infatti l''email ci è tornata indietro. Provvediamo subito a modificare il tuo indirizzo email nel nostro CRM e ti reinviamo la fattura.

Per quanto riguarda l''indirizzo di residenza, sì — appena facciamo il rinnovo di quest''anno lo aggiorneremo con quello corretto. Se per cortesia puoi ricordarcelo qui in chat, così lo teniamo pronto per quando procediamo.

Grazie!', 0, NULL, 'Scenario: Client: Claudio. Channel: WhatsApp. Topic: Bounced email + address', 'recnHCekB59S8Edas', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('45a81f14-c37b-471d-9e04-5c9bc202688c', 'Relay documents request', 'Banking', '["Relay", "Banking"]', NULL, 'Italian', 'Ciao Antonio! Sì, certo che ti aiutiamo.

Per il punto 1 (documentazione su management e shareholding), ti prepariamo noi l''Operating Agreement da inviare.

Per il punto 2 (portfolio prodotti o partner agreements), hai per caso un accordo con la società per la quale lavori — quella che fa gli impianti? Se sì, mandacelo che lo inviamo. Altrimenti dimmi cosa hai e vediamo insieme cosa possiamo preparare.

Fammi sapere!', 0, NULL, 'Scenario: Relay documents (Operating Agreement + portfolio)
Channel: WhatsApp', 'recnMihgjiZx2zGXT', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('050a3231-706f-4e68-991c-b3ff53283fa9', 'Correct use of Wise', 'Banking', '["Wise", "Banking"]', NULL, 'Italian', 'Ciao Giuseppe, grazie mille per il bonifico, ricevuto!

Volevo solo ricordarti una cosa importante: come già discusso in precedenza, il conto Wise dovrebbe essere utilizzato esclusivamente per incassare pagamenti in euro, convertirli in dollari e trasferirli sul conto bancario americano.

Utilizzare Wise per effettuare bonifici in uscita può comportare il rischio di blocco del conto.

Per fare bonifici in uscita, ti consigliamo di usare Relay — è più sicuro e non avrai problemi.

Fammi sapere se hai domande!', 0, NULL, 'Scenario: Client: Giuseppe Daniele. Channel: WhatsApp. Topic: Correct use of Wise', 'recnzu1ZE6p5pxADk', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('2bebdaba-0401-4d8b-8a18-cb183ff22ba1', 'Documents for tax filing', 'Tax', '["tax return", "Tax"]', NULL, 'English', 'Great, glad it was helpful!

For the tax filing, I need a few things from you:

1. Name of the responsible person for the company
2. Address of the responsible person
3. Company email that you actively check
4. Articles of Organization
5. EIN Letter
6. Passport of the responsible person

Once you send these over, we''re all set to proceed.

Thanks!', 0, NULL, 'Scenario: Client: Mojo Labs LLC. Channel: Email. Topic: Documents for tax filing', 'recp5U9wmVg15u949', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('eb2ad05b-c005-475e-8fd3-0839139cfac5', 'New billing system', 'Billing', '["pricing", "Billing"]', NULL, 'Italian', 'Ciao Alessandro! Per voi non cambia nulla, anzi sarà molto più agevole.

L''unica novità con la nuova gestione è che ci saranno solo due momenti di fatturazione all''anno: una a gennaio e una a giugno. Questo proprio per evitare la situazione dove ti ritrovi una fattura a dicembre e poi subito un''altra a febbraio per le tasse e i servizi.

La fattura che hai ricevuto ora è riferita al 2025 e chiude l''anno 2025. Una volta saldata quella, iniziamo con il 2026 con la nuova gestione: gennaio e giugno. E così sarà ogni anno da qui in avanti.

Quindi per quest''anno: salda la fattura 2025, e poi partiamo con il nuovo sistema più semplice e ordinato.

Fammi sapere se hai domande!', 0, NULL, 'Scenario: Client: Alessandro. Channel: WhatsApp. Topic: New billing system', 'recrEyUh3cBjif8o3', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('974fffbe-623c-4a74-9815-66ef9115e08e', 'ITIN tax implications - 1040NR, dividends, Chase without ITIN, credit cards', 'ITIN', '["Chase", "ITIN", "1040NR", "dividends"]', NULL, 'Bilingual', '[EN]
No, having an ITIN does not mean you become a US taxpayer in the sense of paying taxes on dividends. Those are two completely different things - dividends are declared in your country of tax residence only.

What happens with the ITIN is that you technically become a US taxpayer as an individual, and the ITIN renewal must be done with a personal US tax return, Form 1040-NR, once every three years.

In practice, once every three years we file a personal return in your name with the ITIN, where you pay approximately $50-100 in US taxes as an individual. Many clients choose to do it every year so they always have proof they are paying taxes somewhere in the world and are compliant, but this is a personal choice.

Regarding banks: without an ITIN you can still open an account at Chase, because Chase currently accepts applications without ITIN, while all other physical banks require it. What you cannot get without an ITIN are American credit cards.

[IT]
No, avere l''ITIN non significa diventare contribuente americano nel senso che paghi tasse sui dividendi. Sono due cose completamente diverse, i dividendi li dichiari nel tuo paese di residenza fiscale e basta.

Quello che succede con l''ITIN e che tecnicamente diventi contribuente negli USA come persona, e il rinnovo dell''ITIN va fatto con una dichiarazione dei redditi personale americana, il Form 1040-NR, una volta ogni tre anni.

In pratica, una volta ogni tre anni noi facciamo una dichiarazione personale a tuo nome con l''ITIN, dove si pagano circa 50-100 dollari di tasse in America come persona fisica. Molti clienti decidono di farla ogni anno perche cosi hanno sempre da dimostrare che stanno pagando le tasse da qualche parte nel mondo e che sono in regola, pero questa e una scelta personale.

Per quanto riguarda le banche: senza ITIN puoi comunque aprire un conto in Chase, perche al momento Chase accetta anche senza ITIN, mentre tutte le altre banche fisiche lo richiedono. Quello che non puoi avere senza ITIN sono le carte di credito americane.', 0, NULL, 'Scenario: Client asks if having ITIN means becoming US taxpayer and paying taxes on dividends. Also covers banking without ITIN.
Key Points: 1. ITIN does not mean paying US taxes on dividends. 2. Form 1040-NR every 3 years for ITIN renewal ($50-100). 3. Many clients do 1040-NR annually for compliance proof. 4. Chase accepts without ITIN, other physical banks require it. 5. No credit cards without ITIN.
Do NOT Say: Do not say ITIN is mandatory. Do not say dividends are taxed in the US. Do not promise specific tax amounts beyond the $50-100 range.', 'recrWJuAOZTWo0eLj', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('2be8fbfe-aa02-486f-93e4-d3ccf95be7bd', 'Response to price increase complaints', 'Billing', '["pricing", "price increase", "Billing"]', NULL, 'Italian', 'Ciao Guido,

Capisco la vostra posizione, ma devo fare chiarezza su alcuni punti perché quanto scrivi non corrisponde alla realtà.

Non c''è stato nessun aumento di prezzi. Il prezzo è sempre stato $1.849 all''anno — lo stesso applicato a tutti i clienti, inclusi voi. Non è mai esistito un accordo di $1.000 all''anno con nessuno, perché è un prezzo che non abbiamo mai applicato.

Quello che è cambiato è solo il sistema di fatturazione. Prima fatturavamo in due momenti scomodi: uno nel periodo del Tax Return italiano e uno al rinnovo. Ora abbiamo unificato: una fattura a gennaio e una a giugno. Fine. Nessun aumento, solo una gestione più ordinata.

Per quanto riguarda \"altri clienti che si lamentano\": sono in contatto diretto con tutti i miei clienti, inclusa Carmen che mi hai menzionato. Anche lei aveva dei dubbi, ma abbiamo chiarito tutto perché semplicemente non funziona come state descrivendo. Ti invito quindi a non basarti su informazioni non corrette.

I fatti: l''anno scorso non avete pagato gli $849 dovuti, e quella fattura resta da saldare. Questo è un dato oggettivo, non una discussione.

Se preferite non continuare a lavorare insieme, nessun problema — ma gli $800 del saldo 2025 restano comunque dovuti. Una volta saldati, ognuno prosegue per la propria strada.

Resto a disposizione per chiarire ulteriormente, ma con i fatti alla mano.', 0, NULL, 'Scenario: Client: Guido. Channel: WhatsApp. Topic: Response to price increase complaints', 'recrw2SqGqpdjYOk9', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('54b0d689-9b88-4cda-bde0-f7e64d02d989', 'Tax return procedure confirmation', 'Tax', '["tax return", "Tax"]', NULL, 'English', 'Perfect! We''ll set up the invoice now and get everything ready. As soon as the IRS starts accepting returns, we''ll send you the data collection link via email.

Thanks!', 0, NULL, 'Scenario: Client: Peter. Channel: WhatsApp/Email. Topic: Tax return procedure confirmation', 'recs5biSrPw9VBAbj', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('4ea92150-77dd-4130-bf56-8a3b20d4e549', 'Delaware Registered Agent and compliance', 'Tax', '["Delaware", "registered agent", "compliance", "Tax"]', NULL, 'Italian', 'Ciao Emerson!

Ho verificato la situazione della tua LLC Delaware:

1. Il Registered Agent attuale è Harvard Business Services. La fee risulta scaduta dal 28 dicembre 2025.

2. Tony Durante LLC non può fare da Registered Agent in Delaware perché siamo basati in Florida. Possiamo però gestire i rinnovi e la compliance come consulenti.

3. Questioni di compliance da risolvere:
   - Tassa statale 2025: risulta non pagata
   - Tassa statale 2026: scade a marzo

Ti consiglio di sistemare prima la situazione con Harvard Business Services per il Registered Agent, poi possiamo valutare insieme come gestire la compliance ongoing.

Fammi sapere come vuoi procedere!', 0, NULL, 'Scenario: Client: Emerson Lerardi. Channel: Email. Topic: Delaware Registered Agent and compliance', 'recsJ3c1F4S8Te06Z', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('37ecdfef-6d89-4b75-9875-6c6facd64a45', 'Tax return service request', 'Tax', '["tax return", "Tax"]', NULL, 'Italian', 'Ciao Christian! Per il momento il servizio che hai con noi è solo il mailing address.

Per occuparci noi del Tax Return possiamo farlo assolutamente sì — dobbiamo fare l''onboarding per la LLC che già abbiamo, oppure per tutte quelle che vuoi.

Fammi sapere come preferisci procedere!', 0, NULL, 'Scenario: Client: Christian. Channel: WhatsApp. Topic: Tax return service request', 'recsKxfANK3FH0jCC', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('e885add1-5379-4fd8-ad51-372bd0b82ac1', 'Missing transfer $103,000', 'Banking', '["wire transfer", "Banking"]', NULL, 'English', 'Hi! Good news!

We managed to contact Relay support and this is their response:

\"Thanks for reaching out. I located a case involving a missing transfer of $103,000 intended for MushBrew LLC. Our team is actively working on this and has confirmed the funds with CurrencyCloud. We are currently negotiating with CurrencyCloud to ensure the funds are deposited into their Relay account. I will continue to follow this case closely and provide you with updates as we progress.\"

In short: they located the $103,000 transfer, the funds are confirmed with CurrencyCloud, and they''re working to get them deposited into your Relay account.

As soon as we have more updates, we''ll let you know immediately. We''re monitoring the situation closely.', 0, NULL, 'Scenario: Client: MushBrew LLC. Channel: Telegram. Topic: Missing transfer $103,000', 'recsqg7Ho8uaS67Pq', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('afa8b2a5-119f-4981-a7c1-bff347c536f2', 'NIUM documents without website', 'Banking', '["NIUM", "Banking"]', NULL, 'Italian', 'Ciao Francesco! Sì, certo, lo sappiamo — Relay ha fatto un accordo con NIUM per i pagamenti internazionali. Proprio dal tipo di documenti che richiedono si vede che è una piattaforma molto seria e sarà molto stabile.

Per quanto riguarda i documenti richiesti:

1. Online Presence — So che non hai un sito web o social media perché lavori nella gestione di network sulle navi. Mi sembra che tempo fa avessimo creato una descrizione dell''attività per spiegare questo. Ce l''hai ancora? Se sì, condividila così la controlliamo. Altrimenti te la rifacciamo nuova.

2. Supporting documentation (management e shareholding) — Qui devi inviare l''Operating Agreement.

3. Business Registration Document — Questo ce l''hai già (Articles of Organization / Certificate of Formation).

Fammi sapere!', 0, NULL, 'Scenario: Client: Francesco Accetta. Channel: WhatsApp. Topic: NIUM documents without website', 'recssks2MMq1Zqnpr', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('2ca02a0e-b85a-49ca-b96c-9f5d391caa8d', 'Wise as main account - risks', 'Banking', '["Wise", "Banking"]', NULL, 'Italian', 'Ciao Ettore!

Ti faccio un esempio pratico: diciamo che usi Wise come conto principale e poi un giorno Wise ti chiude il conto. Perché? Perché Wise non va usato come conto principale per la LLC — è semplicemente un exchange, non una banca.

Mi dispiace Ettore, ma questo te l''ho già detto in precedenza. Capisco il tuo punto di vista sulla questione del cambio, ma ragiona così: così come hai un vantaggio quando cambi da euro a dollari, avrai uno svantaggio quando riconverti da Mercury in euro per pagare i collaboratori. Quindi la partita si chiude più o meno a zero.

Io ti parlo da consulente: gestisco la tua LLC e i costi della LLC devono uscire dalla banca americana, non da Wise. Wise non è una banca, è semplicemente un exchange che ti agevola ad avere un IBAN. Stop.

Puoi fare come più ritieni opportuno, ma quando da un giorno all''altro ti chiude il conto, io lì non posso fare nulla — al massimo proporti altri conti da aprire che ti danno l''IBAN, ma questo ti rallenterà il business.

Altra cosa: quando si decide di trasferirsi all''estero, non bisogna pretendere di arrivare a pagare zero. La pretesa è quella di arrivare a pagare meno tasse — e tu le stai pagando meno. Ma se poi ci sono dei costi (come quelli di cambio) che l''azienda deve sopportare per mantenere la struttura, non bisogna piangersi addosso.', 0, NULL, 'Scenario: Client: Ettore Obert. Channel: Email. Topic: Wise as main account - risks', 'rectLoebWW1NdyLay', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('00170bd8-2b97-4d09-aeed-f815e57a5ab5', 'Free call recording', 'General', '["call recording", "General"]', NULL, 'Italian', 'Ciao Antonio,

È stato un piacere anche per me!

Purtroppo la registrazione della call non posso inviartela perché era una call gratuita. La registrazione di solito la inviamo solo per le consulenze a pagamento.

Però hai già il PDF e le note che ti ho mandato — con quelli dovresti avere tutto il necessario per riguardare i punti che abbiamo discusso. Se hai dubbi o domande quando li rileggi, scrivimi pure e ci aggiorniamo la settimana prossima come dici.

Buona serata!', 0, NULL, 'Scenario: Client: Antonio. Channel: WhatsApp. Topic: Free call recording', 'rectmdiqqTIXvpAnb', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('ef3d50c1-dcfb-4e1e-85b2-8beabc1f40ad', 'Thank you and waiting for updates', 'General', '["ITIN", "General"]', NULL, 'English', 'Hi JV,

Thank you so much for your help and for requesting the manual review — we really appreciate it!

We''ll wait for your update from the onboarding team.

Thanks again for your assistance!

Best regards,
Luca', 0, NULL, 'Scenario: Client: JV. Channel: Email. Topic: Thank you and waiting for updates', 'recusLtsBh3LkfX4b', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('dc221608-7cbc-47b7-b6d8-ec412a4cb3d9', 'TEMPLATE — Mercury Application Guide', 'Banking', '["Mercury", "application", "Banking"]', NULL, 'Italian', 'Per la domanda "Which countries will you operate in?": Italy va bene.

Per "What US business operations do you have that require a US bank account?": Può scrivere: "Receiving payments from US-based clients and international clients, paying for US-based software subscriptions and services."

Per "How much money do you expect to send or receive each month?": Deve selezionare un range realistico.

Per la domanda su chi ha la responsabilità principale: Deve selezionare SE STESSO dal menu a tendina.', 0, NULL, 'Scenario: Mercury application completion
Channel: WhatsApp', 'recwFZZjHdGbkmHQn', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('783a773d-1bd2-4b09-9624-9fe1f6cbc04d', 'Stripe payout + Wise returning transfers', 'Banking', '["Wise", "Stripe", "wire transfer", "payout", "Banking"]', NULL, 'Italian', 'Ciao William! Per quanto riguarda Stripe, invece di fare il doppio passaggio portando gli euro su Wise, puoi semplificare: inserisci direttamente Relay come conto payout su Stripe.

In pratica: incassi in euro su Stripe, e poi fai il payout da Stripe direttamente su Relay in dollari. Così eviti il passaggio intermedio su Wise.

Per quanto riguarda Wise che sta restituendo i bonifici, purtroppo non sappiamo il motivo — sei il secondo cliente che ci segnala questo problema. Dovresti contattare l''assistenza di Wise per capire perché stanno tornando indietro.

Ti ho preparato già il messaggio da inviare al supporto Wise:', 0, NULL, 'Scenario: Client: William Canzi. Channel: WhatsApp. Topic: Stripe payout + Wise returning transfers', 'recxqWl6AAbq8fwyH', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('83779617-d514-487a-a4a8-cfd53a634f28', 'Personal vs business account - Pacific Bank', 'Banking', '["Pacific Bank", "personal vs business", "Banking"]', NULL, 'Italian', 'Ciao Riccardo, la banca ha revisionato la documentazione e ritiene che tu abbia bisogno di un conto business e non di un conto personale.

Il motivo è che alcune descrizioni fanno chiaramente riferimento ad attività business.

Per procedere con l''apertura del conto PERSONALE, devi rivedere completamente queste risposte e riscriverle senza riferimenti a clienti, contratti, servizi professionali o attività lavorativa.

Ti chiedo di rimandarci l''email con le risposte corrette il prima possibile.', 0, NULL, 'Scenario: Personal vs business account - wrong answers
Channel: Email', 'recyjaluZIE6H2ctO', '2026-03-03T18:47:45.439368+00:00', '2026-03-03T18:47:45.439368+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('4cb02446-0bff-481d-bb83-e5eb02470942', 'Relay - Rimuovere Luca Degasper dal team', 'Banking', '["Relay", "Luca Degasper", "rimozione", "team"]', NULL, 'Italian', 'Ciao [NOME],

durante la fase di apertura del tuo conto Relay, Luca Degasper è stato aggiunto temporaneamente come nostro riferimento interno per completare l''application.

Ora che il conto è attivo, ti chiediamo di rimuoverlo. Puoi farlo accedendo a Relay, andando nelle impostazioni del team e rimuovendo Luca Degasper dai membri.

Se hai bisogno di aiuto con la procedura, siamo a disposizione.

Un saluto,
Tony Durante LLC', 0, NULL, 'Template da inviare a tutti i clienti Relay attivi che hanno ancora Luca Degasper come membro del team. Sostituire [NOME] con il nome del cliente.', NULL, '2026-03-04T18:45:19.438282+00:00', '2026-03-04T18:45:19.438282+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('736f0b7e-a792-402a-952e-9632373c1092', 'Tax Return a zero - LLC senza attività', 'Tax Return', '["tax return", "zero", "nessuna attività", "IRS"]', NULL, 'Italian', 'Ciao [NOME]!

Sì, la dichiarazione va fatta comunque anche se non avete fatto nulla con la LLC nel [ANNO]. In pratica si fa un tax return a zero, ma va fatto lo stesso perché l''IRS controlla. Quindi compilate pure il modulo e inviatecelo entro la scadenza.

Se avete dubbi sulla compilazione, siamo qui!', 0, NULL, 'Template per clienti che chiedono se devono fare il tax return anche se la LLC non ha avuto attività durante l''anno. Sostituire [NOME] e [ANNO].', NULL, '2026-03-04T19:34:39.958061+00:00', '2026-03-04T19:34:39.958061+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('e0e4aace-e2d8-47e1-babf-c9ac1a2a8209', 'Relay - Richiesta rimozione Luca Degasper dal conto', 'Banking', '["relay", "luca degasper", "rimozione admin", "conto attivo", "banking"]', 'Banking Fintech', 'it', 'Ciao [NOME_CLIENTE],
durante la fase di apertura del tuo conto Relay, Luca Degasper è stato aggiunto temporaneamente come nostro riferimento interno per completare l''application.
Ora che il conto è attivo, ti chiediamo di rimuoverlo. Puoi farlo accedendo a Relay, andando nelle impostazioni del team e rimuovendo Luca Degasper dai membri.
Se hai bisogno di aiuto con la procedura, siamo a disposizione.
Un saluto,
Tony Durante LLC', 0, NULL, 'Da inviare ai clienti dopo che il conto Relay è stato approvato e attivato. Luca Degasper viene aggiunto temporaneamente durante l''application come riferimento interno. Una volta attivo il conto, il cliente deve rimuoverlo dalle impostazioni team. Usare sempre questo template standard.', NULL, '2026-03-11T14:13:32.242471+00:00', '2026-03-11T14:13:32.242471+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('dc478d9f-53ad-4194-be71-b5aa2adbb1b8', 'PNB — Dettagli conti business e personale per clienti internazionali', 'Banking', '["PNB", "Pacific National Bank", "Banking", "conto business", "conto personale", "non-resident", "Florida"]', 'Banking Physical', 'it', 'Ecco i dettagli sui conti di Pacific National Bank, direttamente dal nostro referente in banca (Guillermo Ruiz).

**Conto Business Checking (intestato alla LLC) — Clienti Internazionali:**
- Saldo minimo giornaliero di $5,000 per evitare la maintenance charge di $50/mese
- 30 transazioni al mese gratuite, oltre i 30 $1.00 per transazione
- Online banking gratuito
- Carta di debito business disponibile

**Conto Personale Checking — Clienti Internazionali:**
- Saldo minimo giornaliero di $5,000 per evitare la maintenance charge di $50/mese
- 30 prelievi al mese gratuiti, oltre i 30 $0.50 ciascuno
- Carta di debito con prelievo ATM fino a $1,000 al giorno (costo $3.00 per prelievo). Per acquisti con la carta, abilitabile un limite credit al costo dell''1% sull''importo
- Online banking gratuito, pagamenti nazionali USA inclusi
- Per trasferimenti internazionali serve compilare un modulo specifico
- Transazioni a terzi non consentite per regolamento federale

Le condizioni base sono molto simili — entrambi $5,000 di saldo minimo e $50/mese se scendi sotto. La differenza principale è che il business ha funzionalità aggiuntive per la gestione aziendale (ACH, wire transfers, ecc.) e il personale è per le spese quotidiane con la carta di debito.

Per procedere dobbiamo registrare la LLC in Florida (foreign qualification), dopodiché si aprono i conti.', 0, NULL, 'Scenario: Cliente chiede dettagli sui conti PNB (business e personale). Dati confermati direttamente da Guillermo Ruiz (PNB) via email: business 11 Jun 2025, personale 10 Dec 2025. Usare questa risposta come base per tutti i clienti che chiedono info su PNB.', NULL, '2026-03-11T20:10:41.279597+00:00', '2026-03-11T20:10:41.279597+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('f82c6da0-53b5-4687-8bfc-b0e430311c2b', 'Welcome Email — Relay Bank Section (IT+EN)', 'Banking', '["relay", "banking", "welcome-email", "USD", "bilingual"]', 'Company Formation', 'en', '**ITALIANO:**

Per il conto bancario americano in dollari (Relay), abbiamo bisogno di alcune informazioni per procedere con l''apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.

Una volta completata l''application da parte nostra, riceverai un''email direttamente da Relay per autenticare il tuo account. Controlla la tua casella email (anche lo spam) e completa la verifica cliccando il link che riceverai.

→ {link_relay}

---

**ENGLISH:**

For your US dollar bank account (Relay), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.

Once we complete the application on your behalf, you will receive an email directly from Relay to authenticate your account. Please check your inbox (including spam) and complete the verification by clicking the link you receive.

→ {link_relay}', 0, NULL, 'Sezione della welcome email post-EIN. Il cliente compila il form, noi facciamo l''application, poi Relay manda email di autenticazione al cliente. Nessun OTP richiesto.', NULL, '2026-03-13T16:37:55.613128+00:00', '2026-03-13T16:37:55.613128+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('8a84e1f8-cef2-4960-ac1b-d0bc43a15184', 'Welcome Email — Payset Bank Section (IT+EN)', 'Banking', '["payset", "banking", "welcome-email", "EUR", "IBAN", "OTP", "bilingual"]', 'Company Formation', 'en', '**ITALIANO:**

Per il conto con IBAN in euro (Payset), abbiamo bisogno di alcune informazioni per procedere con l''apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.

Una volta ricevuti i tuoi dati, ti contatteremo su Telegram per concordare un momento in cui procedere insieme con l''application. Durante il processo, riceverai un codice OTP via SMS sul tuo telefono che dovrai comunicarci in tempo reale per completare l''attivazione.

→ {link_payset}

---

**ENGLISH:**

For your EUR IBAN account (Payset), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.

Once we receive your data, we will contact you on Telegram to schedule a time to proceed together with the application. During the process, you will receive an OTP code via SMS on your phone that you will need to share with us in real time to complete the activation.

→ {link_payset}', 0, NULL, 'Sezione della welcome email post-EIN. Il cliente compila il form, poi ci si coordina su Telegram per l''OTP durante l''application. Payset richiede OTP via SMS in tempo reale.', NULL, '2026-03-13T16:37:59.456614+00:00', '2026-03-13T16:37:59.456614+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('642d922e-8bc7-40ba-810e-52f765718368', 'Welcome Email — Post-EIN Complete Package (IT+EN)', 'Banking', '["welcome-email", "post-EIN", "lease", "relay", "payset", "wise", "banking", "bilingual", "formation-stage-3"]', 'Company Formation', 'en', '**Oggetto IT:** La tua società è pronta ad operare — documenti e prossimi passi
**Oggetto EN:** Your company is ready to operate — documents and next steps

**Allegati:** EIN Letter + Articles of Organization

---

### VERSIONE ITALIANA

Ciao {nome},

Siamo lieti di informarti che la tua società **{company_name}** è ufficialmente costituita e pronta ad operare.

In allegato trovi:
- **EIN Letter** — il tuo Employer Identification Number assegnato dall''IRS
- **Articles of Organization** — il documento ufficiale di costituzione della tua società

---

**Firma il Lease Agreement**

Per avere un indirizzo fisico associato alla tua società, è necessario firmare il contratto di locazione. Clicca il link qui sotto per visualizzare e firmare il documento.

→ {link_lease}

---

**Conto bancario in dollari (Relay)**

Per il conto bancario americano in dollari (Relay), abbiamo bisogno di alcune informazioni per procedere con l''apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.

Una volta completata l''application da parte nostra, riceverai un''email direttamente da Relay per autenticare il tuo account. Controlla la tua casella email (anche lo spam) e completa la verifica cliccando il link che riceverai.

→ {link_relay}

---

**Conto con IBAN in euro (Payset)**

Per il conto con IBAN in euro (Payset), abbiamo bisogno di alcune informazioni per procedere con l''apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.

Una volta ricevuti i tuoi dati, ti contatteremo su Telegram per concordare un momento in cui procedere insieme con l''application. Durante il processo, riceverai un codice OTP via SMS sul tuo telefono che dovrai comunicarci in tempo reale per completare l''attivazione.

→ {link_payset}

---

**Conto alternativo IBAN (Wise)**

Ti consigliamo di aprire anche un conto su Wise (wise.com) per ricevere pagamenti in euro, in modo da avere un doppio account con IBAN. Abbiamo scelto Payset perché è il servizio più affidabile tra quelli disponibili, ma trattandosi di conti fintech è sempre meglio avere un''alternativa attiva. Puoi aprire il conto Wise in autonomia direttamente su wise.com.

---

**Regole importanti sull''utilizzo dei conti con IBAN**

Il conto con IBAN (Payset e/o Wise) va utilizzato **solo ed esclusivamente per incassare pagamenti in euro**. Una volta ricevuti i fondi, devono essere convertiti in dollari e trasferiti sul conto americano Relay. **Non utilizzare il conto IBAN per effettuare pagamenti verso terzi.**

---

Per qualsiasi domanda, siamo a disposizione su Telegram o via email.

Tony Durante LLC
support@tonydurante.us

---

### ENGLISH VERSION

Hi {name},

We are pleased to inform you that your company **{company_name}** is officially formed and ready to operate.

Please find attached:
- **EIN Letter** — your Employer Identification Number assigned by the IRS
- **Articles of Organization** — your company''s official formation document

---

**Sign the Lease Agreement**

To have a physical address associated with your company, you need to sign the lease agreement. Click the link below to view and sign the document.

→ {link_lease}

---

**US Dollar Bank Account (Relay)**

For your US dollar bank account (Relay), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.

Once we complete the application on your behalf, you will receive an email directly from Relay to authenticate your account. Please check your inbox (including spam) and complete the verification by clicking the link you receive.

→ {link_relay}

---

**EUR IBAN Account (Payset)**

For your EUR IBAN account (Payset), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.

Once we receive your data, we will contact you on Telegram to schedule a time to proceed together with the application. During the process, you will receive an OTP code via SMS on your phone that you will need to share with us in real time to complete the activation.

→ {link_payset}

---

**Alternative IBAN Account (Wise)**

We recommend also opening a Wise account (wise.com) to receive payments in euros, so you have two IBAN accounts available. We chose Payset because it is the most reliable service among those available, but since these are fintech accounts, it is always better to have a backup option. You can open the Wise account on your own directly at wise.com.

---

**Important Rules on IBAN Account Usage**

Your IBAN account (Payset and/or Wise) must be used **exclusively to receive payments in euros**. Once funds are received, they must be converted to USD and transferred to your US bank account on Relay. **Do not use the IBAN account to make outgoing payments to third parties.**

---

If you have any questions, we are available on Telegram or via email.

Tony Durante LLC
support@tonydurante.us', 0, NULL, 'Email inviata automaticamente al punto 3.7 del workflow Company Formation, dopo ricezione EIN letter. Allegati: EIN letter + Articles of Organization. Contiene link a: Lease Agreement, form Relay, form Payset. Istruzioni OTP per Payset, self-auth per Relay, consiglio Wise come backup IBAN. Regole uso conti IBAN (solo incasso euro, poi convertire e trasferire su Relay).', NULL, '2026-03-13T16:42:51.846231+00:00', '2026-03-13T16:42:51.846231+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('dac9ce5f-c3cf-4921-83ac-739f0e38da28', 'Welcome Package — Post-EIN (IT+EN)', 'Onboarding', '["welcome", "formation", "onboarding", "ein", "relay", "payset", "wise", "lease"]', 'Company Formation', 'en', '**Oggetto IT:** La tua società è pronta ad operare — documenti e prossimi passi
**Oggetto EN:** Your company is ready to operate — documents and next steps

---

**VERSIONE ITALIANA**

Ciao {nome},

Siamo lieti di informarti che la tua società **{company_name}** è ufficialmente costituita e pronta ad operare.

In allegato trovi:
- **EIN Letter** — il tuo Employer Identification Number assegnato dall''IRS
- **Articles of Organization** — il documento ufficiale di costituzione della tua società

---

**Firma l''Operating Agreement**

L''Operating Agreement è il documento che regola il funzionamento interno della tua società e conferma la tua posizione di unico titolare. Clicca il link qui sotto per visualizzare, firmare e scaricare il documento.

→ {link_oa}

---

**Firma il Lease Agreement**

Per avere un indirizzo fisico associato alla tua società, è necessario firmare il contratto di locazione. Clicca il link qui sotto per visualizzare e firmare il documento.

→ {link_lease}

---

**Conto bancario in dollari (Relay)**

Per il conto bancario americano in dollari (Relay), abbiamo bisogno di alcune informazioni per procedere con l''apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.

Una volta completata l''application da parte nostra, riceverai un''email direttamente da Relay per autenticare il tuo account. Controlla la tua casella email (anche lo spam) e completa la verifica cliccando il link che riceverai.

→ {link_relay}

---

**Conto con IBAN in euro (Payset)**

Per il conto con IBAN in euro (Payset), abbiamo bisogno di alcune informazioni per procedere con l''apertura. Compila il form al link qui sotto con i tuoi dati personali e aziendali.

Una volta ricevuti i tuoi dati, ti contatteremo su Telegram per concordare un momento in cui procedere insieme con l''application. Durante il processo, riceverai un codice OTP via SMS sul tuo telefono che dovrai comunicarci in tempo reale per completare l''attivazione.

→ {link_payset}

---

**Conto alternativo IBAN (Wise)**

Ti consigliamo di aprire anche un conto su Wise (wise.com) per ricevere pagamenti in euro, in modo da avere un doppio account con IBAN. Abbiamo scelto Payset perché è il servizio più affidabile tra quelli disponibili, ma trattandosi di conti fintech è sempre meglio avere un''alternativa attiva. Puoi aprire il conto Wise in autonomia direttamente su wise.com.

---

**Regole importanti sull''utilizzo dei conti con IBAN**

Il conto con IBAN (Payset e/o Wise) va utilizzato **solo ed esclusivamente per incassare pagamenti in euro**. Una volta ricevuti i fondi, devono essere convertiti in dollari e trasferiti sul conto americano Relay. **Non utilizzare il conto IBAN per effettuare pagamenti verso terzi.**

---

Siamo a disposizione.

Tony Durante LLC
support@tonydurante.us

---

**ENGLISH VERSION**

Hi {name},

We are pleased to inform you that your company **{company_name}** is officially formed and ready to operate.

Please find attached:
- **EIN Letter** — your Employer Identification Number assigned by the IRS
- **Articles of Organization** — your company''s official formation document

---

**Sign the Operating Agreement**

The Operating Agreement is the document that governs the internal operations of your company and confirms your position as sole owner. Click the link below to view, sign and download the document.

→ {link_oa}

---

**Sign the Lease Agreement**

To have a physical address associated with your company, you need to sign the lease agreement. Click the link below to view and sign the document.

→ {link_lease}

---

**US Dollar Bank Account (Relay)**

For your US dollar bank account (Relay), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.

Once we complete the application on your behalf, you will receive an email directly from Relay to authenticate your account. Please check your inbox (including spam) and complete the verification by clicking the link you receive.

→ {link_relay}

---

**EUR IBAN Account (Payset)**

For your EUR IBAN account (Payset), we need some information to proceed with the application. Please fill out the form at the link below with your personal and business details.

Once we receive your data, we will contact you on Telegram to schedule a time to proceed together with the application. During the process, you will receive an OTP code via SMS on your phone that you will need to share with us in real time to complete the activation.

→ {link_payset}

---

**Alternative IBAN Account (Wise)**

We recommend also opening a Wise account (wise.com) to receive payments in euros, so you have two IBAN accounts available. We chose Payset because it is the most reliable service among those available, but since these are fintech accounts, it is always better to have a backup option. You can open the Wise account on your own directly at wise.com.

---

**Important Rules on IBAN Account Usage**

Your IBAN account (Payset and/or Wise) must be used **exclusively to receive payments in euros**. Once funds are received, they must be converted to USD and transferred to your US bank account on Relay. **Do not use the IBAN account to make outgoing payments to third parties.**

---

We are at your disposal.

Tony Durante LLC
support@tonydurante.us', 0, NULL, 'Template bilingue IT+EN. Variabili: {nome}/{name}, {company_name}, {link_oa}, {link_lease}, {link_relay}, {link_payset}. Allegati: EIN letter PDF + Articles of Organization PDF. OA = link firma digitale (come lease). Payset richiede sessione OTP live su Telegram. Relay richiede verifica email dal cliente. Wise consigliato come backup IBAN.', NULL, '2026-03-13T17:33:09.912943+00:00', '2026-03-14T21:14:21.72601+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('70cbccf2-cb23-48d0-9ad5-012b6d65f388', 'Review Request — Post-Formation (IT+EN)', 'Closing', '["review", "google", "trustpilot", "closing", "formation", "onboarding"]', 'Company Formation', 'en', '**Oggetto IT:** La tua opinione conta — lascia una recensione
**Oggetto EN:** Your opinion matters — leave a review

---

**VERSIONE ITALIANA**

Ciao {nome},

È stato un piacere lavorare con te per la costituzione di **{company_name}**.

Se sei soddisfatto del servizio, ti chiediamo un paio di minuti per lasciare una recensione. La tua opinione ci aiuta a migliorare e aiuta altri imprenditori a trovarci.

→ **Google:** {link_google_review}
→ **Trustpilot:** https://www.trustpilot.com/evaluate/tonydurante.net

Siamo a disposizione.

Tony Durante LLC
support@tonydurante.us

---

**ENGLISH VERSION**

Hi {name},

It was a pleasure working with you on the formation of **{company_name}**.

If you are happy with our service, we would appreciate a couple of minutes of your time to leave a review. Your feedback helps us improve and helps other entrepreneurs find us.

→ **Google:** {link_google_review}
→ **Trustpilot:** https://www.trustpilot.com/evaluate/tonydurante.net

We are at your disposal.

Tony Durante LLC
support@tonydurante.us', 0, NULL, 'Template bilingue IT+EN per richiesta review a fine Formation/Onboarding. Variabili: {nome}/{name}, {company_name}, {link_google_review}. Trustpilot link fisso. Google review link richiede Place ID (da ottenere). Usato anche per Onboarding closing.', NULL, '2026-03-14T21:01:05.289854+00:00', '2026-03-14T21:01:05.289854+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('6165ae46-c419-4067-a93f-3e66639dd234', 'Portal Welcome Email Template — Italian', 'Client Communication', '["portal", "transition", "welcome", "email", "template", "italian"]', NULL, 'it', 'TRANSITION WELCOME EMAIL — ITALIAN VERSION

Subject: Il Tuo Nuovo Portale Clienti — Tony Durante LLC

STRUCTURE:
1. Header: TD logo + "Il Tuo Nuovo Portale Clienti"
2. Greeting: "Caro {name}," + intro about the portal
3. Credentials box (blue): Portal URL, email, temp password
4. "Cosa Puoi Fare" section with 6 feature cards:
   - Firma Documenti (gray) — sign OA, Lease, Annual Agreement online
   - Documenti (gray) — all LLC docs in one place, downloadable
   - Fatturazione (yellow) — create/send invoices to THEIR clients, add bank accounts, track payments
   - Conti Bancari e Gateway di Pagamento (green) — connect US/EU/intl banks, Whop credit card gateway, IBAN/SWIFT on invoices
   - Servizi e Stato (gray) — real-time service tracking
   - Chat con Dettatura Vocale (gray) — message team, microphone dictation auto-transcribed
5. "Un Regalo Per Te" (green box) — included at no extra cost + "Non cambia nulla, email e telefono restano attivi"
6. "Funziona Anche Sul Telefono" (purple box) — iPhone (Safari > Share > Add to Home), Android (Chrome > 3 dots > Add to Home), Push Notifications
7. "Funzionalita Su Misura" (orange box) — built by us, not generic, ask for custom features
8. "Cosa Fare Adesso" (blue box) — 4 steps: login, change password, sign 3 docs, explore
9. Closing: "Siamo qui per aiutarti" + "rispondi a questa email o contattaci dal portale" (NO WhatsApp mention)
10. Footer: Tony Durante LLC address

RULES:
- Send in CLIENT''S language (Italian OR English), NEVER bilingual
- NO WhatsApp references in closing — portal is the new channel
- Whop gateway mentioned in Bank Accounts section
- Voice dictation feature highlighted
- Mobile app install instructions included
- "Un Regalo Per Te" emphasizes it''s FREE, included in contract
- "Non cambia nulla" reassures nothing is being taken away', 2, '2026-03-30', 'Approved by Antonio on 2026-03-25. Originally created as bilingual IT+EN but Antonio rejected it — rule: one language per email based on client''s language field. Removed WhatsApp from closing. Added Whop gateway per Antonio''s request.', NULL, '2026-03-26T01:59:09.16185+00:00', '2026-03-30T22:31:22.193751+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('47c0c1d1-ef16-4da0-bf2e-3b9ca8c66cd2', 'Portal Credentials + SS-4 Signing - Italian', 'Onboarding', '["portal", "credentials", "SS-4", "EIN", "onboarding", "Italian"]', 'Company Formation', 'it', 'Subject: Il tuo portale cliente - Tony Durante LLC

Ciao {client_name},

Il tuo portale cliente è pronto! Questo è il portale che userai per gestire la tua LLC — documenti, fatturazione, conti bancari, scadenze e molto altro, tutto in un unico posto.

**Accedi al portale:**
- Link: https://portal.tonydurante.us/portal/login
- Email: {client_email}
- Password temporanea: {temp_password}

**Cosa devi fare adesso:**
1. Accedi al portale con le credenziali qui sopra
2. Vai nella sezione **"Firma Documenti"** — troverai il modulo **SS-4** (richiesta EIN per la tua LLC)
3. Controlla i dati, firma e invia
4. Noi invieremo il fax all''IRS e riceverai il tuo EIN entro 4-7 giorni lavorativi

**Nota:** Al momento le funzionalità del portale sono limitate perché la tua LLC non è ancora completamente configurata. Una volta ottenuto l''EIN, avrai accesso a tutte le funzionalità:
- **Dashboard** con panoramica completa della tua LLC
- **Fatturazione** — crea e invia fatture ai tuoi clienti direttamente dal portale, con il nome e i dati della tua LLC. Tieni traccia dei pagamenti ricevuti e gestisci tutta la contabilità in un unico posto
- **Conto bancario** — apertura e gestione del conto bancario USA (Relay) e conto europeo con IBAN (Payset), collegati direttamente alla tua LLC
- **Documenti** — Articles of Organization, Operating Agreement, EIN Letter e tutti i documenti aziendali
- **Scadenze** — Annual Report, rinnovi e tutte le date importanti
- **Servizi** — stato di avanzamento di ogni servizio attivo
- **Contratto di locazione** dell''ufficio

**Chat:** Nel portale troverai anche la tab **"Chat"** — usala per scriverci direttamente per qualsiasi domanda o aggiornamento. È il modo più veloce per comunicare con noi.

A presto,
Tony Durante LLC', 1, '2026-03-27', 'Template for sending portal credentials to Italian-speaking clients during formation. Uses placeholders: {client_name}, {client_email}, {temp_password}. Highlights the SS-4 signing as immediate action, and explains all portal features they''ll unlock after EIN (especially invoicing and banking). Always Italian-only for Italian clients.', NULL, '2026-03-27T01:32:13.098902+00:00', '2026-03-27T01:45:13.041665+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('ac2e5c20-6e33-4425-8d1e-64f2eb45b7f1', 'Portal Credentials + SS-4 Signing - English', 'Onboarding', '["portal", "credentials", "SS-4", "EIN", "onboarding", "English"]', 'Company Formation', 'en', 'Subject: Your Client Portal - Tony Durante LLC

Hi {client_name},

Your client portal is ready! This is the portal you''ll use to manage your LLC — documents, invoicing, bank accounts, deadlines, and much more, all in one place.

**Log in to your portal:**
- Link: https://portal.tonydurante.us/portal/login
- Email: {client_email}
- Temporary password: {temp_password}

**What you need to do now:**
1. Log in with the credentials above
2. Go to the **"Sign Documents"** section — you''ll find the **SS-4** form (EIN application for your LLC)
3. Review the information, sign, and submit
4. We will fax it to the IRS and you will receive your EIN within 4-7 business days

**Note:** Some portal features are currently limited because your LLC is not fully set up yet. Once you receive your EIN, you''ll have access to all features:
- **Dashboard** with a complete overview of your LLC
- **Invoicing** — create and send invoices to your clients directly from the portal, using your LLC''s name and details. Track payments received and manage all your billing in one place
- **Bank Account** — open and manage your US business bank account (Relay) and European IBAN account (Payset), linked directly to your LLC
- **Documents** — Articles of Organization, Operating Agreement, EIN Letter, and all your company documents
- **Deadlines** — Annual Report, renewals, and all important dates
- **Services** — track the progress of every active service
- **Office Lease** agreement

**Chat:** You''ll also find a **"Chat"** tab in the portal — use it to message us directly for any questions or updates. It''s the fastest way to communicate with us.

Best regards,
Tony Durante LLC', 0, NULL, 'English version of portal credentials template for formation clients. Uses placeholders: {client_name}, {client_email}, {temp_password}. Same structure as Italian version (47c0c1d1). Highlights SS-4 signing as immediate action, explains all portal features unlocked after EIN (invoicing, banking, documents, deadlines).', NULL, '2026-03-27T01:45:27.88387+00:00', '2026-03-27T01:45:27.88387+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO approved_responses (id, title, category, tags, service_type, language, response_text, usage_count, last_used_date, notes, airtable_id, created_at, updated_at) VALUES ('d70e5107-48c7-4481-a5eb-756e5a9ac767', 'Portal Welcome Email — Legacy Clients (Italian)', 'Client Communication', '["portal", "legacy", "welcome", "email", "template", "italian", "credentials"]', NULL, 'it', 'Subject: Il Tuo Nuovo Portale Clienti — Tony Durante LLC

Caro {NOME},

Siamo entusiasti di presentarti il Portale Clienti Tony Durante — una piattaforma digitale costruita su misura per i nostri clienti, per gestire la tua LLC americana in modo semplice, sicuro e professionale.

🔑 Le Tue Credenziali
- Portale: https://portal.tonydurante.us/portal/login
- Email: {EMAIL}
- Password: {PASSWORD}
- Al primo accesso ti verrà chiesto di cambiare la password.

Cosa Puoi Fare

✍️ Firma Documenti — Firma digitalmente Operating Agreement, Lease Agreement e il Contratto Annuale direttamente dal portale. Niente stampe, scanner o email — tutto online in 30 secondi.

📄 Documenti — Tutti i documenti della tua LLC in un unico posto: Articles of Organization, EIN Letter, Passaporto, Operating Agreement, Lease, Tax Returns. Scaricabili in qualsiasi momento.

💰 Fatturazione — Crea e invia fatture professionali ai tuoi clienti direttamente dal portale. Aggiungi i tuoi conti bancari (USA e internazionali) e i dati appariranno automaticamente sulla fattura. I tuoi clienti riceveranno la fattura via email con le istruzioni di pagamento. Tieni traccia di chi ha pagato e chi no — tutto in un unico posto.

🏦 Conti Bancari e Gateway di Pagamento — Collega tutti i tuoi conti bancari al portale — conti USA (Relay, Mercury), conti europei (Payset IBAN), e qualsiasi altro conto internazionale. Quando crei una fattura, scegli quale conto mostrare per il pagamento. I tuoi clienti vedranno IBAN, SWIFT/BIC, nome della banca e il riferimento. Puoi anche attivare Whop come gateway di pagamento direttamente dal portale — i tuoi clienti potranno pagare con carta di credito in modo sicuro e immediato.

📊 Servizi e Stato — Monitora lo stato di tutti i tuoi servizi in tempo reale: Tax Return, Registered Agent, Annual Report, CMRA. Vedi a che punto siamo con ogni pratica.

💬 Chat Integrata — Da oggi tutte le comunicazioni passano dalla chat del portale. Niente più messaggi sparsi tra WhatsApp, Telegram e email — tutto in un unico posto, organizzato e sempre disponibile. Puoi anche usare il microfono per dettare i messaggi vocalmente — il sistema trascrive automaticamente la tua voce in testo, senza bisogno di digitare.

🎁 Un Regalo Per Te
Il Portale Clienti è incluso nel tuo contratto annuale, senza costi aggiuntivi. È un investimento che abbiamo fatto per offrirti un servizio migliore, più trasparente e con tutto centralizzato in un unico posto.

📱 Funziona Anche Sul Telefono
- iPhone/iPad: Apri Safari → vai su portal.tonydurante.us → tocca Condividi → "Aggiungi a Home"
- Android: Apri Chrome → vai su portal.tonydurante.us → tocca i tre puntini → "Aggiungi a schermata Home"
- 🔔 Riceverai notifiche push per documenti da firmare, messaggi e aggiornamenti.

⚡ Funzionalità Su Misura — Il portale è costruito interamente da noi. Se hai bisogno di una funzionalità specifica per la tua attività, siamo pronti a svilupparla per te — basta chiedere.

Cosa Fare Adesso
1. Accedi al portale con le credenziali qui sopra
2. Cambia la password temporanea
3. Firma il Contratto Annuale in attesa
4. Esplora le funzionalità: documenti, fatturazione, chat

Siamo qui per aiutarti. Per qualsiasi domanda, scrivici direttamente dalla chat del portale.

Un caro saluto,
Antonio Durante
Tony Durante LLC', 1, '2026-03-30', 'Approved by Antonio on 2026-03-30. For LEGACY clients getting portal access for the first time. Key differences from new client template: (1) Chat emphasized as replacement for WhatsApp/Telegram, (2) No "email e telefono restano attivi" — portal chat is the new channel, (3) "Un Regalo Per Te" focuses on centralization value. Placeholders: {NOME}, {EMAIL}, {PASSWORD}. Send in Italian only. Use the Adriano-style HTML (with emoji cards, gradient header, colored sections) when sending via gmail_send.', NULL, '2026-03-30T19:32:40.396486+00:00', '2026-03-30T22:31:20.483916+00:00') ON CONFLICT (id) DO NOTHING;

-- email_templates: 6 rows
INSERT INTO email_templates (id, template_name, subject_template, body_template, service_type, trigger_event, language, placeholders, category, auto_send, requires_approval, active, notes, created_at, updated_at) VALUES ('56fa7db1-0815-48ff-af71-5df286f62968', 'Payment Reminder', 'Promemoria pagamento -- {{invoice_number}}', 'Cara/Caro {{first_name}},

Le scrivo per ricordare il pagamento in sospeso della fattura {{invoice_number}} ({{amount}} {{currency}}), con scadenza {{due_date}}.

Per saldare puo accedere al portale clienti (portal.tonydurante.us) nella sezione Fatture, dove trova il pulsante Paga con carta o i dati per bonifico.

Resto a disposizione per qualsiasi domanda.', NULL, NULL, 'it', '["first_name", "invoice_number", "amount", "currency", "due_date"]', 'Payment', FALSE, TRUE, TRUE, 'Manual payment reminder for overdue invoices. Portal-first per R092.', '2026-04-17T19:30:34.71036+00:00', '2026-04-17T19:43:10.363891+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO email_templates (id, template_name, subject_template, body_template, service_type, trigger_event, language, placeholders, category, auto_send, requires_approval, active, notes, created_at, updated_at) VALUES ('ca121af6-74c3-4427-bed9-f67cb1906bdb', 'Document Request', 'Documenti richiesti -- {{company_name}}', 'Cara/Caro {{first_name}},

Per procedere con {{context}}, avrei bisogno dei seguenti documenti relativi a {{company_name}}:

- {{document_type}}

Puo caricarli direttamente nel portale (portal.tonydurante.us) nella sezione Documenti.

Grazie in anticipo.', NULL, NULL, 'it', '["first_name", "company_name", "context", "document_type"]', 'Documents', FALSE, TRUE, TRUE, 'Request a specific document from the client. Admin fills document_type and context.', '2026-04-17T19:30:34.71036+00:00', '2026-04-17T19:43:12.685817+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO email_templates (id, template_name, subject_template, body_template, service_type, trigger_event, language, placeholders, category, auto_send, requires_approval, active, notes, created_at, updated_at) VALUES ('c03bb893-b9c6-45c4-84c4-6c01631a10ee', 'Document Request', 'Documents needed -- {{company_name}}', 'Dear {{first_name}},

To proceed with {{context}}, I need the following documents for {{company_name}}:

- {{document_type}}

You can upload them directly in the client portal (portal.tonydurante.us) under the Documents section.

Thanks in advance.', NULL, NULL, 'en', '["first_name", "company_name", "context", "document_type"]', 'Documents', FALSE, TRUE, TRUE, 'Request a specific document from the client. Admin fills document_type and context.', '2026-04-17T19:30:34.71036+00:00', '2026-04-17T19:43:13.749498+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO email_templates (id, template_name, subject_template, body_template, service_type, trigger_event, language, placeholders, category, auto_send, requires_approval, active, notes, created_at, updated_at) VALUES ('f5d34b18-5dbd-4db1-9727-7348163acdf5', 'General Follow-up', 'Follow-up -- {{subject_context}}', 'Cara/Caro {{first_name}},

Volevo aggiornarla su {{subject_context}}.

{{body_detail}}

Resto a disposizione per qualsiasi domanda.', NULL, NULL, 'it', '["first_name", "subject_context", "body_detail"]', 'Follow-up', FALSE, TRUE, TRUE, 'Generic follow-up skeleton -- admin fills subject_context and body_detail.', '2026-04-17T19:30:34.71036+00:00', '2026-04-17T19:43:15.669289+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO email_templates (id, template_name, subject_template, body_template, service_type, trigger_event, language, placeholders, category, auto_send, requires_approval, active, notes, created_at, updated_at) VALUES ('babbffc7-cd15-4fea-8b44-4c28374a6427', 'General Follow-up', 'Follow-up -- {{subject_context}}', 'Dear {{first_name}},

Just following up on {{subject_context}}.

{{body_detail}}

Let me know if you have any questions.', NULL, NULL, 'en', '["first_name", "subject_context", "body_detail"]', 'Follow-up', FALSE, TRUE, TRUE, 'Generic follow-up skeleton -- admin fills subject_context and body_detail.', '2026-04-17T19:30:34.71036+00:00', '2026-04-17T19:43:16.624547+00:00') ON CONFLICT (id) DO NOTHING;
INSERT INTO email_templates (id, template_name, subject_template, body_template, service_type, trigger_event, language, placeholders, category, auto_send, requires_approval, active, notes, created_at, updated_at) VALUES ('bfa7fcb1-320e-4a2e-af9a-4455764d7b76', 'Payment Reminder', 'Payment reminder -- {{invoice_number}}', 'Dear {{first_name}},

This is a reminder that invoice {{invoice_number}} ({{amount}} {{currency}}) is outstanding. The due date was {{due_date}}.

You can settle this from the client portal (portal.tonydurante.us) under the Invoices section. The Pay button offers card checkout or wire transfer details.

Let me know if you have any questions.', NULL, NULL, 'en', '["first_name", "invoice_number", "amount", "currency", "due_date"]', 'Payment', FALSE, TRUE, TRUE, 'Manual payment reminder for overdue invoices. Portal-first per R092.', '2026-04-17T19:30:34.71036+00:00', '2026-04-17T19:43:37.847923+00:00') ON CONFLICT (id) DO NOTHING;
