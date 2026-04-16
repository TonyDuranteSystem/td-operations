export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      account_contacts: {
        Row: {
          account_id: string
          contact_id: string
          ownership_pct: number | null
          role: string | null
        }
        Insert: {
          account_id: string
          contact_id: string
          ownership_pct?: number | null
          role?: string | null
        }
        Update: {
          account_id?: string
          contact_id?: string
          ownership_pct?: number | null
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_contacts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_contacts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_contacts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "account_contacts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "account_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      accounts: {
        Row: {
          account_type: string | null
          airtable_id: string | null
          annual_report_due_date: string | null
          bank_details: Json | null
          cancellation_date: string | null
          cancellation_requested: boolean | null
          client_health: string | null
          cmra_amount: number | null
          cmra_renewal_date: string | null
          communication_email: string | null
          company_name: string
          created_at: string | null
          drive_folder_id: string | null
          dunning_escalation_email: string | null
          dunning_pause: boolean | null
          dunning_reminder_1_days: number | null
          dunning_reminder_2_days: number | null
          ein_number: string | null
          entity_type: Database["public"]["Enums"]["company_type"] | null
          filing_id: string | null
          formation_date: string | null
          gdrive_folder_url: string | null
          hc_company_id: string | null
          hubspot_id: string | null
          id: string
          installment_1_amount: number | null
          installment_1_currency: Database["public"]["Enums"]["currency"] | null
          installment_2_amount: number | null
          installment_2_currency: Database["public"]["Enums"]["currency"] | null
          invoice_logo_url: string | null
          is_test: boolean | null
          kb_folder_path: string | null
          lead_source: string | null
          notes: string | null
          partner_id: string | null
          payment_gateway: string | null
          payment_link: string | null
          physical_address: string | null
          portal_account: boolean | null
          portal_auto_created: boolean | null
          portal_created_date: string | null
          portal_tier: string | null
          qb_customer_id: string | null
          ra_renewal_date: string | null
          referral_commission_pct: number | null
          referral_status: string | null
          referred_by: string | null
          referrer: string | null
          registered_agent_address: string | null
          registered_agent_provider: string | null
          services_bundle: string[] | null
          state_of_formation: string | null
          status: Database["public"]["Enums"]["account_status"] | null
          updated_at: string | null
          welcome_package_status: string | null
          zoho_account_id: string | null
        }
        Insert: {
          account_type?: string | null
          airtable_id?: string | null
          annual_report_due_date?: string | null
          bank_details?: Json | null
          cancellation_date?: string | null
          cancellation_requested?: boolean | null
          client_health?: string | null
          cmra_amount?: number | null
          cmra_renewal_date?: string | null
          communication_email?: string | null
          company_name: string
          created_at?: string | null
          drive_folder_id?: string | null
          dunning_escalation_email?: string | null
          dunning_pause?: boolean | null
          dunning_reminder_1_days?: number | null
          dunning_reminder_2_days?: number | null
          ein_number?: string | null
          entity_type?: Database["public"]["Enums"]["company_type"] | null
          filing_id?: string | null
          formation_date?: string | null
          gdrive_folder_url?: string | null
          hc_company_id?: string | null
          hubspot_id?: string | null
          id?: string
          installment_1_amount?: number | null
          installment_1_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          installment_2_amount?: number | null
          installment_2_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          invoice_logo_url?: string | null
          is_test?: boolean | null
          kb_folder_path?: string | null
          lead_source?: string | null
          notes?: string | null
          partner_id?: string | null
          payment_gateway?: string | null
          payment_link?: string | null
          physical_address?: string | null
          portal_account?: boolean | null
          portal_auto_created?: boolean | null
          portal_created_date?: string | null
          portal_tier?: string | null
          qb_customer_id?: string | null
          ra_renewal_date?: string | null
          referral_commission_pct?: number | null
          referral_status?: string | null
          referred_by?: string | null
          referrer?: string | null
          registered_agent_address?: string | null
          registered_agent_provider?: string | null
          services_bundle?: string[] | null
          state_of_formation?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          updated_at?: string | null
          welcome_package_status?: string | null
          zoho_account_id?: string | null
        }
        Update: {
          account_type?: string | null
          airtable_id?: string | null
          annual_report_due_date?: string | null
          bank_details?: Json | null
          cancellation_date?: string | null
          cancellation_requested?: boolean | null
          client_health?: string | null
          cmra_amount?: number | null
          cmra_renewal_date?: string | null
          communication_email?: string | null
          company_name?: string
          created_at?: string | null
          drive_folder_id?: string | null
          dunning_escalation_email?: string | null
          dunning_pause?: boolean | null
          dunning_reminder_1_days?: number | null
          dunning_reminder_2_days?: number | null
          ein_number?: string | null
          entity_type?: Database["public"]["Enums"]["company_type"] | null
          filing_id?: string | null
          formation_date?: string | null
          gdrive_folder_url?: string | null
          hc_company_id?: string | null
          hubspot_id?: string | null
          id?: string
          installment_1_amount?: number | null
          installment_1_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          installment_2_amount?: number | null
          installment_2_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          invoice_logo_url?: string | null
          is_test?: boolean | null
          kb_folder_path?: string | null
          lead_source?: string | null
          notes?: string | null
          partner_id?: string | null
          payment_gateway?: string | null
          payment_link?: string | null
          physical_address?: string | null
          portal_account?: boolean | null
          portal_auto_created?: boolean | null
          portal_created_date?: string | null
          portal_tier?: string | null
          qb_customer_id?: string | null
          ra_renewal_date?: string | null
          referral_commission_pct?: number | null
          referral_status?: string | null
          referred_by?: string | null
          referrer?: string | null
          registered_agent_address?: string | null
          registered_agent_provider?: string | null
          services_bundle?: string[] | null
          state_of_formation?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          updated_at?: string | null
          welcome_package_status?: string | null
          zoho_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "accounts_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "client_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      action_log: {
        Row: {
          account_id: string | null
          action_type: string
          actor: string
          contact_id: string | null
          created_at: string | null
          details: Json | null
          id: string
          record_id: string | null
          session_checkpoint_id: string | null
          summary: string
          table_name: string
        }
        Insert: {
          account_id?: string | null
          action_type: string
          actor?: string
          contact_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          record_id?: string | null
          session_checkpoint_id?: string | null
          summary: string
          table_name: string
        }
        Update: {
          account_id?: string | null
          action_type?: string
          actor?: string
          contact_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: string
          record_id?: string | null
          session_checkpoint_id?: string | null
          summary?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_log_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_log_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_log_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "action_log_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "action_log_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_log_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "action_log_session_checkpoint_id_fkey"
            columns: ["session_checkpoint_id"]
            isOneToOne: false
            referencedRelation: "session_checkpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_push_subscriptions: {
        Row: {
          auth_key: string
          created_at: string | null
          email: string
          endpoint: string
          id: string
          p256dh: string
          user_id: string
        }
        Insert: {
          auth_key: string
          created_at?: string | null
          email: string
          endpoint: string
          id?: string
          p256dh: string
          user_id: string
        }
        Update: {
          auth_key?: string
          created_at?: string | null
          email?: string
          endpoint?: string
          id?: string
          p256dh?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_decisions: {
        Row: {
          account_id: string | null
          action_taken: string
          approved: boolean | null
          approved_by: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          outcome: string | null
          situation: string
          task_id: string | null
          tools_used: string[] | null
        }
        Insert: {
          account_id?: string | null
          action_taken: string
          approved?: boolean | null
          approved_by?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          outcome?: string | null
          situation: string
          task_id?: string | null
          tools_used?: string[] | null
        }
        Update: {
          account_id?: string | null
          action_taken?: string
          approved?: boolean | null
          approved_by?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          outcome?: string | null
          situation?: string
          task_id?: string | null
          tools_used?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_decisions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "agent_decisions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "agent_decisions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "agent_decisions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "v_active_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_delegations: {
        Row: {
          analysis: Json | null
          branch_name: string | null
          completed_at: string | null
          created_at: string | null
          error_message: string | null
          id: string
          pr_number: number | null
          pr_url: string | null
          repo: string | null
          status: string | null
          task: string
          user_id: string
        }
        Insert: {
          analysis?: Json | null
          branch_name?: string | null
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          pr_number?: number | null
          pr_url?: string | null
          repo?: string | null
          status?: string | null
          task: string
          user_id: string
        }
        Update: {
          analysis?: Json | null
          branch_name?: string | null
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          pr_number?: number | null
          pr_url?: string | null
          repo?: string | null
          status?: string | null
          task?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_embeddings: {
        Row: {
          chunk_index: number | null
          chunk_text: string
          created_at: string | null
          embedding: string | null
          id: string
          session_id: string
        }
        Insert: {
          chunk_index?: number | null
          chunk_text: string
          created_at?: string | null
          embedding?: string | null
          id?: string
          session_id: string
        }
        Update: {
          chunk_index?: number | null
          chunk_text?: string
          created_at?: string | null
          embedding?: string | null
          id?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_embeddings_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "ai_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_facts: {
        Row: {
          category: string
          content: string
          created_at: string | null
          embedding: string | null
          id: string
          reasoning: string | null
          source_session_id: string | null
          status: string | null
          superseded_at: string | null
          superseded_by: string | null
          user_id: string
        }
        Insert: {
          category: string
          content: string
          created_at?: string | null
          embedding?: string | null
          id?: string
          reasoning?: string | null
          source_session_id?: string | null
          status?: string | null
          superseded_at?: string | null
          superseded_by?: string | null
          user_id: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string | null
          embedding?: string | null
          id?: string
          reasoning?: string | null
          source_session_id?: string | null
          status?: string | null
          superseded_at?: string | null
          superseded_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_facts_source_session_id_fkey"
            columns: ["source_session_id"]
            isOneToOne: false
            referencedRelation: "ai_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_facts_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "ai_facts"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_messages: {
        Row: {
          content: string
          created_at: string | null
          id: string
          model: string | null
          role: string
          session_id: string
          tokens_input: number | null
          tokens_output: number | null
          tool_calls: Json | null
          tool_results: Json | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          model?: string | null
          role: string
          session_id: string
          tokens_input?: number | null
          tokens_output?: number | null
          tool_calls?: Json | null
          tool_results?: Json | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          model?: string | null
          role?: string
          session_id?: string
          tokens_input?: number | null
          tokens_output?: number | null
          tool_calls?: Json | null
          tool_results?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "ai_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_notifications: {
        Row: {
          body: string
          channel: string | null
          created_at: string | null
          data: Json | null
          dedup_key: string | null
          dedup_window: string | null
          id: string
          priority: string | null
          pushed_at: string | null
          read_at: string | null
          source: string | null
          status: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body: string
          channel?: string | null
          created_at?: string | null
          data?: Json | null
          dedup_key?: string | null
          dedup_window?: string | null
          id?: string
          priority?: string | null
          pushed_at?: string | null
          read_at?: string | null
          source?: string | null
          status?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string
          channel?: string | null
          created_at?: string | null
          data?: Json | null
          dedup_key?: string | null
          dedup_window?: string | null
          id?: string
          priority?: string | null
          pushed_at?: string | null
          read_at?: string | null
          source?: string | null
          status?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_sessions: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          ended_at: string | null
          id: string
          is_active: boolean | null
          message_count: number | null
          metadata: Json | null
          model: string | null
          summary: string | null
          title: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          ended_at?: string | null
          id?: string
          is_active?: boolean | null
          message_count?: number | null
          metadata?: Json | null
          model?: string | null
          summary?: string | null
          title?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          ended_at?: string | null
          id?: string
          is_active?: boolean | null
          message_count?: number | null
          metadata?: Json | null
          model?: string | null
          summary?: string | null
          title?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_user_context: {
        Row: {
          context_text: string
          id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          context_text: string
          id?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          context_text?: string
          id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      airtable_migration_log: {
        Row: {
          airtable_record_id: string
          error_message: string | null
          id: string
          migrated_at: string | null
          status: string | null
          supabase_id: string | null
          table_name: string
        }
        Insert: {
          airtable_record_id: string
          error_message?: string | null
          id?: string
          migrated_at?: string | null
          status?: string | null
          supabase_id?: string | null
          table_name: string
        }
        Update: {
          airtable_record_id?: string
          error_message?: string | null
          id?: string
          migrated_at?: string | null
          status?: string | null
          supabase_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string | null
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      approved_responses: {
        Row: {
          airtable_id: string | null
          category: string | null
          created_at: string | null
          id: string
          language: string | null
          last_used_date: string | null
          notes: string | null
          response_text: string
          service_type: Database["public"]["Enums"]["service_type"] | null
          tags: string[] | null
          title: string
          updated_at: string | null
          usage_count: number | null
        }
        Insert: {
          airtable_id?: string | null
          category?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          last_used_date?: string | null
          notes?: string | null
          response_text: string
          service_type?: Database["public"]["Enums"]["service_type"] | null
          tags?: string[] | null
          title: string
          updated_at?: string | null
          usage_count?: number | null
        }
        Update: {
          airtable_id?: string | null
          category?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          last_used_date?: string | null
          notes?: string | null
          response_text?: string
          service_type?: Database["public"]["Enums"]["service_type"] | null
          tags?: string[] | null
          title?: string
          updated_at?: string | null
          usage_count?: number | null
        }
        Relationships: []
      }
      bank_transactions: {
        Row: {
          account_id: string | null
          account_type: string | null
          amount: number
          balance_after: number | null
          bank_name: string | null
          category: string | null
          counterparty: string | null
          created_at: string | null
          currency: string | null
          description: string | null
          id: string
          is_related_party: boolean | null
          notes: string | null
          source_file_id: string | null
          subcategory: string | null
          tax_year: number
          transaction_date: string
          transaction_ref: string | null
        }
        Insert: {
          account_id?: string | null
          account_type?: string | null
          amount: number
          balance_after?: number | null
          bank_name?: string | null
          category?: string | null
          counterparty?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          id?: string
          is_related_party?: boolean | null
          notes?: string | null
          source_file_id?: string | null
          subcategory?: string | null
          tax_year: number
          transaction_date: string
          transaction_ref?: string | null
        }
        Update: {
          account_id?: string | null
          account_type?: string | null
          amount?: number
          balance_after?: number | null
          bank_name?: string | null
          category?: string | null
          counterparty?: string | null
          created_at?: string | null
          currency?: string | null
          description?: string | null
          id?: string
          is_related_party?: boolean | null
          notes?: string | null
          source_file_id?: string | null
          subcategory?: string | null
          tax_year?: number
          transaction_date?: string
          transaction_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "bank_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      banking_submissions: {
        Row: {
          access_code: string | null
          account_id: string | null
          changed_fields: Json | null
          client_ip: string | null
          client_user_agent: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          language: string
          opened_at: string | null
          prefilled_data: Json | null
          provider: string
          reviewed_at: string | null
          reviewed_by: string | null
          sent_at: string | null
          status: string
          submitted_data: Json | null
          token: string
          updated_at: string | null
          upload_paths: string[] | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          language?: string
          opened_at?: string | null
          prefilled_data?: Json | null
          provider?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string
          submitted_data?: Json | null
          token: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          language?: string
          opened_at?: string | null
          prefilled_data?: Json | null
          provider?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string
          submitted_data?: Json | null
          token?: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "banking_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "banking_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "banking_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "banking_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "banking_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "banking_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      billing_entities: {
        Row: {
          account_id: string | null
          billing_address: string | null
          contact_id: string
          country: string | null
          created_at: string | null
          currency: string | null
          entity_name: string
          entity_type: string | null
          fiscal_code: string | null
          id: string
          is_default: boolean | null
          notes: string | null
          qb_customer_id: string | null
          updated_at: string | null
          vat_number: string | null
        }
        Insert: {
          account_id?: string | null
          billing_address?: string | null
          contact_id: string
          country?: string | null
          created_at?: string | null
          currency?: string | null
          entity_name: string
          entity_type?: string | null
          fiscal_code?: string | null
          id?: string
          is_default?: boolean | null
          notes?: string | null
          qb_customer_id?: string | null
          updated_at?: string | null
          vat_number?: string | null
        }
        Update: {
          account_id?: string | null
          billing_address?: string | null
          contact_id?: string
          country?: string | null
          created_at?: string | null
          currency?: string | null
          entity_name?: string
          entity_type?: string | null
          fiscal_code?: string | null
          id?: string
          is_default?: boolean | null
          notes?: string | null
          qb_customer_id?: string | null
          updated_at?: string | null
          vat_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_entities_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_entities_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_entities_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "billing_entities_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "billing_entities_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_entities_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      call_summaries: {
        Row: {
          account_id: string | null
          action_items: Json | null
          attendees: Json | null
          circleback_id: string | null
          contact_id: string | null
          created_at: string | null
          duration_seconds: number | null
          ical_uid: string | null
          id: string
          lead_id: string | null
          meeting_name: string | null
          meeting_url: string | null
          notes: string | null
          raw_payload: Json | null
          recording_url: string | null
          tags: string[] | null
          transcript: Json | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          action_items?: Json | null
          attendees?: Json | null
          circleback_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          ical_uid?: string | null
          id?: string
          lead_id?: string | null
          meeting_name?: string | null
          meeting_url?: string | null
          notes?: string | null
          raw_payload?: Json | null
          recording_url?: string | null
          tags?: string[] | null
          transcript?: Json | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          action_items?: Json | null
          attendees?: Json | null
          circleback_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          duration_seconds?: number | null
          ical_uid?: string | null
          id?: string
          lead_id?: string | null
          meeting_name?: string | null
          meeting_url?: string | null
          notes?: string | null
          raw_payload?: Json | null
          recording_url?: string | null
          tags?: string[] | null
          transcript?: Json | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_summaries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_summaries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_summaries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "call_summaries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "call_summaries_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_summaries_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "call_summaries_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      client_bank_accounts: {
        Row: {
          account_holder: string | null
          account_id: string
          account_number: string | null
          bank_name: string | null
          created_at: string | null
          currency: string
          iban: string | null
          id: string
          label: string
          notes: string | null
          routing_number: string | null
          show_on_invoice: boolean
          swift_bic: string | null
        }
        Insert: {
          account_holder?: string | null
          account_id: string
          account_number?: string | null
          bank_name?: string | null
          created_at?: string | null
          currency: string
          iban?: string | null
          id?: string
          label: string
          notes?: string | null
          routing_number?: string | null
          show_on_invoice?: boolean
          swift_bic?: string | null
        }
        Update: {
          account_holder?: string | null
          account_id?: string
          account_number?: string | null
          bank_name?: string | null
          created_at?: string | null
          currency?: string
          iban?: string | null
          id?: string
          label?: string
          notes?: string | null
          routing_number?: string | null
          show_on_invoice?: boolean
          swift_bic?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_bank_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_bank_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_bank_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_bank_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      client_correspondence: {
        Row: {
          account_id: string | null
          contact_id: string | null
          created_at: string | null
          description: string | null
          drive_file_id: string | null
          drive_file_url: string | null
          file_name: string
          id: string
          read_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          description?: string | null
          drive_file_id?: string | null
          drive_file_url?: string | null
          file_name: string
          id?: string
          read_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          description?: string | null
          drive_file_id?: string | null
          drive_file_url?: string | null
          file_name?: string
          id?: string
          read_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_correspondence_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_correspondence_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_correspondence_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_correspondence_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_correspondence_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_correspondence_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      client_credit_notes: {
        Row: {
          account_id: string | null
          amount: number
          applied_to_invoice_id: string | null
          contact_id: string | null
          created_at: string | null
          credit_note_number: string
          id: string
          original_invoice_id: string
          reason: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          amount: number
          applied_to_invoice_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          credit_note_number: string
          id?: string
          original_invoice_id: string
          reason?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          amount?: number
          applied_to_invoice_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          credit_note_number?: string
          id?: string
          original_invoice_id?: string
          reason?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_credit_notes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_credit_notes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_credit_notes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_credit_notes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_credit_notes_applied_to_invoice_id_fkey"
            columns: ["applied_to_invoice_id"]
            isOneToOne: false
            referencedRelation: "client_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_credit_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_credit_notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "client_credit_notes_original_invoice_id_fkey"
            columns: ["original_invoice_id"]
            isOneToOne: false
            referencedRelation: "client_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      client_customers: {
        Row: {
          account_id: string | null
          address: string | null
          city: string | null
          company_name: string | null
          contact_id: string | null
          country: string | null
          created_at: string | null
          email: string | null
          first_name: string | null
          id: string
          last_name: string | null
          name: string
          notes: string | null
          phone: string | null
          region: string | null
          updated_at: string | null
          vat_number: string | null
        }
        Insert: {
          account_id?: string | null
          address?: string | null
          city?: string | null
          company_name?: string | null
          contact_id?: string | null
          country?: string | null
          created_at?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          region?: string | null
          updated_at?: string | null
          vat_number?: string | null
        }
        Update: {
          account_id?: string | null
          address?: string | null
          city?: string | null
          company_name?: string | null
          contact_id?: string | null
          country?: string | null
          created_at?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          region?: string | null
          updated_at?: string | null
          vat_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_customers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_customers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_customers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_customers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_customers_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_customers_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      client_expense_items: {
        Row: {
          amount: number
          description: string
          expense_id: string
          id: string
          quantity: number | null
          sort_order: number | null
          unit_price: number | null
        }
        Insert: {
          amount?: number
          description: string
          expense_id: string
          id?: string
          quantity?: number | null
          sort_order?: number | null
          unit_price?: number | null
        }
        Update: {
          amount?: number
          description?: string
          expense_id?: string
          id?: string
          quantity?: number | null
          sort_order?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_expense_items_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "client_expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      client_expenses: {
        Row: {
          account_id: string | null
          attachment_name: string | null
          attachment_storage_path: string | null
          attachment_url: string | null
          category: string | null
          contact_id: string | null
          created_at: string | null
          currency: string
          description: string | null
          due_date: string | null
          id: string
          internal_ref: string | null
          invoice_number: string | null
          issue_date: string | null
          notes: string | null
          ocr_confidence: string | null
          ocr_extracted: boolean | null
          ocr_raw_text: string | null
          paid_date: string | null
          source: string
          status: string
          subtotal: number
          tax_amount: number | null
          td_payment_id: string | null
          total: number
          updated_at: string | null
          vendor_id: string | null
          vendor_name: string
        }
        Insert: {
          account_id?: string | null
          attachment_name?: string | null
          attachment_storage_path?: string | null
          attachment_url?: string | null
          category?: string | null
          contact_id?: string | null
          created_at?: string | null
          currency?: string
          description?: string | null
          due_date?: string | null
          id?: string
          internal_ref?: string | null
          invoice_number?: string | null
          issue_date?: string | null
          notes?: string | null
          ocr_confidence?: string | null
          ocr_extracted?: boolean | null
          ocr_raw_text?: string | null
          paid_date?: string | null
          source: string
          status?: string
          subtotal?: number
          tax_amount?: number | null
          td_payment_id?: string | null
          total?: number
          updated_at?: string | null
          vendor_id?: string | null
          vendor_name: string
        }
        Update: {
          account_id?: string | null
          attachment_name?: string | null
          attachment_storage_path?: string | null
          attachment_url?: string | null
          category?: string | null
          contact_id?: string | null
          created_at?: string | null
          currency?: string
          description?: string | null
          due_date?: string | null
          id?: string
          internal_ref?: string | null
          invoice_number?: string | null
          issue_date?: string | null
          notes?: string | null
          ocr_confidence?: string | null
          ocr_extracted?: boolean | null
          ocr_raw_text?: string | null
          paid_date?: string | null
          source?: string
          status?: string
          subtotal?: number
          tax_amount?: number | null
          td_payment_id?: string | null
          total?: number
          updated_at?: string | null
          vendor_id?: string | null
          vendor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_expenses_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_expenses_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "client_expenses_td_payment_id_fkey"
            columns: ["td_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_expenses_td_payment_id_fkey"
            columns: ["td_payment_id"]
            isOneToOne: false
            referencedRelation: "v_overdue_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_expenses_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "client_vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      client_interactions: {
        Row: {
          account_id: string | null
          attachments: Json | null
          body: string | null
          cc_email: string[] | null
          channel: Database["public"]["Enums"]["conversation_channel"] | null
          contact_id: string | null
          created_at: string | null
          direction: string | null
          from_email: string | null
          gmail_message_id: string | null
          gmail_thread_id: string | null
          handled_by: string | null
          id: string
          interaction_date: string | null
          interaction_type: Database["public"]["Enums"]["interaction_type"]
          labels: string[] | null
          lead_id: string | null
          matched_at: string | null
          matched_by: string | null
          notes: string | null
          snippet: string | null
          subject: string | null
          to_email: string[] | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          attachments?: Json | null
          body?: string | null
          cc_email?: string[] | null
          channel?: Database["public"]["Enums"]["conversation_channel"] | null
          contact_id?: string | null
          created_at?: string | null
          direction?: string | null
          from_email?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          handled_by?: string | null
          id?: string
          interaction_date?: string | null
          interaction_type: Database["public"]["Enums"]["interaction_type"]
          labels?: string[] | null
          lead_id?: string | null
          matched_at?: string | null
          matched_by?: string | null
          notes?: string | null
          snippet?: string | null
          subject?: string | null
          to_email?: string[] | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          attachments?: Json | null
          body?: string | null
          cc_email?: string[] | null
          channel?: Database["public"]["Enums"]["conversation_channel"] | null
          contact_id?: string | null
          created_at?: string | null
          direction?: string | null
          from_email?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          handled_by?: string | null
          id?: string
          interaction_date?: string | null
          interaction_type?: Database["public"]["Enums"]["interaction_type"]
          labels?: string[] | null
          lead_id?: string | null
          matched_at?: string | null
          matched_by?: string | null
          notes?: string | null
          snippet?: string | null
          subject?: string | null
          to_email?: string[] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_interactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_interactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_interactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_interactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_interactions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_interactions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "client_interactions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      client_invoice_documents: {
        Row: {
          account_id: string
          amount: number
          counterparty_name: string
          created_at: string | null
          currency: string
          direction: string
          drive_file_id: string | null
          expense_id: string | null
          file_name: string | null
          file_url: string | null
          id: string
          invoice_number: string
          issue_date: string | null
          month: number
          sales_invoice_id: string | null
          storage_path: string | null
          year: number
        }
        Insert: {
          account_id: string
          amount: number
          counterparty_name: string
          created_at?: string | null
          currency?: string
          direction: string
          drive_file_id?: string | null
          expense_id?: string | null
          file_name?: string | null
          file_url?: string | null
          id?: string
          invoice_number: string
          issue_date?: string | null
          month: number
          sales_invoice_id?: string | null
          storage_path?: string | null
          year: number
        }
        Update: {
          account_id?: string
          amount?: number
          counterparty_name?: string
          created_at?: string | null
          currency?: string
          direction?: string
          drive_file_id?: string | null
          expense_id?: string | null
          file_name?: string | null
          file_url?: string | null
          id?: string
          invoice_number?: string
          issue_date?: string | null
          month?: number
          sales_invoice_id?: string | null
          storage_path?: string | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "client_invoice_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoice_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoice_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_invoice_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_invoice_documents_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "client_expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoice_documents_sales_invoice_id_fkey"
            columns: ["sales_invoice_id"]
            isOneToOne: false
            referencedRelation: "client_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      client_invoice_items: {
        Row: {
          amount: number
          description: string
          id: string
          invoice_id: string
          quantity: number | null
          sort_order: number | null
          tax_amount: number | null
          tax_rate: number | null
          unit_price: number
        }
        Insert: {
          amount: number
          description: string
          id?: string
          invoice_id: string
          quantity?: number | null
          sort_order?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          unit_price: number
        }
        Update: {
          amount?: number
          description?: string
          id?: string
          invoice_id?: string
          quantity?: number | null
          sort_order?: number | null
          tax_amount?: number | null
          tax_rate?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "client_invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "client_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      client_invoice_templates: {
        Row: {
          account_id: string
          created_at: string
          currency: string
          customer_id: string | null
          id: string
          items: Json
          message: string | null
          name: string
        }
        Insert: {
          account_id: string
          created_at?: string
          currency?: string
          customer_id?: string | null
          id?: string
          items?: Json
          message?: string | null
          name: string
        }
        Update: {
          account_id?: string
          created_at?: string
          currency?: string
          customer_id?: string | null
          id?: string
          items?: Json
          message?: string | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_invoice_templates_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoice_templates_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoice_templates_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_invoice_templates_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_invoice_templates_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "client_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      client_invoices: {
        Row: {
          account_id: string | null
          amount_due: number | null
          amount_paid: number | null
          bank_account_id: string | null
          contact_id: string | null
          created_at: string | null
          currency: string | null
          customer_id: string
          discount: number | null
          due_date: string | null
          id: string
          invoice_number: string
          issue_date: string | null
          message: string | null
          notes: string | null
          paid_date: string | null
          parent_invoice_id: string | null
          recurring_end_date: string | null
          recurring_frequency: string | null
          recurring_next_date: string | null
          recurring_parent_id: string | null
          source: string | null
          status: string | null
          subtotal: number | null
          tax_total: number | null
          total: number | null
          updated_at: string | null
          whop_checkout_url: string | null
          whop_plan_id: string | null
        }
        Insert: {
          account_id?: string | null
          amount_due?: number | null
          amount_paid?: number | null
          bank_account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          currency?: string | null
          customer_id: string
          discount?: number | null
          due_date?: string | null
          id?: string
          invoice_number: string
          issue_date?: string | null
          message?: string | null
          notes?: string | null
          paid_date?: string | null
          parent_invoice_id?: string | null
          recurring_end_date?: string | null
          recurring_frequency?: string | null
          recurring_next_date?: string | null
          recurring_parent_id?: string | null
          source?: string | null
          status?: string | null
          subtotal?: number | null
          tax_total?: number | null
          total?: number | null
          updated_at?: string | null
          whop_checkout_url?: string | null
          whop_plan_id?: string | null
        }
        Update: {
          account_id?: string | null
          amount_due?: number | null
          amount_paid?: number | null
          bank_account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          currency?: string | null
          customer_id?: string
          discount?: number | null
          due_date?: string | null
          id?: string
          invoice_number?: string
          issue_date?: string | null
          message?: string | null
          notes?: string | null
          paid_date?: string | null
          parent_invoice_id?: string | null
          recurring_end_date?: string | null
          recurring_frequency?: string | null
          recurring_next_date?: string | null
          recurring_parent_id?: string | null
          source?: string | null
          status?: string | null
          subtotal?: number | null
          tax_total?: number | null
          total?: number | null
          updated_at?: string | null
          whop_checkout_url?: string | null
          whop_plan_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_invoices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_invoices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_invoices_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "client_bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoices_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoices_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "client_invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "client_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoices_parent_invoice_id_fkey"
            columns: ["parent_invoice_id"]
            isOneToOne: false
            referencedRelation: "client_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invoices_recurring_parent_id_fkey"
            columns: ["recurring_parent_id"]
            isOneToOne: false
            referencedRelation: "client_invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      client_partners: {
        Row: {
          agreed_services: string[] | null
          commission_model: string | null
          contact_id: string
          created_at: string | null
          id: string
          is_test: boolean | null
          notes: string | null
          partner_email: string | null
          partner_name: string
          price_list: Json | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          agreed_services?: string[] | null
          commission_model?: string | null
          contact_id: string
          created_at?: string | null
          id?: string
          is_test?: boolean | null
          notes?: string | null
          partner_email?: string | null
          partner_name: string
          price_list?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          agreed_services?: string[] | null
          commission_model?: string | null
          contact_id?: string
          created_at?: string | null
          id?: string
          is_test?: boolean | null
          notes?: string | null
          partner_email?: string | null
          partner_name?: string
          price_list?: Json | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_partners_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_partners_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      client_vendors: {
        Row: {
          account_id: string
          address: string | null
          contact_person: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          updated_at: string | null
          vat_number: string | null
        }
        Insert: {
          account_id: string
          address?: string | null
          contact_person?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
          vat_number?: string | null
        }
        Update: {
          account_id?: string
          address?: string | null
          contact_person?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          updated_at?: string | null
          vat_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_vendors_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_vendors_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_vendors_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "client_vendors_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      closure_submissions: {
        Row: {
          access_code: string | null
          account_id: string | null
          changed_fields: Json | null
          client_ip: string | null
          client_user_agent: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          language: string
          lead_id: string | null
          opened_at: string | null
          prefilled_data: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          sent_at: string | null
          status: string
          submitted_data: Json | null
          token: string
          updated_at: string | null
          upload_paths: string[] | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string
          submitted_data?: Json | null
          token: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string
          submitted_data?: Json | null
          token?: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "closure_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "closure_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "closure_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "closure_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "closure_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "closure_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "closure_submissions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      company_info_submissions: {
        Row: {
          access_code: string | null
          account_id: string | null
          changed_fields: Json | null
          client_ip: string | null
          client_user_agent: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string | null
          entity_type: string
          id: string
          language: string
          lead_id: string | null
          opened_at: string | null
          prefilled_data: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          sent_at: string | null
          state: string
          status: string
          submitted_data: Json | null
          token: string
          updated_at: string | null
          upload_paths: string[] | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          state?: string
          status?: string
          submitted_data?: Json | null
          token: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          state?: string
          status?: string
          submitted_data?: Json | null
          token?: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Relationships: []
      }
      compliance_requirements: {
        Row: {
          category: number
          created_at: string | null
          description: string | null
          document_type_name: string
          entity_type: string
          id: number
          is_required: boolean | null
        }
        Insert: {
          category: number
          created_at?: string | null
          description?: string | null
          document_type_name: string
          entity_type: string
          id?: number
          is_required?: boolean | null
        }
        Update: {
          category?: number
          created_at?: string | null
          description?: string | null
          document_type_name?: string
          entity_type?: string
          id?: number
          is_required?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_compliance_doc_type"
            columns: ["document_type_name"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["type_name"]
          },
        ]
      }
      contacts: {
        Row: {
          airtable_id: string | null
          citizenship: string | null
          created_at: string | null
          date_of_birth: string | null
          drive_folder_id: string | null
          email: string | null
          email_2: string | null
          first_name: string | null
          full_name: string
          gdrive_folder_url: string | null
          gender: string | null
          hubspot_id: string | null
          id: string
          is_test: boolean | null
          itin_issue_date: string | null
          itin_number: string | null
          itin_renewal_date: string | null
          kyc_status: string | null
          language: string | null
          last_name: string | null
          notes: string | null
          passport_expiry_date: string | null
          passport_number: string | null
          passport_on_file: boolean | null
          phone: string | null
          phone_2: string | null
          portal_email_sent_at: string | null
          portal_email_template: string | null
          portal_role: string | null
          portal_tier: string | null
          preferred_channel:
            | Database["public"]["Enums"]["conversation_channel"]
            | null
          primary_company_id: string | null
          qb_customer_id: string | null
          referral_code: string | null
          referrer_type: string | null
          residency: string | null
          status: string | null
          updated_at: string | null
          zoho_contact_id: string | null
        }
        Insert: {
          airtable_id?: string | null
          citizenship?: string | null
          created_at?: string | null
          date_of_birth?: string | null
          drive_folder_id?: string | null
          email?: string | null
          email_2?: string | null
          first_name?: string | null
          full_name: string
          gdrive_folder_url?: string | null
          gender?: string | null
          hubspot_id?: string | null
          id?: string
          is_test?: boolean | null
          itin_issue_date?: string | null
          itin_number?: string | null
          itin_renewal_date?: string | null
          kyc_status?: string | null
          language?: string | null
          last_name?: string | null
          notes?: string | null
          passport_expiry_date?: string | null
          passport_number?: string | null
          passport_on_file?: boolean | null
          phone?: string | null
          phone_2?: string | null
          portal_email_sent_at?: string | null
          portal_email_template?: string | null
          portal_role?: string | null
          portal_tier?: string | null
          preferred_channel?:
            | Database["public"]["Enums"]["conversation_channel"]
            | null
          primary_company_id?: string | null
          qb_customer_id?: string | null
          referral_code?: string | null
          referrer_type?: string | null
          residency?: string | null
          status?: string | null
          updated_at?: string | null
          zoho_contact_id?: string | null
        }
        Update: {
          airtable_id?: string | null
          citizenship?: string | null
          created_at?: string | null
          date_of_birth?: string | null
          drive_folder_id?: string | null
          email?: string | null
          email_2?: string | null
          first_name?: string | null
          full_name?: string
          gdrive_folder_url?: string | null
          gender?: string | null
          hubspot_id?: string | null
          id?: string
          is_test?: boolean | null
          itin_issue_date?: string | null
          itin_number?: string | null
          itin_renewal_date?: string | null
          kyc_status?: string | null
          language?: string | null
          last_name?: string | null
          notes?: string | null
          passport_expiry_date?: string | null
          passport_number?: string | null
          passport_on_file?: boolean | null
          phone?: string | null
          phone_2?: string | null
          portal_email_sent_at?: string | null
          portal_email_template?: string | null
          portal_role?: string | null
          portal_tier?: string | null
          preferred_channel?:
            | Database["public"]["Enums"]["conversation_channel"]
            | null
          primary_company_id?: string | null
          qb_customer_id?: string | null
          referral_code?: string | null
          referrer_type?: string | null
          residency?: string | null
          status?: string | null
          updated_at?: string | null
          zoho_contact_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_primary_company_id_fkey"
            columns: ["primary_company_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_primary_company_id_fkey"
            columns: ["primary_company_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_primary_company_id_fkey"
            columns: ["primary_company_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "contacts_primary_company_id_fkey"
            columns: ["primary_company_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      contracts: {
        Row: {
          annual_fee: string | null
          client_address: string | null
          client_city: string | null
          client_country: string | null
          client_email: string | null
          client_name: string
          client_nationality: string | null
          client_passport: string | null
          client_passport_exp: string | null
          client_phone: string | null
          client_state: string | null
          client_zip: string | null
          contract_year: string | null
          created_at: string | null
          id: string
          installments: string | null
          llc_type: string | null
          offer_token: string
          payment_verified: boolean | null
          pdf_path: string | null
          selected_services: Json | null
          signed_at: string | null
          signed_ip: string | null
          status: string | null
          updated_at: string | null
          wire_receipt_path: string | null
        }
        Insert: {
          annual_fee?: string | null
          client_address?: string | null
          client_city?: string | null
          client_country?: string | null
          client_email?: string | null
          client_name: string
          client_nationality?: string | null
          client_passport?: string | null
          client_passport_exp?: string | null
          client_phone?: string | null
          client_state?: string | null
          client_zip?: string | null
          contract_year?: string | null
          created_at?: string | null
          id?: string
          installments?: string | null
          llc_type?: string | null
          offer_token: string
          payment_verified?: boolean | null
          pdf_path?: string | null
          selected_services?: Json | null
          signed_at?: string | null
          signed_ip?: string | null
          status?: string | null
          updated_at?: string | null
          wire_receipt_path?: string | null
        }
        Update: {
          annual_fee?: string | null
          client_address?: string | null
          client_city?: string | null
          client_country?: string | null
          client_email?: string | null
          client_name?: string
          client_nationality?: string | null
          client_passport?: string | null
          client_passport_exp?: string | null
          client_phone?: string | null
          client_state?: string | null
          client_zip?: string | null
          contract_year?: string | null
          created_at?: string | null
          id?: string
          installments?: string | null
          llc_type?: string | null
          offer_token?: string
          payment_verified?: boolean | null
          pdf_path?: string | null
          selected_services?: Json | null
          signed_at?: string | null
          signed_ip?: string | null
          status?: string | null
          updated_at?: string | null
          wire_receipt_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contracts_offer_token_fkey"
            columns: ["offer_token"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["token"]
          },
        ]
      }
      conversations: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          category: string | null
          channel: Database["public"]["Enums"]["conversation_channel"] | null
          client_message: string | null
          contact_id: string | null
          created_at: string | null
          date: string | null
          deal_id: string | null
          direction: string | null
          fireflies_link: string | null
          handled_by: string | null
          id: string
          internal_notes: string | null
          response_language: string | null
          response_sent: string | null
          status: Database["public"]["Enums"]["conversation_status"] | null
          template_used: string | null
          topic: string | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          airtable_id?: string | null
          category?: string | null
          channel?: Database["public"]["Enums"]["conversation_channel"] | null
          client_message?: string | null
          contact_id?: string | null
          created_at?: string | null
          date?: string | null
          deal_id?: string | null
          direction?: string | null
          fireflies_link?: string | null
          handled_by?: string | null
          id?: string
          internal_notes?: string | null
          response_language?: string | null
          response_sent?: string | null
          status?: Database["public"]["Enums"]["conversation_status"] | null
          template_used?: string | null
          topic?: string | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          airtable_id?: string | null
          category?: string | null
          channel?: Database["public"]["Enums"]["conversation_channel"] | null
          client_message?: string | null
          contact_id?: string | null
          created_at?: string | null
          date?: string | null
          deal_id?: string | null
          direction?: string | null
          fireflies_link?: string | null
          handled_by?: string | null
          id?: string
          internal_notes?: string | null
          response_language?: string | null
          response_sent?: string | null
          status?: Database["public"]["Enums"]["conversation_status"] | null
          template_used?: string | null
          topic?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "conversations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "conversations_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_log: {
        Row: {
          details: Json | null
          duration_ms: number | null
          endpoint: string
          error_message: string | null
          executed_at: string | null
          id: string
          status: string
        }
        Insert: {
          details?: Json | null
          duration_ms?: number | null
          endpoint: string
          error_message?: string | null
          executed_at?: string | null
          id?: string
          status: string
        }
        Update: {
          details?: Json | null
          duration_ms?: number | null
          endpoint?: string
          error_message?: string | null
          executed_at?: string | null
          id?: string
          status?: string
        }
        Relationships: []
      }
      dashboard_project: {
        Row: {
          assigned_session: string | null
          blocked_reason: string | null
          commit_hash: string | null
          completed_at: string | null
          created_at: string | null
          depends_on: string | null
          description: string | null
          feature_flag: string | null
          files_edit: string[] | null
          files_new: string[] | null
          id: string
          phase: string
          session_notes: string | null
          started_at: string | null
          status: string | null
          step: string
          step_order: number
          updated_at: string | null
        }
        Insert: {
          assigned_session?: string | null
          blocked_reason?: string | null
          commit_hash?: string | null
          completed_at?: string | null
          created_at?: string | null
          depends_on?: string | null
          description?: string | null
          feature_flag?: string | null
          files_edit?: string[] | null
          files_new?: string[] | null
          id?: string
          phase: string
          session_notes?: string | null
          started_at?: string | null
          status?: string | null
          step: string
          step_order: number
          updated_at?: string | null
        }
        Update: {
          assigned_session?: string | null
          blocked_reason?: string | null
          commit_hash?: string | null
          completed_at?: string | null
          created_at?: string | null
          depends_on?: string | null
          description?: string | null
          feature_flag?: string | null
          files_edit?: string[] | null
          files_new?: string[] | null
          id?: string
          phase?: string
          session_notes?: string | null
          started_at?: string | null
          status?: string | null
          step?: string
          step_order?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      deadlines: {
        Row: {
          account_id: string
          airtable_id: string | null
          assigned_to: string | null
          blocked_reason: string | null
          confirmation_number: string | null
          created_at: string | null
          deadline_record: string | null
          deadline_type: string
          due_date: string
          filed_date: string | null
          id: string
          llc_type: string | null
          notes: string | null
          state: string | null
          status: string | null
          updated_at: string | null
          year: number | null
        }
        Insert: {
          account_id: string
          airtable_id?: string | null
          assigned_to?: string | null
          blocked_reason?: string | null
          confirmation_number?: string | null
          created_at?: string | null
          deadline_record?: string | null
          deadline_type: string
          due_date: string
          filed_date?: string | null
          id?: string
          llc_type?: string | null
          notes?: string | null
          state?: string | null
          status?: string | null
          updated_at?: string | null
          year?: number | null
        }
        Update: {
          account_id?: string
          airtable_id?: string | null
          assigned_to?: string | null
          blocked_reason?: string | null
          confirmation_number?: string | null
          created_at?: string | null
          deadline_record?: string | null
          deadline_type?: string
          due_date?: string
          filed_date?: string | null
          id?: string
          llc_type?: string | null
          notes?: string | null
          state?: string | null
          status?: string | null
          updated_at?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "deadlines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deadlines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deadlines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "deadlines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      deals: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          amount: number | null
          amount_currency: Database["public"]["Enums"]["currency"] | null
          close_date: string | null
          contact_id: string | null
          created_at: string | null
          deal_category: string | null
          deal_name: string
          deal_type: string | null
          hubspot_id: string | null
          id: string
          lead_id: string | null
          notes: string | null
          payment_status: Database["public"]["Enums"]["payment_status"] | null
          pipeline: string | null
          service_type: string | null
          stage: Database["public"]["Enums"]["deal_stage"] | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          airtable_id?: string | null
          amount?: number | null
          amount_currency?: Database["public"]["Enums"]["currency"] | null
          close_date?: string | null
          contact_id?: string | null
          created_at?: string | null
          deal_category?: string | null
          deal_name: string
          deal_type?: string | null
          hubspot_id?: string | null
          id?: string
          lead_id?: string | null
          notes?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"] | null
          pipeline?: string | null
          service_type?: string | null
          stage?: Database["public"]["Enums"]["deal_stage"] | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          airtable_id?: string | null
          amount?: number | null
          amount_currency?: Database["public"]["Enums"]["currency"] | null
          close_date?: string | null
          contact_id?: string | null
          created_at?: string | null
          deal_category?: string | null
          deal_name?: string
          deal_type?: string | null
          hubspot_id?: string | null
          id?: string
          lead_id?: string | null
          notes?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"] | null
          pipeline?: string | null
          service_type?: string | null
          stage?: Database["public"]["Enums"]["deal_stage"] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "deals_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "deals_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "deals_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      deploy_smoke_results: {
        Row: {
          any_failed: boolean
          checked_at: string
          checks: Json
          commit_sha: string
          created_at: string
          failure_count: number
          id: string
          workflow_run_url: string | null
        }
        Insert: {
          any_failed: boolean
          checked_at?: string
          checks: Json
          commit_sha: string
          created_at?: string
          failure_count?: number
          id?: string
          workflow_run_url?: string | null
        }
        Update: {
          any_failed?: boolean
          checked_at?: string
          checks?: Json
          commit_sha?: string
          created_at?: string
          failure_count?: number
          id?: string
          workflow_run_url?: string | null
        }
        Relationships: []
      }
      dev_tasks: {
        Row: {
          blockers: string | null
          completed_at: string | null
          created_at: string | null
          decisions: string | null
          description: string | null
          id: string
          parent_task_id: string | null
          priority: Database["public"]["Enums"]["dev_task_priority"]
          progress_log: string | null
          related_files: string[] | null
          started_at: string | null
          status: Database["public"]["Enums"]["dev_task_status"]
          title: string
          type: Database["public"]["Enums"]["dev_task_type"]
          updated_at: string | null
        }
        Insert: {
          blockers?: string | null
          completed_at?: string | null
          created_at?: string | null
          decisions?: string | null
          description?: string | null
          id?: string
          parent_task_id?: string | null
          priority?: Database["public"]["Enums"]["dev_task_priority"]
          progress_log?: string | null
          related_files?: string[] | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["dev_task_status"]
          title: string
          type?: Database["public"]["Enums"]["dev_task_type"]
          updated_at?: string | null
        }
        Update: {
          blockers?: string | null
          completed_at?: string | null
          created_at?: string | null
          decisions?: string | null
          description?: string | null
          id?: string
          parent_task_id?: string | null
          priority?: Database["public"]["Enums"]["dev_task_priority"]
          progress_log?: string | null
          related_files?: string[] | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["dev_task_status"]
          title?: string
          type?: Database["public"]["Enums"]["dev_task_type"]
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dev_tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "dev_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      document_types: {
        Row: {
          category: number
          category_name: string
          created_at: string | null
          description: string | null
          id: number
          is_active: boolean | null
          suggested_folder: string | null
          type_name: string
          updated_at: string | null
        }
        Insert: {
          category: number
          category_name: string
          created_at?: string | null
          description?: string | null
          id?: number
          is_active?: boolean | null
          suggested_folder?: string | null
          type_name: string
          updated_at?: string | null
        }
        Update: {
          category?: number
          category_name?: string
          created_at?: string | null
          description?: string | null
          id?: number
          is_active?: boolean | null
          suggested_folder?: string | null
          type_name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      documents: {
        Row: {
          account_id: string | null
          account_name: string | null
          category: number | null
          category_name: string | null
          confidence: string | null
          contact_id: string | null
          created_at: string | null
          document_type_id: number | null
          document_type_name: string | null
          drive_file_id: string
          drive_link: string | null
          drive_parent_folder_id: string | null
          error_message: string | null
          file_name: string
          file_size: number | null
          id: string
          mime_type: string | null
          ocr_confidence: number | null
          ocr_page_count: number | null
          ocr_text: string | null
          portal_visible: boolean | null
          processed_at: string | null
          status: string | null
          tax_year: number | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          account_name?: string | null
          category?: number | null
          category_name?: string | null
          confidence?: string | null
          contact_id?: string | null
          created_at?: string | null
          document_type_id?: number | null
          document_type_name?: string | null
          drive_file_id: string
          drive_link?: string | null
          drive_parent_folder_id?: string | null
          error_message?: string | null
          file_name: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          ocr_confidence?: number | null
          ocr_page_count?: number | null
          ocr_text?: string | null
          portal_visible?: boolean | null
          processed_at?: string | null
          status?: string | null
          tax_year?: number | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          account_name?: string | null
          category?: number | null
          category_name?: string | null
          confidence?: string | null
          contact_id?: string | null
          created_at?: string | null
          document_type_id?: number | null
          document_type_name?: string | null
          drive_file_id?: string
          drive_link?: string | null
          drive_parent_folder_id?: string | null
          error_message?: string | null
          file_name?: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          ocr_confidence?: number | null
          ocr_page_count?: number | null
          ocr_text?: string | null
          portal_visible?: boolean | null
          processed_at?: string | null
          status?: string | null
          tax_year?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "documents_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
        ]
      }
      email_links: {
        Row: {
          account_id: string | null
          created_at: string | null
          id: string
          linked_by: string | null
          service_delivery_id: string | null
          thread_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string | null
          id?: string
          linked_by?: string | null
          service_delivery_id?: string | null
          thread_id: string
        }
        Update: {
          account_id?: string | null
          created_at?: string | null
          id?: string
          linked_by?: string | null
          service_delivery_id?: string | null
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "email_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "email_links_service_delivery_id_fkey"
            columns: ["service_delivery_id"]
            isOneToOne: false
            referencedRelation: "service_deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_links_service_delivery_id_fkey"
            columns: ["service_delivery_id"]
            isOneToOne: false
            referencedRelation: "v_active_service_deliveries"
            referencedColumns: ["id"]
          },
        ]
      }
      email_queue: {
        Row: {
          account_id: string | null
          approved_at: string | null
          approved_by: string | null
          body: string
          cc_email: string[] | null
          contact_id: string | null
          created_at: string | null
          created_by: string | null
          email_template_id: string | null
          error_message: string | null
          gmail_message_id: string | null
          gmail_thread_id: string | null
          id: string
          lead_id: string | null
          retry_count: number | null
          sent_at: string | null
          status: Database["public"]["Enums"]["email_queue_status"] | null
          subject: string
          to_email: string
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          body: string
          cc_email?: string[] | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          email_template_id?: string | null
          error_message?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          lead_id?: string | null
          retry_count?: number | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["email_queue_status"] | null
          subject: string
          to_email: string
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          body?: string
          cc_email?: string[] | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          email_template_id?: string | null
          error_message?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          lead_id?: string | null
          retry_count?: number | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["email_queue_status"] | null
          subject?: string
          to_email?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "email_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "email_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_queue_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "email_queue_email_template_id_fkey"
            columns: ["email_template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_queue_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      email_templates: {
        Row: {
          active: boolean | null
          auto_send: boolean | null
          body_template: string
          category: string | null
          created_at: string | null
          id: string
          language: string | null
          notes: string | null
          placeholders: Json | null
          requires_approval: boolean | null
          service_type: Database["public"]["Enums"]["service_type"] | null
          subject_template: string
          template_name: string
          trigger_event: string | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          auto_send?: boolean | null
          body_template: string
          category?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          notes?: string | null
          placeholders?: Json | null
          requires_approval?: boolean | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          subject_template: string
          template_name: string
          trigger_event?: string | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          auto_send?: boolean | null
          body_template?: string
          category?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          notes?: string | null
          placeholders?: Json | null
          requires_approval?: boolean | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          subject_template?: string
          template_name?: string
          trigger_event?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      email_tracking: {
        Row: {
          account_id: string | null
          contact_id: string | null
          created_at: string | null
          first_opened_at: string | null
          from_email: string | null
          gmail_message_id: string | null
          gmail_thread_id: string | null
          id: string
          last_opened_at: string | null
          lead_id: string | null
          offer_token: string | null
          open_count: number | null
          opened: boolean | null
          recipient: string
          subject: string | null
          tracking_id: string
        }
        Insert: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          first_opened_at?: string | null
          from_email?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          last_opened_at?: string | null
          lead_id?: string | null
          offer_token?: string | null
          open_count?: number | null
          opened?: boolean | null
          recipient: string
          subject?: string | null
          tracking_id: string
        }
        Update: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          first_opened_at?: string | null
          from_email?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          last_opened_at?: string | null
          lead_id?: string | null
          offer_token?: string | null
          open_count?: number | null
          opened?: boolean | null
          recipient?: string
          subject?: string | null
          tracking_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_tracking_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_tracking_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_tracking_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "email_tracking_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "email_tracking_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_tracking_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "email_tracking_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      form_8832_applications: {
        Row: {
          access_code: string
          account_id: string | null
          company_name: string
          contact_id: string | null
          created_at: string | null
          effective_date: string | null
          ein: string
          entity_type: string
          id: string
          is_test: boolean | null
          language: string
          member_count: number
          owner_id_number: string | null
          owner_name: string
          owner_title: string
          pdf_signed_drive_id: string | null
          pdf_signed_storage_path: string | null
          signed_at: string | null
          status: string
          token: string
          updated_at: string | null
          view_count: number
          viewed_at: string | null
        }
        Insert: {
          access_code?: string
          account_id?: string | null
          company_name: string
          contact_id?: string | null
          created_at?: string | null
          effective_date?: string | null
          ein: string
          entity_type?: string
          id?: string
          is_test?: boolean | null
          language?: string
          member_count?: number
          owner_id_number?: string | null
          owner_name: string
          owner_title?: string
          pdf_signed_drive_id?: string | null
          pdf_signed_storage_path?: string | null
          signed_at?: string | null
          status?: string
          token: string
          updated_at?: string | null
          view_count?: number
          viewed_at?: string | null
        }
        Update: {
          access_code?: string
          account_id?: string | null
          company_name?: string
          contact_id?: string | null
          created_at?: string | null
          effective_date?: string | null
          ein?: string
          entity_type?: string
          id?: string
          is_test?: boolean | null
          language?: string
          member_count?: number
          owner_id_number?: string | null
          owner_name?: string
          owner_title?: string
          pdf_signed_drive_id?: string | null
          pdf_signed_storage_path?: string | null
          signed_at?: string | null
          status?: string
          token?: string
          updated_at?: string | null
          view_count?: number
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "form_8832_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_8832_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_8832_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "form_8832_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "form_8832_applications_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_8832_applications_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      formation_submissions: {
        Row: {
          access_code: string | null
          changed_fields: Json | null
          client_ip: string | null
          client_user_agent: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string | null
          entity_type: string | null
          id: string
          language: string | null
          lead_id: string | null
          opened_at: string | null
          prefilled_data: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          sent_at: string | null
          state: string | null
          status: string | null
          submitted_data: Json | null
          token: string
          updated_at: string | null
          upload_paths: string[] | null
        }
        Insert: {
          access_code?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string | null
          id?: string
          language?: string | null
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          state?: string | null
          status?: string | null
          submitted_data?: Json | null
          token: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Update: {
          access_code?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string | null
          id?: string
          language?: string | null
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          state?: string | null
          status?: string | null
          submitted_data?: Json | null
          token?: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "formation_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formation_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "formation_submissions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_documents: {
        Row: {
          account_id: string | null
          amount: number | null
          contact_id: string | null
          created_at: string | null
          currency: string | null
          distribution_date: string | null
          document_type: string
          drive_file_id: string | null
          fiscal_year: number
          id: string
          is_test: boolean | null
          metadata: Json | null
          pdf_storage_path: string | null
          signed_at: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          amount?: number | null
          contact_id?: string | null
          created_at?: string | null
          currency?: string | null
          distribution_date?: string | null
          document_type: string
          drive_file_id?: string | null
          fiscal_year: number
          id?: string
          is_test?: boolean | null
          metadata?: Json | null
          pdf_storage_path?: string | null
          signed_at?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          amount?: number | null
          contact_id?: string | null
          created_at?: string | null
          currency?: string | null
          distribution_date?: string | null
          document_type?: string
          drive_file_id?: string | null
          fiscal_year?: number
          id?: string
          is_test?: boolean | null
          metadata?: Json | null
          pdf_storage_path?: string | null
          signed_at?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "generated_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "generated_documents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "generated_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      hc_tokens: {
        Row: {
          access_token: string
          created_at: string | null
          expires_at: string
          id: string
          refresh_token: string
          updated_at: string | null
        }
        Insert: {
          access_token: string
          created_at?: string | null
          expires_at: string
          id?: string
          refresh_token: string
          updated_at?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string | null
          expires_at?: string
          id?: string
          refresh_token?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      hubspot_sync_log: {
        Row: {
          direction: Database["public"]["Enums"]["sync_direction"]
          entity_type: string
          error_message: string | null
          hubspot_id: string
          id: string
          payload: Json | null
          status: string | null
          supabase_id: string
          synced_at: string | null
        }
        Insert: {
          direction: Database["public"]["Enums"]["sync_direction"]
          entity_type: string
          error_message?: string | null
          hubspot_id: string
          id?: string
          payload?: Json | null
          status?: string | null
          supabase_id: string
          synced_at?: string | null
        }
        Update: {
          direction?: Database["public"]["Enums"]["sync_direction"]
          entity_type?: string
          error_message?: string | null
          hubspot_id?: string
          id?: string
          payload?: Json | null
          status?: string | null
          supabase_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      internal_messages: {
        Row: {
          attachment_name: string | null
          attachment_url: string | null
          created_at: string | null
          id: string
          message: string
          read_at: string | null
          sender_id: string
          sender_name: string
          thread_id: string
        }
        Insert: {
          attachment_name?: string | null
          attachment_url?: string | null
          created_at?: string | null
          id?: string
          message: string
          read_at?: string | null
          sender_id: string
          sender_name: string
          thread_id: string
        }
        Update: {
          attachment_name?: string | null
          attachment_url?: string | null
          created_at?: string | null
          id?: string
          message?: string
          read_at?: string | null
          sender_id?: string
          sender_name?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "internal_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "internal_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      internal_threads: {
        Row: {
          account_id: string | null
          contact_id: string | null
          created_at: string | null
          created_by: string
          id: string
          resolved_at: string | null
          source_message_id: string | null
          title: string | null
        }
        Insert: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by: string
          id?: string
          resolved_at?: string | null
          source_message_id?: string | null
          title?: string | null
        }
        Update: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string
          id?: string
          resolved_at?: string | null
          source_message_id?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "internal_threads_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "internal_threads_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "internal_threads_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "internal_threads_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "internal_threads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "internal_threads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      invoice_audit_log: {
        Row: {
          action: string
          changed_fields: Json | null
          id: string
          invoice_id: string
          new_values: Json | null
          performed_at: string | null
          performed_by: string | null
          previous_values: Json | null
        }
        Insert: {
          action: string
          changed_fields?: Json | null
          id?: string
          invoice_id: string
          new_values?: Json | null
          performed_at?: string | null
          performed_by?: string | null
          previous_values?: Json | null
        }
        Update: {
          action?: string
          changed_fields?: Json | null
          id?: string
          invoice_id?: string
          new_values?: Json | null
          performed_at?: string | null
          performed_by?: string | null
          previous_values?: Json | null
        }
        Relationships: []
      }
      invoice_settings: {
        Row: {
          bank_accounts: Json | null
          company_address: string | null
          company_email: string | null
          company_name: string | null
          company_phone: string | null
          created_at: string | null
          default_payment_terms: string | null
          id: string
          invoice_footer: string | null
          invoice_prefix: string | null
          logo_url: string | null
          payment_gateways: Json | null
          tax_id: string | null
          updated_at: string | null
        }
        Insert: {
          bank_accounts?: Json | null
          company_address?: string | null
          company_email?: string | null
          company_name?: string | null
          company_phone?: string | null
          created_at?: string | null
          default_payment_terms?: string | null
          id?: string
          invoice_footer?: string | null
          invoice_prefix?: string | null
          logo_url?: string | null
          payment_gateways?: Json | null
          tax_id?: string | null
          updated_at?: string | null
        }
        Update: {
          bank_accounts?: Json | null
          company_address?: string | null
          company_email?: string | null
          company_name?: string | null
          company_phone?: string | null
          created_at?: string | null
          default_payment_terms?: string | null
          id?: string
          invoice_footer?: string | null
          invoice_prefix?: string | null
          logo_url?: string | null
          payment_gateways?: Json | null
          tax_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      irs_exchange_rates: {
        Row: {
          currency: string
          fetched_at: string | null
          id: string
          rate_to_usd: number
          source_url: string | null
          tax_year: number
        }
        Insert: {
          currency: string
          fetched_at?: string | null
          id?: string
          rate_to_usd: number
          source_url?: string | null
          tax_year: number
        }
        Update: {
          currency?: string
          fetched_at?: string | null
          id?: string
          rate_to_usd?: number
          source_url?: string | null
          tax_year?: number
        }
        Relationships: []
      }
      itin_submissions: {
        Row: {
          access_code: string | null
          account_id: string | null
          changed_fields: Json | null
          client_ip: string | null
          client_user_agent: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          language: string
          lead_id: string | null
          opened_at: string | null
          prefilled_data: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          sent_at: string | null
          status: string
          submitted_data: Json | null
          token: string
          updated_at: string | null
          upload_paths: string[] | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string
          submitted_data?: Json | null
          token: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string
          submitted_data?: Json | null
          token?: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "itin_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "itin_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "itin_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "itin_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "itin_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "itin_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "itin_submissions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      job_queue: {
        Row: {
          account_id: string | null
          attempts: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          job_type: string
          lead_id: string | null
          max_attempts: number
          payload: Json
          priority: number
          related_entity_id: string | null
          related_entity_type: string | null
          result: Json | null
          started_at: string | null
          status: string
        }
        Insert: {
          account_id?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          job_type: string
          lead_id?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          related_entity_id?: string | null
          related_entity_type?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
        }
        Update: {
          account_id?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          job_type?: string
          lead_id?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          related_entity_id?: string | null
          related_entity_type?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "job_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "job_queue_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_articles: {
        Row: {
          airtable_id: string | null
          category: string | null
          content: string
          created_at: string | null
          id: string
          notes: string | null
          tags: string[] | null
          title: string
          updated_at: string | null
          version: string | null
        }
        Insert: {
          airtable_id?: string | null
          category?: string | null
          content: string
          created_at?: string | null
          id?: string
          notes?: string | null
          tags?: string[] | null
          title: string
          updated_at?: string | null
          version?: string | null
        }
        Update: {
          airtable_id?: string | null
          category?: string | null
          content?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          tags?: string[] | null
          title?: string
          updated_at?: string | null
          version?: string | null
        }
        Relationships: []
      }
      leads: {
        Row: {
          airtable_id: string | null
          call_date: string | null
          call_notes: string | null
          channel: Database["public"]["Enums"]["conversation_channel"] | null
          circleback_call_id: string | null
          converted_at: string | null
          converted_to_account_id: string | null
          converted_to_contact_id: string | null
          created_at: string | null
          email: string | null
          first_name: string | null
          full_name: string
          gdrive_folder_url: string | null
          hubspot_id: string | null
          id: string
          is_test: boolean | null
          language: string | null
          last_name: string | null
          notes: string | null
          offer_annual_amount: number | null
          offer_annual_currency: Database["public"]["Enums"]["currency"] | null
          offer_date: string | null
          offer_installment_jan: number | null
          offer_installment_jun: number | null
          offer_link: string | null
          offer_notes: string | null
          offer_optional_services: string[] | null
          offer_services: string[] | null
          offer_status: Database["public"]["Enums"]["offer_status"] | null
          offer_year1_amount: number | null
          offer_year1_currency: Database["public"]["Enums"]["currency"] | null
          phone: string | null
          reason: string | null
          referrer_name: string | null
          referrer_partner_id: string | null
          source: string | null
          status: Database["public"]["Enums"]["lead_status"] | null
          updated_at: string | null
        }
        Insert: {
          airtable_id?: string | null
          call_date?: string | null
          call_notes?: string | null
          channel?: Database["public"]["Enums"]["conversation_channel"] | null
          circleback_call_id?: string | null
          converted_at?: string | null
          converted_to_account_id?: string | null
          converted_to_contact_id?: string | null
          created_at?: string | null
          email?: string | null
          first_name?: string | null
          full_name: string
          gdrive_folder_url?: string | null
          hubspot_id?: string | null
          id?: string
          is_test?: boolean | null
          language?: string | null
          last_name?: string | null
          notes?: string | null
          offer_annual_amount?: number | null
          offer_annual_currency?: Database["public"]["Enums"]["currency"] | null
          offer_date?: string | null
          offer_installment_jan?: number | null
          offer_installment_jun?: number | null
          offer_link?: string | null
          offer_notes?: string | null
          offer_optional_services?: string[] | null
          offer_services?: string[] | null
          offer_status?: Database["public"]["Enums"]["offer_status"] | null
          offer_year1_amount?: number | null
          offer_year1_currency?: Database["public"]["Enums"]["currency"] | null
          phone?: string | null
          reason?: string | null
          referrer_name?: string | null
          referrer_partner_id?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["lead_status"] | null
          updated_at?: string | null
        }
        Update: {
          airtable_id?: string | null
          call_date?: string | null
          call_notes?: string | null
          channel?: Database["public"]["Enums"]["conversation_channel"] | null
          circleback_call_id?: string | null
          converted_at?: string | null
          converted_to_account_id?: string | null
          converted_to_contact_id?: string | null
          created_at?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string
          gdrive_folder_url?: string | null
          hubspot_id?: string | null
          id?: string
          is_test?: boolean | null
          language?: string | null
          last_name?: string | null
          notes?: string | null
          offer_annual_amount?: number | null
          offer_annual_currency?: Database["public"]["Enums"]["currency"] | null
          offer_date?: string | null
          offer_installment_jan?: number | null
          offer_installment_jun?: number | null
          offer_link?: string | null
          offer_notes?: string | null
          offer_optional_services?: string[] | null
          offer_services?: string[] | null
          offer_status?: Database["public"]["Enums"]["offer_status"] | null
          offer_year1_amount?: number | null
          offer_year1_currency?: Database["public"]["Enums"]["currency"] | null
          phone?: string | null
          reason?: string | null
          referrer_name?: string | null
          referrer_partner_id?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["lead_status"] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_converted_to_account_id_fkey"
            columns: ["converted_to_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_converted_to_account_id_fkey"
            columns: ["converted_to_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_converted_to_account_id_fkey"
            columns: ["converted_to_account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "leads_converted_to_account_id_fkey"
            columns: ["converted_to_account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "leads_converted_to_contact_id_fkey"
            columns: ["converted_to_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_converted_to_contact_id_fkey"
            columns: ["converted_to_contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      lease_agreements: {
        Row: {
          access_code: string
          account_id: string | null
          contact_id: string | null
          contract_year: number
          created_at: string
          effective_date: string
          id: string
          landlord_address: string
          landlord_name: string
          landlord_signer: string
          landlord_title: string
          language: string
          late_fee: number
          late_fee_per_day: number
          monthly_rent: number
          pdf_drive_file_id: string | null
          pdf_storage_path: string | null
          premises_address: string
          security_deposit: number
          signature_data: string | null
          signed_at: string | null
          signed_ip: string | null
          square_feet: number
          status: string
          suite_number: string
          tenant_company: string
          tenant_contact_name: string
          tenant_ein: string | null
          tenant_email: string | null
          tenant_state: string | null
          term_end_date: string
          term_months: number
          term_start_date: string
          token: string
          updated_at: string
          view_count: number
          viewed_at: string | null
          yearly_rent: number
        }
        Insert: {
          access_code?: string
          account_id?: string | null
          contact_id?: string | null
          contract_year: number
          created_at?: string
          effective_date: string
          id?: string
          landlord_address?: string
          landlord_name?: string
          landlord_signer?: string
          landlord_title?: string
          language?: string
          late_fee?: number
          late_fee_per_day?: number
          monthly_rent?: number
          pdf_drive_file_id?: string | null
          pdf_storage_path?: string | null
          premises_address?: string
          security_deposit?: number
          signature_data?: string | null
          signed_at?: string | null
          signed_ip?: string | null
          square_feet?: number
          status?: string
          suite_number: string
          tenant_company: string
          tenant_contact_name: string
          tenant_ein?: string | null
          tenant_email?: string | null
          tenant_state?: string | null
          term_end_date: string
          term_months?: number
          term_start_date: string
          token: string
          updated_at?: string
          view_count?: number
          viewed_at?: string | null
          yearly_rent?: number
        }
        Update: {
          access_code?: string
          account_id?: string | null
          contact_id?: string | null
          contract_year?: number
          created_at?: string
          effective_date?: string
          id?: string
          landlord_address?: string
          landlord_name?: string
          landlord_signer?: string
          landlord_title?: string
          language?: string
          late_fee?: number
          late_fee_per_day?: number
          monthly_rent?: number
          pdf_drive_file_id?: string | null
          pdf_storage_path?: string | null
          premises_address?: string
          security_deposit?: number
          signature_data?: string | null
          signed_at?: string | null
          signed_ip?: string | null
          square_feet?: number
          status?: string
          suite_number?: string
          tenant_company?: string
          tenant_contact_name?: string
          tenant_ein?: string | null
          tenant_email?: string | null
          tenant_state?: string | null
          term_end_date?: string
          term_months?: number
          term_start_date?: string
          token?: string
          updated_at?: string
          view_count?: number
          viewed_at?: string | null
          yearly_rent?: number
        }
        Relationships: [
          {
            foreignKeyName: "lease_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "lease_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "lease_agreements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_agreements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      mcp_tool_counter: {
        Row: {
          calls_since_checkpoint: number
          id: number
          last_checkpoint_at: string
          updated_at: string
        }
        Insert: {
          calls_since_checkpoint?: number
          id?: number
          last_checkpoint_at?: string
          updated_at?: string
        }
        Update: {
          calls_since_checkpoint?: number
          id?: number
          last_checkpoint_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      message_actions: {
        Row: {
          account_id: string | null
          action_type: string
          contact_id: string | null
          created_at: string | null
          created_by: string | null
          id: string
          label: string | null
          message_id: string | null
          resolved_at: string | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          action_type: string
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          label?: string | null
          message_id?: string | null
          resolved_at?: string | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          action_type?: string
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          label?: string | null
          message_id?: string | null
          resolved_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "message_actions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_actions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_actions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "message_actions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "message_actions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_actions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "message_actions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "portal_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_responses: {
        Row: {
          approved_by: string | null
          created_at: string
          draft_text: string | null
          error_message: string | null
          final_text: string | null
          id: string
          message_id: string
          sent_at: string | null
          sent_via: string | null
          status: string
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          created_at?: string
          draft_text?: string | null
          error_message?: string | null
          final_text?: string | null
          id?: string
          message_id: string
          sent_at?: string | null
          sent_via?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          created_at?: string
          draft_text?: string | null
          error_message?: string | null
          final_text?: string | null
          id?: string
          message_id?: string
          sent_at?: string | null
          sent_via?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_responses_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_responses_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "v_new_messages"
            referencedColumns: ["message_id"]
          },
        ]
      }
      messages: {
        Row: {
          account_id: string | null
          ai_draft: string | null
          channel_id: string
          contact_id: string | null
          content_text: string | null
          content_type: string
          created_at: string
          direction: string
          external_message_id: string | null
          group_id: string
          id: string
          media_url: string | null
          metadata: Json | null
          responded_at: string | null
          responded_by: string | null
          sender_name: string | null
          sender_phone: string | null
          status: string
        }
        Insert: {
          account_id?: string | null
          ai_draft?: string | null
          channel_id: string
          contact_id?: string | null
          content_text?: string | null
          content_type?: string
          created_at?: string
          direction: string
          external_message_id?: string | null
          group_id: string
          id?: string
          media_url?: string | null
          metadata?: Json | null
          responded_at?: string | null
          responded_by?: string | null
          sender_name?: string | null
          sender_phone?: string | null
          status?: string
        }
        Update: {
          account_id?: string | null
          ai_draft?: string | null
          channel_id?: string
          contact_id?: string | null
          content_text?: string | null
          content_type?: string
          created_at?: string
          direction?: string
          external_message_id?: string | null
          group_id?: string
          id?: string
          media_url?: string | null
          metadata?: Json | null
          responded_at?: string | null
          responded_by?: string | null
          sender_name?: string | null
          sender_phone?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "messaging_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "messages_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "messaging_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "v_messaging_inbox"
            referencedColumns: ["group_id"]
          },
        ]
      }
      messaging_channels: {
        Row: {
          channel_name: string
          config_json: Json | null
          created_at: string
          id: string
          is_active: boolean
          phone_number: string | null
          platform: string
          provider: string
          updated_at: string
          webhook_secret: string | null
        }
        Insert: {
          channel_name: string
          config_json?: Json | null
          created_at?: string
          id?: string
          is_active?: boolean
          phone_number?: string | null
          platform: string
          provider: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Update: {
          channel_name?: string
          config_json?: Json | null
          created_at?: string
          id?: string
          is_active?: boolean
          phone_number?: string | null
          platform?: string
          provider?: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Relationships: []
      }
      messaging_groups: {
        Row: {
          account_id: string | null
          channel_id: string
          contact_id: string | null
          created_at: string
          external_group_id: string
          group_name: string | null
          group_type: string
          id: string
          is_active: boolean
          last_message_at: string | null
          lead_id: string | null
          unread_count: number
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          channel_id: string
          contact_id?: string | null
          created_at?: string
          external_group_id: string
          group_name?: string | null
          group_type?: string
          id?: string
          is_active?: boolean
          last_message_at?: string | null
          lead_id?: string | null
          unread_count?: number
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          channel_id?: string
          contact_id?: string | null
          created_at?: string
          external_group_id?: string
          group_name?: string | null
          group_type?: string
          id?: string
          is_active?: boolean
          last_message_at?: string | null
          lead_id?: string | null
          unread_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messaging_groups_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_groups_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_groups_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "messaging_groups_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "messaging_groups_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "messaging_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_groups_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_groups_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "messaging_groups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      oa_agreements: {
        Row: {
          access_code: string | null
          account_id: string | null
          accounting_method: string | null
          business_purpose: string | null
          company_name: string
          contact_id: string | null
          created_at: string | null
          duration: string | null
          effective_date: string
          ein_number: string | null
          entity_type: string | null
          fiscal_year_end: string | null
          formation_date: string | null
          id: string
          initial_contribution: string | null
          language: string | null
          manager_name: string | null
          member_address: string | null
          member_email: string | null
          member_name: string
          member_ownership_pct: number | null
          members: Json | null
          pdf_storage_path: string | null
          principal_address: string | null
          registered_agent_address: string | null
          registered_agent_name: string | null
          signature_data: Json | null
          signed_at: string | null
          signed_count: number | null
          state_of_formation: string
          status: string | null
          token: string
          total_signers: number | null
          updated_at: string | null
          view_count: number | null
          viewed_at: string | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          accounting_method?: string | null
          business_purpose?: string | null
          company_name: string
          contact_id?: string | null
          created_at?: string | null
          duration?: string | null
          effective_date: string
          ein_number?: string | null
          entity_type?: string | null
          fiscal_year_end?: string | null
          formation_date?: string | null
          id?: string
          initial_contribution?: string | null
          language?: string | null
          manager_name?: string | null
          member_address?: string | null
          member_email?: string | null
          member_name: string
          member_ownership_pct?: number | null
          members?: Json | null
          pdf_storage_path?: string | null
          principal_address?: string | null
          registered_agent_address?: string | null
          registered_agent_name?: string | null
          signature_data?: Json | null
          signed_at?: string | null
          signed_count?: number | null
          state_of_formation: string
          status?: string | null
          token: string
          total_signers?: number | null
          updated_at?: string | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          accounting_method?: string | null
          business_purpose?: string | null
          company_name?: string
          contact_id?: string | null
          created_at?: string | null
          duration?: string | null
          effective_date?: string
          ein_number?: string | null
          entity_type?: string | null
          fiscal_year_end?: string | null
          formation_date?: string | null
          id?: string
          initial_contribution?: string | null
          language?: string | null
          manager_name?: string | null
          member_address?: string | null
          member_email?: string | null
          member_name?: string
          member_ownership_pct?: number | null
          members?: Json | null
          pdf_storage_path?: string | null
          principal_address?: string | null
          registered_agent_address?: string | null
          registered_agent_name?: string | null
          signature_data?: Json | null
          signed_at?: string | null
          signed_count?: number | null
          state_of_formation?: string
          status?: string | null
          token?: string
          total_signers?: number | null
          updated_at?: string | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "oa_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oa_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oa_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "oa_agreements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "oa_agreements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oa_agreements_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      oa_signatures: {
        Row: {
          access_code: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          member_email: string | null
          member_index: number
          member_name: string
          oa_id: string
          sent_at: string | null
          signature_image_path: string | null
          signed_at: string | null
          signed_by_name: string | null
          status: string | null
          updated_at: string | null
          view_count: number | null
          viewed_at: string | null
        }
        Insert: {
          access_code?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          member_email?: string | null
          member_index: number
          member_name: string
          oa_id: string
          sent_at?: string | null
          signature_image_path?: string | null
          signed_at?: string | null
          signed_by_name?: string | null
          status?: string | null
          updated_at?: string | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Update: {
          access_code?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          member_email?: string | null
          member_index?: number
          member_name?: string
          oa_id?: string
          sent_at?: string | null
          signature_image_path?: string | null
          signed_at?: string | null
          signed_by_name?: string | null
          status?: string | null
          updated_at?: string | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "oa_signatures_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oa_signatures_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "oa_signatures_oa_id_fkey"
            columns: ["oa_id"]
            isOneToOne: false
            referencedRelation: "oa_agreements"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_clients: {
        Row: {
          client_id: string
          client_name: string | null
          client_secret: string
          created_at: string
          grant_types: string[]
          id: string
          redirect_uris: string[]
          response_types: string[]
          token_endpoint_auth_method: string
        }
        Insert: {
          client_id: string
          client_name?: string | null
          client_secret: string
          created_at?: string
          grant_types?: string[]
          id?: string
          redirect_uris?: string[]
          response_types?: string[]
          token_endpoint_auth_method?: string
        }
        Update: {
          client_id?: string
          client_name?: string | null
          client_secret?: string
          created_at?: string
          grant_types?: string[]
          id?: string
          redirect_uris?: string[]
          response_types?: string[]
          token_endpoint_auth_method?: string
        }
        Relationships: []
      }
      oauth_codes: {
        Row: {
          client_id: string
          code: string
          code_challenge: string | null
          code_challenge_method: string | null
          created_at: string
          expires_at: string
          id: string
          redirect_uri: string
          scope: string | null
          used: boolean
          user_id: string
        }
        Insert: {
          client_id: string
          code: string
          code_challenge?: string | null
          code_challenge_method?: string | null
          created_at?: string
          expires_at: string
          id?: string
          redirect_uri: string
          scope?: string | null
          used?: boolean
          user_id: string
        }
        Update: {
          client_id?: string
          code?: string
          code_challenge?: string | null
          code_challenge_method?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          redirect_uri?: string
          scope?: string | null
          used?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_codes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      oauth_tokens: {
        Row: {
          access_token: string
          access_token_expires_at: string
          client_id: string
          created_at: string
          id: string
          refresh_token: string | null
          refresh_token_expires_at: string | null
          revoked: boolean
          scope: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          access_token_expires_at: string
          client_id: string
          created_at?: string
          id?: string
          refresh_token?: string | null
          refresh_token_expires_at?: string | null
          revoked?: boolean
          scope?: string | null
          user_id: string
        }
        Update: {
          access_token?: string
          access_token_expires_at?: string
          client_id?: string
          created_at?: string
          id?: string
          refresh_token?: string | null
          refresh_token_expires_at?: string | null
          revoked?: boolean
          scope?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_tokens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["client_id"]
          },
        ]
      }
      oauth_users: {
        Row: {
          active: boolean
          created_at: string
          email: string
          id: string
          name: string | null
          pin_hash: string
          role: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          email: string
          id?: string
          name?: string | null
          pin_hash: string
          role?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          email?: string
          id?: string
          name?: string | null
          pin_hash?: string
          role?: string
        }
        Relationships: []
      }
      offers: {
        Row: {
          access_code: string | null
          account_id: string | null
          additional_services: Json | null
          admin_notes: string | null
          bank_details: Json | null
          bundled_pipelines: string[] | null
          client_email: string | null
          client_name: string
          contract_type: string | null
          cost_summary: Json | null
          created_at: string | null
          currency: string | null
          deal_id: string | null
          effective_date: string | null
          expires_at: string | null
          future_developments: Json | null
          id: string
          immediate_actions: Json | null
          installment_currency: string | null
          intro_en: string | null
          intro_it: string | null
          issues: Json | null
          language: string
          lead_id: string | null
          next_steps: Json | null
          offer_date: string
          payment_links: Json | null
          payment_type: string | null
          recurring_costs: Json | null
          referrer_account_id: string | null
          referrer_agreed_price: number | null
          referrer_commission_pct: number | null
          referrer_commission_type: string | null
          referrer_email: string | null
          referrer_name: string | null
          referrer_notes: string | null
          referrer_type: string | null
          required_documents: Json | null
          selected_services: Json | null
          services: Json | null
          status: string | null
          strategy: Json | null
          superseded_by: string | null
          token: string
          updated_at: string | null
          version: number | null
          view_count: number | null
          viewed_at: string | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          additional_services?: Json | null
          admin_notes?: string | null
          bank_details?: Json | null
          bundled_pipelines?: string[] | null
          client_email?: string | null
          client_name: string
          contract_type?: string | null
          cost_summary?: Json | null
          created_at?: string | null
          currency?: string | null
          deal_id?: string | null
          effective_date?: string | null
          expires_at?: string | null
          future_developments?: Json | null
          id?: string
          immediate_actions?: Json | null
          installment_currency?: string | null
          intro_en?: string | null
          intro_it?: string | null
          issues?: Json | null
          language?: string
          lead_id?: string | null
          next_steps?: Json | null
          offer_date?: string
          payment_links?: Json | null
          payment_type?: string | null
          recurring_costs?: Json | null
          referrer_account_id?: string | null
          referrer_agreed_price?: number | null
          referrer_commission_pct?: number | null
          referrer_commission_type?: string | null
          referrer_email?: string | null
          referrer_name?: string | null
          referrer_notes?: string | null
          referrer_type?: string | null
          required_documents?: Json | null
          selected_services?: Json | null
          services?: Json | null
          status?: string | null
          strategy?: Json | null
          superseded_by?: string | null
          token: string
          updated_at?: string | null
          version?: number | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          additional_services?: Json | null
          admin_notes?: string | null
          bank_details?: Json | null
          bundled_pipelines?: string[] | null
          client_email?: string | null
          client_name?: string
          contract_type?: string | null
          cost_summary?: Json | null
          created_at?: string | null
          currency?: string | null
          deal_id?: string | null
          effective_date?: string | null
          expires_at?: string | null
          future_developments?: Json | null
          id?: string
          immediate_actions?: Json | null
          installment_currency?: string | null
          intro_en?: string | null
          intro_it?: string | null
          issues?: Json | null
          language?: string
          lead_id?: string | null
          next_steps?: Json | null
          offer_date?: string
          payment_links?: Json | null
          payment_type?: string | null
          recurring_costs?: Json | null
          referrer_account_id?: string | null
          referrer_agreed_price?: number | null
          referrer_commission_pct?: number | null
          referrer_commission_type?: string | null
          referrer_email?: string | null
          referrer_name?: string | null
          referrer_notes?: string | null
          referrer_type?: string | null
          required_documents?: Json | null
          selected_services?: Json | null
          services?: Json | null
          status?: string | null
          strategy?: Json | null
          superseded_by?: string | null
          token?: string
          updated_at?: string | null
          version?: number | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "offers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "offers_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "offers_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      onboarding_submissions: {
        Row: {
          access_code: string | null
          account_id: string | null
          changed_fields: Json | null
          client_ip: string | null
          client_user_agent: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string | null
          entity_type: string
          id: string
          language: string
          lead_id: string | null
          opened_at: string | null
          prefilled_data: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          sent_at: string | null
          state: string
          status: string
          submitted_data: Json | null
          token: string
          updated_at: string | null
          upload_paths: string[] | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          state?: string
          status?: string
          submitted_data?: Json | null
          token: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string
          id?: string
          language?: string
          lead_id?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          state?: string
          status?: string
          submitted_data?: Json | null
          token?: string
          updated_at?: string | null
          upload_paths?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "onboarding_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "onboarding_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "onboarding_submissions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_client_deals: {
        Row: {
          deal_id: string
          partner_client_id: string
        }
        Insert: {
          deal_id: string
          partner_client_id: string
        }
        Update: {
          deal_id?: string
          partner_client_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_client_deals_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_client_deals_partner_client_id_fkey"
            columns: ["partner_client_id"]
            isOneToOne: false
            referencedRelation: "partner_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_client_services: {
        Row: {
          partner_client_id: string
          service_id: string
        }
        Insert: {
          partner_client_id: string
          service_id: string
        }
        Update: {
          partner_client_id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_client_services_partner_client_id_fkey"
            columns: ["partner_client_id"]
            isOneToOne: false
            referencedRelation: "partner_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_client_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_client_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["service_id"]
          },
        ]
      }
      partner_clients: {
        Row: {
          airtable_id: string | null
          company_name: string | null
          created_at: string | null
          documents_notes: string | null
          ein: string | null
          email: string | null
          full_name: string
          gdrive_folder_url: string | null
          id: string
          notes: string | null
          partner_id: string | null
          passport_on_file: boolean | null
          phone: string | null
          updated_at: string | null
        }
        Insert: {
          airtable_id?: string | null
          company_name?: string | null
          created_at?: string | null
          documents_notes?: string | null
          ein?: string | null
          email?: string | null
          full_name: string
          gdrive_folder_url?: string | null
          id?: string
          notes?: string | null
          partner_id?: string | null
          passport_on_file?: boolean | null
          phone?: string | null
          updated_at?: string | null
        }
        Update: {
          airtable_id?: string | null
          company_name?: string | null
          created_at?: string | null
          documents_notes?: string | null
          ein?: string | null
          email?: string | null
          full_name?: string
          gdrive_folder_url?: string | null
          id?: string
          notes?: string | null
          partner_id?: string | null
          passport_on_file?: boolean | null
          phone?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "partner_clients_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partners"
            referencedColumns: ["id"]
          },
        ]
      }
      partners: {
        Row: {
          airtable_id: string | null
          commission_structure: string | null
          company: string | null
          country: string | null
          created_at: string | null
          email: string | null
          hubspot_id: string | null
          id: string
          notes: string | null
          partner_name: string
          partner_type: Database["public"]["Enums"]["partner_type"] | null
          phone: string | null
          secondary_email: string | null
          service_area: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          airtable_id?: string | null
          commission_structure?: string | null
          company?: string | null
          country?: string | null
          created_at?: string | null
          email?: string | null
          hubspot_id?: string | null
          id?: string
          notes?: string | null
          partner_name: string
          partner_type?: Database["public"]["Enums"]["partner_type"] | null
          phone?: string | null
          secondary_email?: string | null
          service_area?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          airtable_id?: string | null
          commission_structure?: string | null
          company?: string | null
          country?: string | null
          created_at?: string | null
          email?: string | null
          hubspot_id?: string | null
          id?: string
          notes?: string | null
          partner_name?: string
          partner_type?: Database["public"]["Enums"]["partner_type"] | null
          phone?: string | null
          secondary_email?: string | null
          service_area?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      payment_items: {
        Row: {
          amount: number
          created_at: string
          description: string
          id: string
          payment_id: string
          quantity: number
          sort_order: number
          unit_price: number
        }
        Insert: {
          amount: number
          created_at?: string
          description: string
          id?: string
          payment_id: string
          quantity?: number
          sort_order?: number
          unit_price: number
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string
          id?: string
          payment_id?: string
          quantity?: number
          sort_order?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "payment_items_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_items_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "v_overdue_payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_links: {
        Row: {
          account_id: string
          amount: number | null
          created_at: string | null
          currency: string | null
          gateway: string
          id: string
          is_default: boolean | null
          label: string
          url: string
        }
        Insert: {
          account_id: string
          amount?: number | null
          created_at?: string | null
          currency?: string | null
          gateway: string
          id?: string
          is_default?: boolean | null
          label: string
          url: string
        }
        Update: {
          account_id?: string
          amount?: number | null
          created_at?: string | null
          currency?: string | null
          gateway?: string
          id?: string
          is_default?: boolean | null
          label?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "payment_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      payments: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          amount: number
          amount_currency: Database["public"]["Enums"]["currency"] | null
          amount_due: number | null
          amount_paid: number | null
          bank_preference: string | null
          billing_entity_id: string | null
          contact_id: string | null
          created_at: string | null
          credit_for_payment_id: string | null
          deal_id: string | null
          delay_approved_until: string | null
          description: string | null
          discount: number | null
          due_date: string | null
          evidence_type: string | null
          followup_stage: string | null
          hubspot_id: string | null
          id: string
          installment: string | null
          invoice_date: string | null
          invoice_number: string | null
          invoice_status: string | null
          is_test: boolean | null
          issue_date: string | null
          last_reminder_at: string | null
          late_fee_amount: number | null
          message: string | null
          notes: string | null
          paid_by_name: string | null
          paid_date: string | null
          payment_method: string | null
          payment_record: string | null
          penalty_disclaimer_signed: boolean | null
          period: Database["public"]["Enums"]["payment_period"] | null
          portal_invoice_id: string | null
          qb_invoice_id: string | null
          qb_sync_error: string | null
          qb_sync_status: string | null
          referral_partner_id: string | null
          reminder_1_sent: string | null
          reminder_2_sent: string | null
          reminder_count: number | null
          restricted_date: string | null
          sent_at: string | null
          sent_to: string | null
          status: Database["public"]["Enums"]["payment_status"] | null
          stripe_payment_id: string | null
          subtotal: number | null
          total: number | null
          updated_at: string | null
          warning_sent: string | null
          whop_payment_id: string | null
          year: number | null
        }
        Insert: {
          account_id?: string | null
          airtable_id?: string | null
          amount: number
          amount_currency?: Database["public"]["Enums"]["currency"] | null
          amount_due?: number | null
          amount_paid?: number | null
          bank_preference?: string | null
          billing_entity_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          credit_for_payment_id?: string | null
          deal_id?: string | null
          delay_approved_until?: string | null
          description?: string | null
          discount?: number | null
          due_date?: string | null
          evidence_type?: string | null
          followup_stage?: string | null
          hubspot_id?: string | null
          id?: string
          installment?: string | null
          invoice_date?: string | null
          invoice_number?: string | null
          invoice_status?: string | null
          is_test?: boolean | null
          issue_date?: string | null
          last_reminder_at?: string | null
          late_fee_amount?: number | null
          message?: string | null
          notes?: string | null
          paid_by_name?: string | null
          paid_date?: string | null
          payment_method?: string | null
          payment_record?: string | null
          penalty_disclaimer_signed?: boolean | null
          period?: Database["public"]["Enums"]["payment_period"] | null
          portal_invoice_id?: string | null
          qb_invoice_id?: string | null
          qb_sync_error?: string | null
          qb_sync_status?: string | null
          referral_partner_id?: string | null
          reminder_1_sent?: string | null
          reminder_2_sent?: string | null
          reminder_count?: number | null
          restricted_date?: string | null
          sent_at?: string | null
          sent_to?: string | null
          status?: Database["public"]["Enums"]["payment_status"] | null
          stripe_payment_id?: string | null
          subtotal?: number | null
          total?: number | null
          updated_at?: string | null
          warning_sent?: string | null
          whop_payment_id?: string | null
          year?: number | null
        }
        Update: {
          account_id?: string | null
          airtable_id?: string | null
          amount?: number
          amount_currency?: Database["public"]["Enums"]["currency"] | null
          amount_due?: number | null
          amount_paid?: number | null
          bank_preference?: string | null
          billing_entity_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          credit_for_payment_id?: string | null
          deal_id?: string | null
          delay_approved_until?: string | null
          description?: string | null
          discount?: number | null
          due_date?: string | null
          evidence_type?: string | null
          followup_stage?: string | null
          hubspot_id?: string | null
          id?: string
          installment?: string | null
          invoice_date?: string | null
          invoice_number?: string | null
          invoice_status?: string | null
          is_test?: boolean | null
          issue_date?: string | null
          last_reminder_at?: string | null
          late_fee_amount?: number | null
          message?: string | null
          notes?: string | null
          paid_by_name?: string | null
          paid_date?: string | null
          payment_method?: string | null
          payment_record?: string | null
          penalty_disclaimer_signed?: boolean | null
          period?: Database["public"]["Enums"]["payment_period"] | null
          portal_invoice_id?: string | null
          qb_invoice_id?: string | null
          qb_sync_error?: string | null
          qb_sync_status?: string | null
          referral_partner_id?: string | null
          reminder_1_sent?: string | null
          reminder_2_sent?: string | null
          reminder_count?: number | null
          restricted_date?: string | null
          sent_at?: string | null
          sent_to?: string | null
          status?: Database["public"]["Enums"]["payment_status"] | null
          stripe_payment_id?: string | null
          subtotal?: number | null
          total?: number | null
          updated_at?: string | null
          warning_sent?: string | null
          whop_payment_id?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_payments_credit_for"
            columns: ["credit_for_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_payments_credit_for"
            columns: ["credit_for_payment_id"]
            isOneToOne: false
            referencedRelation: "v_overdue_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_payments_referral_partner"
            columns: ["referral_partner_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_payments_referral_partner"
            columns: ["referral_partner_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "payments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "payments_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_activations: {
        Row: {
          activated_at: string | null
          amount: number | null
          client_email: string
          client_name: string
          confirmation_mode: string | null
          created_at: string | null
          currency: string | null
          id: string
          lead_id: string | null
          notes: string | null
          offer_token: string
          payment_confirmed_at: string | null
          payment_method: string | null
          portal_invoice_id: string | null
          prepared_steps: Json | null
          qb_invoice_id: string | null
          qb_transaction_ref: string | null
          resolved_context: Json | null
          signed_at: string | null
          status: string | null
          updated_at: string | null
          version: number
          whop_membership_id: string | null
        }
        Insert: {
          activated_at?: string | null
          amount?: number | null
          client_email: string
          client_name: string
          confirmation_mode?: string | null
          created_at?: string | null
          currency?: string | null
          id?: string
          lead_id?: string | null
          notes?: string | null
          offer_token: string
          payment_confirmed_at?: string | null
          payment_method?: string | null
          portal_invoice_id?: string | null
          prepared_steps?: Json | null
          qb_invoice_id?: string | null
          qb_transaction_ref?: string | null
          resolved_context?: Json | null
          signed_at?: string | null
          status?: string | null
          updated_at?: string | null
          version?: number
          whop_membership_id?: string | null
        }
        Update: {
          activated_at?: string | null
          amount?: number | null
          client_email?: string
          client_name?: string
          confirmation_mode?: string | null
          created_at?: string | null
          currency?: string | null
          id?: string
          lead_id?: string | null
          notes?: string | null
          offer_token?: string
          payment_confirmed_at?: string | null
          payment_method?: string | null
          portal_invoice_id?: string | null
          prepared_steps?: Json | null
          qb_invoice_id?: string | null
          qb_transaction_ref?: string | null
          resolved_context?: Json | null
          signed_at?: string | null
          status?: string | null
          updated_at?: string | null
          version?: number
          whop_membership_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pending_activations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_stages: {
        Row: {
          auto_actions: Json | null
          auto_advance: boolean | null
          auto_tasks: Json | null
          client_description: string | null
          created_at: string | null
          id: string
          requires_approval: boolean | null
          service_type: string
          sla_days: number | null
          stage_description: string | null
          stage_name: string
          stage_order: number
        }
        Insert: {
          auto_actions?: Json | null
          auto_advance?: boolean | null
          auto_tasks?: Json | null
          client_description?: string | null
          created_at?: string | null
          id?: string
          requires_approval?: boolean | null
          service_type: string
          sla_days?: number | null
          stage_description?: string | null
          stage_name: string
          stage_order: number
        }
        Update: {
          auto_actions?: Json | null
          auto_advance?: boolean | null
          auto_tasks?: Json | null
          client_description?: string | null
          created_at?: string | null
          id?: string
          requires_approval?: boolean | null
          service_type?: string
          sla_days?: number | null
          stage_description?: string | null
          stage_name?: string
          stage_order?: number
        }
        Relationships: []
      }
      plaid_connections: {
        Row: {
          access_token: string
          accounts: Json | null
          bank_name: string
          created_at: string | null
          id: string
          institution_id: string | null
          institution_name: string | null
          item_id: string
          last_synced_at: string | null
          status: string | null
          sync_cursor: string | null
          updated_at: string | null
        }
        Insert: {
          access_token: string
          accounts?: Json | null
          bank_name: string
          created_at?: string | null
          id?: string
          institution_id?: string | null
          institution_name?: string | null
          item_id: string
          last_synced_at?: string | null
          status?: string | null
          sync_cursor?: string | null
          updated_at?: string | null
        }
        Update: {
          access_token?: string
          accounts?: Json | null
          bank_name?: string
          created_at?: string | null
          id?: string
          institution_id?: string | null
          institution_name?: string | null
          item_id?: string
          last_synced_at?: string | null
          status?: string | null
          sync_cursor?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      portal_audit_log: {
        Row: {
          account_id: string | null
          action: string
          created_at: string | null
          detail: string | null
          id: string
          ip_address: string | null
          user_id: string
        }
        Insert: {
          account_id?: string | null
          action: string
          created_at?: string | null
          detail?: string | null
          id?: string
          ip_address?: string | null
          user_id: string
        }
        Update: {
          account_id?: string | null
          action?: string
          created_at?: string | null
          detail?: string | null
          id?: string
          ip_address?: string | null
          user_id?: string
        }
        Relationships: []
      }
      portal_issues: {
        Row: {
          account_id: string | null
          area: string
          client_notified: boolean | null
          contact_id: string | null
          created_at: string | null
          error_context: Json | null
          error_message: string | null
          id: string
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string | null
          user_email: string | null
        }
        Insert: {
          account_id?: string | null
          area?: string
          client_notified?: boolean | null
          contact_id?: string | null
          created_at?: string | null
          error_context?: Json | null
          error_message?: string | null
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string | null
          user_email?: string | null
        }
        Update: {
          account_id?: string | null
          area?: string
          client_notified?: boolean | null
          contact_id?: string | null
          created_at?: string | null
          error_context?: Json | null
          error_message?: string | null
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string | null
          user_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portal_issues_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_issues_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_issues_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "portal_issues_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "portal_issues_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_issues_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      portal_messages: {
        Row: {
          account_id: string | null
          attachment_name: string | null
          attachment_url: string | null
          contact_id: string | null
          created_at: string | null
          id: string
          message: string
          read_at: string | null
          reply_to_id: string | null
          sender_id: string
          sender_type: string
        }
        Insert: {
          account_id?: string | null
          attachment_name?: string | null
          attachment_url?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          message: string
          read_at?: string | null
          reply_to_id?: string | null
          sender_id: string
          sender_type: string
        }
        Update: {
          account_id?: string | null
          attachment_name?: string | null
          attachment_url?: string | null
          contact_id?: string | null
          created_at?: string | null
          id?: string
          message?: string
          read_at?: string | null
          reply_to_id?: string | null
          sender_id?: string
          sender_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "portal_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "portal_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "portal_messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "portal_messages_reply_to_id_fkey"
            columns: ["reply_to_id"]
            isOneToOne: false
            referencedRelation: "portal_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_notifications: {
        Row: {
          account_id: string | null
          body: string | null
          contact_id: string | null
          created_at: string | null
          email_sent_at: string | null
          id: string
          link: string | null
          read_at: string | null
          title: string
          type: string
        }
        Insert: {
          account_id?: string | null
          body?: string | null
          contact_id?: string | null
          created_at?: string | null
          email_sent_at?: string | null
          id?: string
          link?: string | null
          read_at?: string | null
          title: string
          type: string
        }
        Update: {
          account_id?: string | null
          body?: string | null
          contact_id?: string | null
          created_at?: string | null
          email_sent_at?: string | null
          id?: string
          link?: string | null
          read_at?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_portal_notifications_contact"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_portal_notifications_contact"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "portal_notifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_notifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_notifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "portal_notifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          account_id: string | null
          auth_key: string
          contact_id: string | null
          created_at: string | null
          endpoint: string
          id: string
          p256dh: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          auth_key: string
          contact_id?: string | null
          created_at?: string | null
          endpoint: string
          id?: string
          p256dh: string
          user_id: string
        }
        Update: {
          account_id?: string | null
          auth_key?: string
          contact_id?: string | null
          created_at?: string | null
          endpoint?: string
          id?: string
          p256dh?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "push_subscriptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "push_subscriptions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      qb_tokens: {
        Row: {
          access_token: string
          access_token_expires_at: string
          created_at: string | null
          created_by: string | null
          id: string
          is_active: boolean | null
          realm_id: string
          refresh_token: string
          refresh_token_expires_at: string
          scope: string | null
          token_type: string
          updated_at: string | null
        }
        Insert: {
          access_token: string
          access_token_expires_at: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          realm_id?: string
          refresh_token: string
          refresh_token_expires_at: string
          scope?: string | null
          token_type?: string
          updated_at?: string | null
        }
        Update: {
          access_token?: string
          access_token_expires_at?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          realm_id?: string
          refresh_token?: string
          refresh_token_expires_at?: string
          scope?: string | null
          token_type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      referral_payouts: {
        Row: {
          amount: number
          created_at: string | null
          currency: string | null
          id: string
          invoice_id: string | null
          is_test: boolean | null
          notes: string | null
          payment_id: string | null
          payout_type: string
          reference: string | null
          referral_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          currency?: string | null
          id?: string
          invoice_id?: string | null
          is_test?: boolean | null
          notes?: string | null
          payment_id?: string | null
          payout_type: string
          reference?: string | null
          referral_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          currency?: string | null
          id?: string
          invoice_id?: string | null
          is_test?: boolean | null
          notes?: string | null
          payment_id?: string | null
          payout_type?: string
          reference?: string | null
          referral_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_payouts_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "client_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_payouts_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_payouts_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "v_overdue_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_payouts_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      referrals: {
        Row: {
          commission_amount: number | null
          commission_currency: string | null
          commission_pct: number | null
          commission_type: string | null
          created_at: string | null
          credited_amount: number | null
          id: string
          is_test: boolean | null
          notes: string | null
          offer_token: string | null
          paid_amount: number | null
          referred_account_id: string | null
          referred_contact_id: string | null
          referred_lead_id: string | null
          referred_name: string
          referrer_account_id: string | null
          referrer_contact_id: string | null
          referrer_type: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          commission_amount?: number | null
          commission_currency?: string | null
          commission_pct?: number | null
          commission_type?: string | null
          created_at?: string | null
          credited_amount?: number | null
          id?: string
          is_test?: boolean | null
          notes?: string | null
          offer_token?: string | null
          paid_amount?: number | null
          referred_account_id?: string | null
          referred_contact_id?: string | null
          referred_lead_id?: string | null
          referred_name: string
          referrer_account_id?: string | null
          referrer_contact_id?: string | null
          referrer_type?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          commission_amount?: number | null
          commission_currency?: string | null
          commission_pct?: number | null
          commission_type?: string | null
          created_at?: string | null
          credited_amount?: number | null
          id?: string
          is_test?: boolean | null
          notes?: string | null
          offer_token?: string | null
          paid_amount?: number | null
          referred_account_id?: string | null
          referred_contact_id?: string | null
          referred_lead_id?: string | null
          referred_name?: string
          referrer_account_id?: string | null
          referrer_contact_id?: string | null
          referrer_type?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "referrals_referred_account_id_fkey"
            columns: ["referred_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referred_account_id_fkey"
            columns: ["referred_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referred_account_id_fkey"
            columns: ["referred_account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "referrals_referred_account_id_fkey"
            columns: ["referred_account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "referrals_referred_contact_id_fkey"
            columns: ["referred_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referred_contact_id_fkey"
            columns: ["referred_contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "referrals_referred_lead_id_fkey"
            columns: ["referred_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "referrals_referrer_account_id_fkey"
            columns: ["referrer_account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "referrals_referrer_contact_id_fkey"
            columns: ["referrer_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_contact_id_fkey"
            columns: ["referrer_contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      service_catalog: {
        Row: {
          active: boolean | null
          category: string
          contract_type: string | null
          created_at: string | null
          default_currency: string | null
          default_price: number | null
          description: string | null
          has_annual: boolean
          id: string
          name: string
          pipeline: string | null
          slug: string | null
          sort_order: number | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          category?: string
          contract_type?: string | null
          created_at?: string | null
          default_currency?: string | null
          default_price?: number | null
          description?: string | null
          has_annual?: boolean
          id?: string
          name: string
          pipeline?: string | null
          slug?: string | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          category?: string
          contract_type?: string | null
          created_at?: string | null
          default_currency?: string | null
          default_price?: number | null
          description?: string | null
          has_annual?: boolean
          id?: string
          name?: string
          pipeline?: string | null
          slug?: string | null
          sort_order?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      service_deliveries: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          amount: number | null
          amount_currency: string | null
          assigned_to: string | null
          billing_type: string | null
          contact_id: string | null
          created_at: string | null
          current_step: number | null
          deal_id: string | null
          due_date: string | null
          end_date: string | null
          gdrive_folder_url: string | null
          hubspot_id: string | null
          id: string
          is_test: boolean | null
          notes: string | null
          pipeline: string | null
          service_name: string
          service_type: string
          stage: string | null
          stage_entered_at: string | null
          stage_history: Json | null
          stage_order: number | null
          start_date: string | null
          status: string | null
          total_steps: number | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          airtable_id?: string | null
          amount?: number | null
          amount_currency?: string | null
          assigned_to?: string | null
          billing_type?: string | null
          contact_id?: string | null
          created_at?: string | null
          current_step?: number | null
          deal_id?: string | null
          due_date?: string | null
          end_date?: string | null
          gdrive_folder_url?: string | null
          hubspot_id?: string | null
          id?: string
          is_test?: boolean | null
          notes?: string | null
          pipeline?: string | null
          service_name: string
          service_type: string
          stage?: string | null
          stage_entered_at?: string | null
          stage_history?: Json | null
          stage_order?: number | null
          start_date?: string | null
          status?: string | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          airtable_id?: string | null
          amount?: number | null
          amount_currency?: string | null
          assigned_to?: string | null
          billing_type?: string | null
          contact_id?: string | null
          created_at?: string | null
          current_step?: number | null
          deal_id?: string | null
          due_date?: string | null
          end_date?: string | null
          gdrive_folder_url?: string | null
          hubspot_id?: string | null
          id?: string
          is_test?: boolean | null
          notes?: string | null
          pipeline?: string | null
          service_name?: string
          service_type?: string
          stage?: string | null
          stage_entered_at?: string | null
          stage_history?: Json | null
          stage_order?: number | null
          start_date?: string | null
          status?: string | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_deliveries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_deliveries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_deliveries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "service_deliveries_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "service_deliveries_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_deliveries_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "service_deliveries_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          amount: number | null
          amount_currency: Database["public"]["Enums"]["currency"] | null
          billing_type: Database["public"]["Enums"]["billing_type"] | null
          blocked_reason: string | null
          blocked_since: string | null
          blocked_waiting_external: boolean | null
          contact_id: string | null
          created_at: string | null
          current_step: number | null
          deal_id: string | null
          end_date: string | null
          hubspot_id: string | null
          id: string
          notes: string | null
          qc_verified: boolean | null
          service_name: string
          service_type: Database["public"]["Enums"]["service_type"]
          sla_due_date: string | null
          stage_entered_at: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["service_status"] | null
          total_steps: number | null
          updated_at: string | null
        }
        Insert: {
          account_id?: string | null
          airtable_id?: string | null
          amount?: number | null
          amount_currency?: Database["public"]["Enums"]["currency"] | null
          billing_type?: Database["public"]["Enums"]["billing_type"] | null
          blocked_reason?: string | null
          blocked_since?: string | null
          blocked_waiting_external?: boolean | null
          contact_id?: string | null
          created_at?: string | null
          current_step?: number | null
          deal_id?: string | null
          end_date?: string | null
          hubspot_id?: string | null
          id?: string
          notes?: string | null
          qc_verified?: boolean | null
          service_name: string
          service_type: Database["public"]["Enums"]["service_type"]
          sla_due_date?: string | null
          stage_entered_at?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["service_status"] | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string | null
          airtable_id?: string | null
          amount?: number | null
          amount_currency?: Database["public"]["Enums"]["currency"] | null
          billing_type?: Database["public"]["Enums"]["billing_type"] | null
          blocked_reason?: string | null
          blocked_since?: string | null
          blocked_waiting_external?: boolean | null
          contact_id?: string | null
          created_at?: string | null
          current_step?: number | null
          deal_id?: string | null
          end_date?: string | null
          hubspot_id?: string | null
          id?: string
          notes?: string | null
          qc_verified?: boolean | null
          service_name?: string
          service_type?: Database["public"]["Enums"]["service_type"]
          sla_due_date?: string | null
          stage_entered_at?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["service_status"] | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "services_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "services_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "services_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "services_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      session_checkpoints: {
        Row: {
          created_at: string
          id: string
          next_steps: string | null
          session_type: string
          summary: string
          tool_calls_at_save: number
        }
        Insert: {
          created_at?: string
          id?: string
          next_steps?: string | null
          session_type?: string
          summary: string
          tool_calls_at_save?: number
        }
        Update: {
          created_at?: string
          id?: string
          next_steps?: string | null
          session_type?: string
          summary?: string
          tool_calls_at_save?: number
        }
        Relationships: []
      }
      signature_requests: {
        Row: {
          access_code: string
          account_id: string | null
          contact_id: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          document_name: string
          drive_file_id: string | null
          id: string
          pdf_storage_path: string
          signature_coords: Json | null
          signature_data: Json | null
          signed_at: string | null
          signed_pdf_drive_id: string | null
          signed_pdf_path: string | null
          status: string
          token: string
          updated_at: string | null
        }
        Insert: {
          access_code?: string
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          document_name: string
          drive_file_id?: string | null
          id?: string
          pdf_storage_path: string
          signature_coords?: Json | null
          signature_data?: Json | null
          signed_at?: string | null
          signed_pdf_drive_id?: string | null
          signed_pdf_path?: string | null
          status?: string
          token: string
          updated_at?: string | null
        }
        Update: {
          access_code?: string
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          document_name?: string
          drive_file_id?: string | null
          id?: string
          pdf_storage_path?: string
          signature_coords?: Json | null
          signature_data?: Json | null
          signed_at?: string | null
          signed_pdf_drive_id?: string | null
          signed_pdf_path?: string | null
          status?: string
          token?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signature_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signature_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signature_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "signature_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "signature_requests_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signature_requests_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      sop_runbooks: {
        Row: {
          airtable_id: string | null
          content: string
          created_at: string | null
          id: string
          notes: string | null
          service_type: Database["public"]["Enums"]["service_type"] | null
          title: string
          updated_at: string | null
          version: string | null
        }
        Insert: {
          airtable_id?: string | null
          content: string
          created_at?: string | null
          id?: string
          notes?: string | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          title: string
          updated_at?: string | null
          version?: string | null
        }
        Update: {
          airtable_id?: string | null
          content?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          title?: string
          updated_at?: string | null
          version?: string | null
        }
        Relationships: []
      }
      ss4_applications: {
        Row: {
          access_code: string | null
          account_id: string | null
          company_name: string
          contact_id: string | null
          county_and_state: string | null
          created_at: string | null
          entity_type: string
          formation_date: string | null
          id: string
          language: string | null
          member_count: number
          pdf_signed_drive_id: string | null
          pdf_unsigned_drive_id: string | null
          responsible_party_itin: string | null
          responsible_party_name: string
          responsible_party_phone: string | null
          responsible_party_title: string
          signature_data: Json | null
          signed_at: string | null
          signed_ip: string | null
          state_of_formation: string
          status: string
          token: string
          trade_name: string | null
          updated_at: string | null
          view_count: number | null
          viewed_at: string | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          company_name: string
          contact_id?: string | null
          county_and_state?: string | null
          created_at?: string | null
          entity_type?: string
          formation_date?: string | null
          id?: string
          language?: string | null
          member_count?: number
          pdf_signed_drive_id?: string | null
          pdf_unsigned_drive_id?: string | null
          responsible_party_itin?: string | null
          responsible_party_name: string
          responsible_party_phone?: string | null
          responsible_party_title?: string
          signature_data?: Json | null
          signed_at?: string | null
          signed_ip?: string | null
          state_of_formation: string
          status?: string
          token: string
          trade_name?: string | null
          updated_at?: string | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          company_name?: string
          contact_id?: string | null
          county_and_state?: string | null
          created_at?: string | null
          entity_type?: string
          formation_date?: string | null
          id?: string
          language?: string | null
          member_count?: number
          pdf_signed_drive_id?: string | null
          pdf_unsigned_drive_id?: string | null
          responsible_party_itin?: string | null
          responsible_party_name?: string
          responsible_party_phone?: string | null
          responsible_party_title?: string
          signature_data?: Json | null
          signed_at?: string | null
          signed_ip?: string | null
          state_of_formation?: string
          status?: string
          token?: string
          trade_name?: string | null
          updated_at?: string | null
          view_count?: number | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ss4_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ss4_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ss4_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "ss4_applications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "ss4_applications_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ss4_applications_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      system_docs: {
        Row: {
          content: string
          created_at: string | null
          doc_type: string | null
          id: string
          slug: string
          title: string
          updated_at: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          doc_type?: string | null
          id?: string
          slug: string
          title: string
          updated_at?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          doc_type?: string | null
          id?: string
          slug?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      tasks: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          assigned_to: string
          attachments: Json
          category: Database["public"]["Enums"]["task_category"] | null
          completed_date: string | null
          contact_id: string | null
          created_at: string | null
          created_by: string | null
          deal_id: string | null
          delivery_id: string | null
          description: string | null
          due_date: string | null
          hubspot_id: string | null
          id: string
          notes: string | null
          notified: boolean | null
          priority: Database["public"]["Enums"]["task_priority"] | null
          service_id: string | null
          stage_order: number | null
          status: Database["public"]["Enums"]["task_status"] | null
          task_title: string
          updated_at: string | null
          zoho_task_id: string | null
        }
        Insert: {
          account_id?: string | null
          airtable_id?: string | null
          assigned_to: string
          attachments?: Json
          category?: Database["public"]["Enums"]["task_category"] | null
          completed_date?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          deal_id?: string | null
          delivery_id?: string | null
          description?: string | null
          due_date?: string | null
          hubspot_id?: string | null
          id?: string
          notes?: string | null
          notified?: boolean | null
          priority?: Database["public"]["Enums"]["task_priority"] | null
          service_id?: string | null
          stage_order?: number | null
          status?: Database["public"]["Enums"]["task_status"] | null
          task_title: string
          updated_at?: string | null
          zoho_task_id?: string | null
        }
        Update: {
          account_id?: string | null
          airtable_id?: string | null
          assigned_to?: string
          attachments?: Json
          category?: Database["public"]["Enums"]["task_category"] | null
          completed_date?: string | null
          contact_id?: string | null
          created_at?: string | null
          created_by?: string | null
          deal_id?: string | null
          delivery_id?: string | null
          description?: string | null
          due_date?: string | null
          hubspot_id?: string | null
          id?: string
          notes?: string | null
          notified?: boolean | null
          priority?: Database["public"]["Enums"]["task_priority"] | null
          service_id?: string | null
          stage_order?: number | null
          status?: Database["public"]["Enums"]["task_status"] | null
          task_title?: string
          updated_at?: string | null
          zoho_task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tasks_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "tasks_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "service_deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "v_active_service_deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["service_id"]
          },
        ]
      }
      tax_quote_submissions: {
        Row: {
          client_email: string | null
          client_ip: string | null
          client_name: string | null
          client_phone: string | null
          client_user_agent: string | null
          completed_at: string | null
          created_at: string | null
          id: string
          language: string | null
          lead_id: string | null
          llc_name: string | null
          llc_state: string | null
          llc_type: string | null
          offer_token: string | null
          opened_at: string | null
          processed_at: string | null
          sent_at: string | null
          status: string | null
          tax_year: number | null
          token: string
          updated_at: string | null
        }
        Insert: {
          client_email?: string | null
          client_ip?: string | null
          client_name?: string | null
          client_phone?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          lead_id?: string | null
          llc_name?: string | null
          llc_state?: string | null
          llc_type?: string | null
          offer_token?: string | null
          opened_at?: string | null
          processed_at?: string | null
          sent_at?: string | null
          status?: string | null
          tax_year?: number | null
          token: string
          updated_at?: string | null
        }
        Update: {
          client_email?: string | null
          client_ip?: string | null
          client_name?: string | null
          client_phone?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          lead_id?: string | null
          llc_name?: string | null
          llc_state?: string | null
          llc_type?: string | null
          offer_token?: string | null
          opened_at?: string | null
          processed_at?: string | null
          sent_at?: string | null
          status?: string | null
          tax_year?: number | null
          token?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_quote_submissions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_return_submissions: {
        Row: {
          access_code: string | null
          account_id: string | null
          changed_fields: Json | null
          client_ip: string | null
          client_user_agent: string | null
          completed_at: string | null
          confirmation_accepted: boolean | null
          contact_id: string | null
          created_at: string | null
          entity_type: string
          has_articles_on_file: boolean | null
          has_ein_letter_on_file: boolean | null
          id: string
          language: string | null
          opened_at: string | null
          prefilled_data: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          sent_at: string | null
          status: string | null
          submitted_data: Json | null
          tax_return_id: string | null
          tax_year: number
          token: string
          updated_at: string | null
          upload_paths: Json | null
        }
        Insert: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          confirmation_accepted?: boolean | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string
          has_articles_on_file?: boolean | null
          has_ein_letter_on_file?: boolean | null
          id?: string
          language?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string | null
          submitted_data?: Json | null
          tax_return_id?: string | null
          tax_year?: number
          token: string
          updated_at?: string | null
          upload_paths?: Json | null
        }
        Update: {
          access_code?: string | null
          account_id?: string | null
          changed_fields?: Json | null
          client_ip?: string | null
          client_user_agent?: string | null
          completed_at?: string | null
          confirmation_accepted?: boolean | null
          contact_id?: string | null
          created_at?: string | null
          entity_type?: string
          has_articles_on_file?: boolean | null
          has_ein_letter_on_file?: boolean | null
          id?: string
          language?: string | null
          opened_at?: string | null
          prefilled_data?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sent_at?: string | null
          status?: string | null
          submitted_data?: Json | null
          tax_return_id?: string | null
          tax_year?: number
          token?: string
          updated_at?: string | null
          upload_paths?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_return_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_return_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_return_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tax_return_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tax_return_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_return_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
          {
            foreignKeyName: "tax_return_submissions_tax_return_id_fkey"
            columns: ["tax_return_id"]
            isOneToOne: false
            referencedRelation: "tax_returns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_return_submissions_tax_return_id_fkey"
            columns: ["tax_return_id"]
            isOneToOne: false
            referencedRelation: "v_tax_return_tracker"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_returns: {
        Row: {
          account_id: string
          airtable_id: string | null
          client_name: string | null
          company_name: string
          contact_id: string | null
          created_at: string | null
          data_received: boolean | null
          data_received_date: string | null
          deadline: string
          deal_created: boolean | null
          extension_confirmed_date: string | null
          extension_deadline: string | null
          extension_filed: boolean | null
          extension_requested_date: string | null
          extension_submission_id: string | null
          first_year_skip: boolean | null
          hubspot_id: string | null
          id: string
          india_follow_up_count: number | null
          india_status: Database["public"]["Enums"]["india_status"] | null
          link_sent: boolean | null
          link_sent_date: string | null
          notes: string | null
          paid: boolean | null
          return_type: Database["public"]["Enums"]["tax_return_type"]
          sent_to_india: boolean | null
          sent_to_india_date: string | null
          special_case: boolean | null
          status: Database["public"]["Enums"]["tax_return_status"] | null
          tax_year: number
          updated_at: string | null
        }
        Insert: {
          account_id: string
          airtable_id?: string | null
          client_name?: string | null
          company_name: string
          contact_id?: string | null
          created_at?: string | null
          data_received?: boolean | null
          data_received_date?: string | null
          deadline: string
          deal_created?: boolean | null
          extension_confirmed_date?: string | null
          extension_deadline?: string | null
          extension_filed?: boolean | null
          extension_requested_date?: string | null
          extension_submission_id?: string | null
          first_year_skip?: boolean | null
          hubspot_id?: string | null
          id?: string
          india_follow_up_count?: number | null
          india_status?: Database["public"]["Enums"]["india_status"] | null
          link_sent?: boolean | null
          link_sent_date?: string | null
          notes?: string | null
          paid?: boolean | null
          return_type: Database["public"]["Enums"]["tax_return_type"]
          sent_to_india?: boolean | null
          sent_to_india_date?: string | null
          special_case?: boolean | null
          status?: Database["public"]["Enums"]["tax_return_status"] | null
          tax_year: number
          updated_at?: string | null
        }
        Update: {
          account_id?: string
          airtable_id?: string | null
          client_name?: string | null
          company_name?: string
          contact_id?: string | null
          created_at?: string | null
          data_received?: boolean | null
          data_received_date?: string | null
          deadline?: string
          deal_created?: boolean | null
          extension_confirmed_date?: string | null
          extension_deadline?: string | null
          extension_filed?: boolean | null
          extension_requested_date?: string | null
          extension_submission_id?: string | null
          first_year_skip?: boolean | null
          hubspot_id?: string | null
          id?: string
          india_follow_up_count?: number | null
          india_status?: Database["public"]["Enums"]["india_status"] | null
          link_sent?: boolean | null
          link_sent_date?: string | null
          notes?: string | null
          paid?: boolean | null
          return_type?: Database["public"]["Enums"]["tax_return_type"]
          sent_to_india?: boolean | null
          sent_to_india_date?: string | null
          special_case?: boolean | null
          status?: Database["public"]["Enums"]["tax_return_status"] | null
          tax_year?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tax_returns_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_returns_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      td_bank_feeds: {
        Row: {
          amount: number
          created_at: string | null
          currency: string
          external_id: string | null
          id: string
          match_confidence: string | null
          matched_at: string | null
          matched_by: string | null
          matched_payment_id: string | null
          memo: string | null
          raw_data: Json | null
          sender_name: string | null
          sender_reference: string | null
          source: string
          status: string
          transaction_date: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          currency?: string
          external_id?: string | null
          id?: string
          match_confidence?: string | null
          matched_at?: string | null
          matched_by?: string | null
          matched_payment_id?: string | null
          memo?: string | null
          raw_data?: Json | null
          sender_name?: string | null
          sender_reference?: string | null
          source: string
          status?: string
          transaction_date: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          currency?: string
          external_id?: string | null
          id?: string
          match_confidence?: string | null
          matched_at?: string | null
          matched_by?: string | null
          matched_payment_id?: string | null
          memo?: string | null
          raw_data?: Json | null
          sender_name?: string | null
          sender_reference?: string | null
          source?: string
          status?: string
          transaction_date?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "td_bank_feeds_matched_payment_id_fkey"
            columns: ["matched_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "td_bank_feeds_matched_payment_id_fkey"
            columns: ["matched_payment_id"]
            isOneToOne: false
            referencedRelation: "v_overdue_payments"
            referencedColumns: ["id"]
          },
        ]
      }
      td_expense_items: {
        Row: {
          amount: number
          description: string
          expense_id: string
          id: string
          quantity: number | null
          sort_order: number | null
          unit_price: number | null
        }
        Insert: {
          amount?: number
          description: string
          expense_id: string
          id?: string
          quantity?: number | null
          sort_order?: number | null
          unit_price?: number | null
        }
        Update: {
          amount?: number
          description?: string
          expense_id?: string
          id?: string
          quantity?: number | null
          sort_order?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "td_expense_items_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "td_expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      td_expenses: {
        Row: {
          account_id: string | null
          attachment_name: string | null
          attachment_url: string | null
          category: string | null
          created_at: string | null
          currency: string
          description: string | null
          due_date: string | null
          id: string
          invoice_number: string | null
          issue_date: string | null
          notes: string | null
          paid_date: string | null
          payment_method: string | null
          qb_bill_id: string | null
          status: string
          subtotal: number
          tax_amount: number | null
          total: number
          updated_at: string | null
          vendor_name: string
        }
        Insert: {
          account_id?: string | null
          attachment_name?: string | null
          attachment_url?: string | null
          category?: string | null
          created_at?: string | null
          currency?: string
          description?: string | null
          due_date?: string | null
          id?: string
          invoice_number?: string | null
          issue_date?: string | null
          notes?: string | null
          paid_date?: string | null
          payment_method?: string | null
          qb_bill_id?: string | null
          status?: string
          subtotal?: number
          tax_amount?: number | null
          total?: number
          updated_at?: string | null
          vendor_name: string
        }
        Update: {
          account_id?: string | null
          attachment_name?: string | null
          attachment_url?: string | null
          category?: string | null
          created_at?: string | null
          currency?: string
          description?: string | null
          due_date?: string | null
          id?: string
          invoice_number?: string | null
          issue_date?: string | null
          notes?: string | null
          paid_date?: string | null
          payment_method?: string | null
          qb_bill_id?: string | null
          status?: string
          subtotal?: number
          tax_amount?: number | null
          total?: number
          updated_at?: string | null
          vendor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "td_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "td_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "td_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "td_expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
      templates: {
        Row: {
          airtable_id: string | null
          auto_apply: boolean | null
          category: string | null
          created_at: string | null
          id: string
          language: string | null
          notes: string | null
          placeholders: string[] | null
          service_type: Database["public"]["Enums"]["service_type"] | null
          template_name: string
          template_number: number | null
          template_text: string
          trigger_keyword: string | null
          updated_at: string | null
        }
        Insert: {
          airtable_id?: string | null
          auto_apply?: boolean | null
          category?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          notes?: string | null
          placeholders?: string[] | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          template_name: string
          template_number?: number | null
          template_text: string
          trigger_keyword?: string | null
          updated_at?: string | null
        }
        Update: {
          airtable_id?: string | null
          auto_apply?: boolean | null
          category?: string | null
          created_at?: string | null
          id?: string
          language?: string | null
          notes?: string | null
          placeholders?: string[] | null
          service_type?: Database["public"]["Enums"]["service_type"] | null
          template_name?: string
          template_number?: number | null
          template_text?: string
          trigger_keyword?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      webhook_debug: {
        Row: {
          created_at: string | null
          id: number
          payload: Json | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          payload?: Json | null
        }
        Update: {
          created_at?: string | null
          id?: number
          payload?: Json | null
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          created_at: string | null
          event_type: string
          external_id: string | null
          id: string
          payload: Json | null
          review_status: string | null
          source: string
        }
        Insert: {
          created_at?: string | null
          event_type: string
          external_id?: string | null
          id?: string
          payload?: Json | null
          review_status?: string | null
          source: string
        }
        Update: {
          created_at?: string | null
          event_type?: string
          external_id?: string | null
          id?: string
          payload?: Json | null
          review_status?: string | null
          source?: string
        }
        Relationships: []
      }
      whop_events: {
        Row: {
          amount_cents: number | null
          created_at: string | null
          currency: string | null
          customer_email: string | null
          customer_name: string | null
          event_id: string | null
          event_type: string
          id: string
          metadata: Json | null
          processed: boolean | null
          status: string | null
          updated_at: string | null
          whop_membership_id: string | null
          whop_payment_id: string | null
          whop_plan_id: string | null
          whop_product_id: string | null
          whop_user_id: string | null
        }
        Insert: {
          amount_cents?: number | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          event_id?: string | null
          event_type: string
          id?: string
          metadata?: Json | null
          processed?: boolean | null
          status?: string | null
          updated_at?: string | null
          whop_membership_id?: string | null
          whop_payment_id?: string | null
          whop_plan_id?: string | null
          whop_product_id?: string | null
          whop_user_id?: string | null
        }
        Update: {
          amount_cents?: number | null
          created_at?: string | null
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          event_id?: string | null
          event_type?: string
          id?: string
          metadata?: Json | null
          processed?: boolean | null
          status?: string | null
          updated_at?: string | null
          whop_membership_id?: string | null
          whop_payment_id?: string | null
          whop_plan_id?: string | null
          whop_product_id?: string | null
          whop_user_id?: string | null
        }
        Relationships: []
      }
      wizard_progress: {
        Row: {
          account_id: string | null
          contact_id: string | null
          created_at: string | null
          current_step: number | null
          data: Json | null
          id: string
          status: string | null
          updated_at: string | null
          wizard_type: string
        }
        Insert: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          current_step?: number | null
          data?: Json | null
          id?: string
          status?: string | null
          updated_at?: string | null
          wizard_type: string
        }
        Update: {
          account_id?: string | null
          contact_id?: string | null
          created_at?: string | null
          current_step?: number | null
          data?: Json | null
          id?: string
          status?: string | null
          updated_at?: string | null
          wizard_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "wizard_progress_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wizard_progress_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wizard_progress_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "wizard_progress_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "wizard_progress_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wizard_progress_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["contact_id"]
          },
        ]
      }
      work_locks: {
        Row: {
          claimed_at: string
          created_at: string
          file_path: string
          id: string
          locked_by: string
          reason: string
          released_at: string | null
        }
        Insert: {
          claimed_at?: string
          created_at?: string
          file_path: string
          id?: string
          locked_by: string
          reason: string
          released_at?: string | null
        }
        Update: {
          claimed_at?: string
          created_at?: string
          file_path?: string
          id?: string
          locked_by?: string
          reason?: string
          released_at?: string | null
        }
        Relationships: []
      }
      write_buffer: {
        Row: {
          action: string
          created_at: string | null
          error_message: string | null
          id: string
          payload: Json
          retry_count: number | null
          status: string | null
          synced_at: string | null
          target_record_id: string | null
          target_table: string
        }
        Insert: {
          action: string
          created_at?: string | null
          error_message?: string | null
          id?: string
          payload: Json
          retry_count?: number | null
          status?: string | null
          synced_at?: string | null
          target_record_id?: string | null
          target_table: string
        }
        Update: {
          action?: string
          created_at?: string | null
          error_message?: string | null
          id?: string
          payload?: Json
          retry_count?: number | null
          status?: string | null
          synced_at?: string | null
          target_record_id?: string | null
          target_table?: string
        }
        Relationships: []
      }
      zoho_templates: {
        Row: {
          attachment_names: string[] | null
          content: string | null
          created_at: string | null
          has_attachments: boolean | null
          id: string
          migrated_to: string | null
          module: string | null
          name: string
          notes: string | null
          status: string | null
          subject: string | null
          updated_at: string | null
          zoho_id: string
        }
        Insert: {
          attachment_names?: string[] | null
          content?: string | null
          created_at?: string | null
          has_attachments?: boolean | null
          id?: string
          migrated_to?: string | null
          module?: string | null
          name: string
          notes?: string | null
          status?: string | null
          subject?: string | null
          updated_at?: string | null
          zoho_id: string
        }
        Update: {
          attachment_names?: string[] | null
          content?: string | null
          created_at?: string | null
          has_attachments?: boolean | null
          id?: string
          migrated_to?: string | null
          module?: string | null
          name?: string
          notes?: string | null
          status?: string | null
          subject?: string | null
          updated_at?: string | null
          zoho_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      v_account_detail: {
        Row: {
          airtable_id: string | null
          business_address: string | null
          cancellation_date: string | null
          cancellation_requested: boolean | null
          company_name: string | null
          company_type: Database["public"]["Enums"]["company_type"] | null
          created_at: string | null
          deadline_count: number | null
          deal_count: number | null
          ein: string | null
          filing_id: string | null
          gdrive_folder_url: string | null
          hubspot_id: string | null
          id: string | null
          incorporation_date: string | null
          installment_1_amount: number | null
          installment_1_currency: Database["public"]["Enums"]["currency"] | null
          installment_2_amount: number | null
          installment_2_currency: Database["public"]["Enums"]["currency"] | null
          kb_folder_path: string | null
          lead_source: string | null
          notes: string | null
          payment_count: number | null
          portal_account: boolean | null
          portal_created_date: string | null
          ra_provider: string | null
          ra_renewal_date: string | null
          referral_commission_pct: number | null
          referral_status: string | null
          referred_by: string | null
          referrer: string | null
          sd_count: number | null
          services_bundle: string[] | null
          state_of_formation: string | null
          status: Database["public"]["Enums"]["account_status"] | null
          task_count: number | null
          tax_return_count: number | null
          updated_at: string | null
          zoho_account_id: string | null
        }
        Insert: {
          airtable_id?: string | null
          business_address?: string | null
          cancellation_date?: string | null
          cancellation_requested?: boolean | null
          company_name?: string | null
          company_type?: Database["public"]["Enums"]["company_type"] | null
          created_at?: string | null
          deadline_count?: never
          deal_count?: never
          ein?: string | null
          filing_id?: string | null
          gdrive_folder_url?: string | null
          hubspot_id?: string | null
          id?: string | null
          incorporation_date?: string | null
          installment_1_amount?: number | null
          installment_1_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          installment_2_amount?: number | null
          installment_2_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          kb_folder_path?: string | null
          lead_source?: string | null
          notes?: string | null
          payment_count?: never
          portal_account?: boolean | null
          portal_created_date?: string | null
          ra_provider?: string | null
          ra_renewal_date?: string | null
          referral_commission_pct?: number | null
          referral_status?: string | null
          referred_by?: string | null
          referrer?: string | null
          sd_count?: never
          services_bundle?: string[] | null
          state_of_formation?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          task_count?: never
          tax_return_count?: never
          updated_at?: string | null
          zoho_account_id?: string | null
        }
        Update: {
          airtable_id?: string | null
          business_address?: string | null
          cancellation_date?: string | null
          cancellation_requested?: boolean | null
          company_name?: string | null
          company_type?: Database["public"]["Enums"]["company_type"] | null
          created_at?: string | null
          deadline_count?: never
          deal_count?: never
          ein?: string | null
          filing_id?: string | null
          gdrive_folder_url?: string | null
          hubspot_id?: string | null
          id?: string | null
          incorporation_date?: string | null
          installment_1_amount?: number | null
          installment_1_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          installment_2_amount?: number | null
          installment_2_currency?:
            | Database["public"]["Enums"]["currency"]
            | null
          kb_folder_path?: string | null
          lead_source?: string | null
          notes?: string | null
          payment_count?: never
          portal_account?: boolean | null
          portal_created_date?: string | null
          ra_provider?: string | null
          ra_renewal_date?: string | null
          referral_commission_pct?: number | null
          referral_status?: string | null
          referred_by?: string | null
          referrer?: string | null
          sd_count?: never
          services_bundle?: string[] | null
          state_of_formation?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          task_count?: never
          tax_return_count?: never
          updated_at?: string | null
          zoho_account_id?: string | null
        }
        Relationships: []
      }
      v_active_service_deliveries: {
        Row: {
          assigned_to: string | null
          company_name: string | null
          contact_email: string | null
          contact_name: string | null
          due_date: string | null
          gdrive_folder_url: string | null
          id: string | null
          notes: string | null
          pipeline: string | null
          service_name: string | null
          service_type: string | null
          stage: string | null
          start_date: string | null
          status: string | null
        }
        Relationships: []
      }
      v_active_tasks: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          assigned_to: string | null
          category: Database["public"]["Enums"]["task_category"] | null
          company_name: string | null
          completed_date: string | null
          created_at: string | null
          created_by: string | null
          deal_id: string | null
          description: string | null
          due_date: string | null
          hubspot_id: string | null
          id: string | null
          notes: string | null
          notified: boolean | null
          priority: Database["public"]["Enums"]["task_priority"] | null
          priority_order: number | null
          service_id: string | null
          status: Database["public"]["Enums"]["task_status"] | null
          task_title: string | null
          updated_at: string | null
          zoho_task_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tasks_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["service_id"]
          },
        ]
      }
      v_client_full: {
        Row: {
          account_gdrive_folder: string | null
          account_id: string | null
          account_status: Database["public"]["Enums"]["account_status"] | null
          citizenship: string | null
          company_name: string | null
          company_type: Database["public"]["Enums"]["company_type"] | null
          contact_gdrive_folder: string | null
          contact_id: string | null
          ein: string | null
          email: string | null
          full_name: string | null
          incorporation_date: string | null
          installment_1_amount: number | null
          installment_2_amount: number | null
          itin_number: string | null
          kyc_status: string | null
          language: string | null
          phone: string | null
          portal_account: boolean | null
          preferred_channel:
            | Database["public"]["Enums"]["conversation_channel"]
            | null
          ra_renewal_date: string | null
          residency: string | null
          services_bundle: string[] | null
          state_of_formation: string | null
        }
        Relationships: []
      }
      v_client_timeline: {
        Row: {
          account_id: string | null
          channel: string | null
          contact_id: string | null
          direction: string | null
          event_date: string | null
          event_type: string | null
          id: string | null
          source: string | null
          summary: string | null
          title: string | null
        }
        Relationships: []
      }
      v_messaging_inbox: {
        Row: {
          account_name: string | null
          channel_name: string | null
          contact_name: string | null
          group_id: string | null
          group_name: string | null
          group_type: string | null
          last_message_at: string | null
          last_message_preview: string | null
          last_message_sender: string | null
          platform: string | null
          unread_count: number | null
        }
        Relationships: []
      }
      v_new_messages: {
        Row: {
          account_name: string | null
          ai_draft: string | null
          channel_name: string | null
          contact_name: string | null
          content_text: string | null
          content_type: string | null
          created_at: string | null
          external_group_id: string | null
          group_name: string | null
          group_type: string | null
          message_id: string | null
          platform: string | null
          sender_name: string | null
          sender_phone: string | null
          status: string | null
        }
        Relationships: []
      }
      v_overdue_payments: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          amount: number | null
          amount_currency: Database["public"]["Enums"]["currency"] | null
          company_name: string | null
          contact_email: string | null
          contact_name: string | null
          created_at: string | null
          days_overdue: number | null
          deal_id: string | null
          description: string | null
          due_date: string | null
          hubspot_id: string | null
          id: string | null
          invoice_number: string | null
          late_fee_amount: number | null
          notes: string | null
          paid_date: string | null
          payment_method: string | null
          penalty_disclaimer_signed: boolean | null
          period: Database["public"]["Enums"]["payment_period"] | null
          reminder_1_sent: string | null
          reminder_2_sent: string | null
          restricted_date: string | null
          status: Database["public"]["Enums"]["payment_status"] | null
          updated_at: string | null
          warning_sent: string | null
          year: number | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "payments_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
        ]
      }
      v_pipeline_summary: {
        Row: {
          avg_value: number | null
          deal_count: number | null
          pipeline: string | null
          stage: Database["public"]["Enums"]["deal_stage"] | null
          total_value: number | null
        }
        Relationships: []
      }
      v_sd_pipeline_summary: {
        Row: {
          active_count: number | null
          completed_count: number | null
          pipeline: string | null
          sd_count: number | null
          stage: string | null
        }
        Relationships: []
      }
      v_sla_monitor: {
        Row: {
          account_id: string | null
          blocked_waiting_external: boolean | null
          company_name: string | null
          days_remaining: number | null
          service_id: string | null
          service_type: Database["public"]["Enums"]["service_type"] | null
          sla_due_date: string | null
          sla_status: string | null
          stage_entered_at: string | null
          status: Database["public"]["Enums"]["service_status"] | null
        }
        Relationships: []
      }
      v_sla_summary: {
        Row: {
          service_types: Database["public"]["Enums"]["service_type"][] | null
          sla_status: string | null
          total: number | null
        }
        Relationships: []
      }
      v_tax_return_tracker: {
        Row: {
          account_id: string | null
          airtable_id: string | null
          calculated_deadline: string | null
          client_name: string | null
          company_name: string | null
          company_type: Database["public"]["Enums"]["company_type"] | null
          created_at: string | null
          data_received: boolean | null
          data_received_date: string | null
          days_remaining: number | null
          deadline: string | null
          deal_created: boolean | null
          extension_deadline: string | null
          extension_filed: boolean | null
          hubspot_id: string | null
          id: string | null
          india_status: Database["public"]["Enums"]["india_status"] | null
          link_sent: boolean | null
          link_sent_date: string | null
          notes: string | null
          paid: boolean | null
          return_type: Database["public"]["Enums"]["tax_return_type"] | null
          sent_to_india: boolean | null
          sent_to_india_date: string | null
          special_case: boolean | null
          status: Database["public"]["Enums"]["tax_return_status"] | null
          tax_year: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_detail"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_client_full"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "tax_returns_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_sla_monitor"
            referencedColumns: ["account_id"]
          },
        ]
      }
    }
    Functions: {
      calculate_client_health: {
        Args: never
        Returns: {
          account_id: string
          communication_health: string
          health: string
          payment_health: string
          service_health: string
        }[]
      }
      claim_next_job: {
        Args: never
        Returns: {
          account_id: string | null
          attempts: number
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          job_type: string
          lead_id: string | null
          max_attempts: number
          payload: Json
          priority: number
          related_entity_id: string | null
          related_entity_type: string | null
          result: Json | null
          started_at: string | null
          status: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      exec_sql: { Args: { sql_query: string }; Returns: Json }
      get_client_account_ids: { Args: never; Returns: string[] }
      get_client_contact_id: { Args: never; Returns: string }
      get_portal_chat_threads: {
        Args: never
        Returns: {
          account_id: string
          company_name: string
          contact_id: string
          contact_name: string
          last_message: string
          last_message_at: string
          unread_count: number
        }[]
      }
      increment_email_open: {
        Args: { p_tracking_id: string }
        Returns: undefined
      }
      increment_message_count: { Args: { sid: string }; Returns: undefined }
      increment_oa_signed_count: { Args: { oa_uuid: string }; Returns: number }
      increment_tool_counter: { Args: never; Returns: Json }
      match_embeddings: {
        Args: {
          match_count?: number
          match_threshold?: number
          query_embedding: string
        }
        Returns: {
          chunk_index: number
          chunk_text: string
          created_at: string
          id: string
          session_id: string
          similarity: number
        }[]
      }
      match_facts: {
        Args: {
          match_count?: number
          match_threshold?: number
          match_user_id: string
          query_embedding: string
        }
        Returns: {
          category: string
          content: string
          created_at: string
          id: string
          reasoning: string
          similarity: number
          source_session_id: string
          status: string
          user_id: string
        }[]
      }
      onboarding_phase1: {
        Args: {
          p_account: Json
          p_contact: Json
          p_existing_account_id?: string
          p_existing_contact_id?: string
        }
        Returns: Json
      }
      reset_tool_counter: { Args: never; Returns: undefined }
      update_client_health: { Args: never; Returns: number }
    }
    Enums: {
      account_status:
        | "Active"
        | "Pending Formation"
        | "Delinquent"
        | "Suspended"
        | "Offboarding"
        | "Cancelled"
        | "Closed"
      billing_type: "Included" | "Standalone"
      company_type: "Single Member LLC" | "Multi Member LLC" | "C-Corp Elected"
      conversation_channel:
        | "WhatsApp"
        | "Telegram"
        | "Email"
        | "Phone"
        | "Portal"
        | "In-Person"
        | "Calendly"
        | "Zoom"
      conversation_status: "New" | "Proposed" | "Approved" | "Sent" | "Archived"
      currency: "USD" | "EUR"
      deal_stage:
        | "Initial Consultation"
        | "Offer Sent"
        | "Negotiation"
        | "Agreement Signed"
        | "Paid"
        | "Closed Won"
        | "Closed Lost"
      dev_task_priority: "critical" | "high" | "medium" | "low"
      dev_task_status:
        | "backlog"
        | "todo"
        | "in_progress"
        | "blocked"
        | "done"
        | "cancelled"
      dev_task_type:
        | "feature"
        | "bugfix"
        | "refactor"
        | "cleanup"
        | "docs"
        | "infra"
      email_queue_status: "Draft" | "Queued" | "Sent" | "Failed" | "Cancelled"
      india_status:
        | "Not Sent"
        | "Sent - Pending"
        | "In Progress"
        | "Completed"
        | "Filed"
      interaction_type:
        | "Email Inbound"
        | "Email Outbound"
        | "WhatsApp Inbound"
        | "WhatsApp Outbound"
        | "Telegram Inbound"
        | "Telegram Outbound"
        | "Phone Call"
        | "Portal Message"
        | "Meeting"
        | "Note"
      lead_status:
        | "New"
        | "Call Scheduled"
        | "Call Done"
        | "Offer Sent"
        | "Negotiating"
        | "Paid"
        | "Converted"
        | "Lost"
        | "Suspended"
      offer_status:
        | "Sent"
        | "Accepted"
        | "Rejected"
        | "Expired"
        | "Negotiating"
        | "Draft"
        | "Viewed"
      partner_type:
        | "Reseller"
        | "Referral"
        | "Affiliate"
        | "Service Partner"
        | "RA Provider"
        | "Banking Partner"
        | "External Partner"
      payment_period: "January" | "June" | "One-Time" | "Custom"
      payment_status:
        | "Pending"
        | "Paid"
        | "Overdue"
        | "Delinquent"
        | "Waived"
        | "Refunded"
        | "Not Invoiced"
        | "Cancelled"
      service_status:
        | "Not Started"
        | "In Progress"
        | "Waiting Client"
        | "Waiting Third Party"
        | "Completed"
        | "Cancelled"
      service_type:
        | "Company Formation"
        | "Client Onboarding"
        | "Tax Return"
        | "State RA Renewal"
        | "CMRA"
        | "Shipping"
        | "Public Notary"
        | "Banking Fintech"
        | "Banking Physical"
        | "ITIN"
        | "Company Closure"
        | "Client Offboarding"
        | "State Annual Report"
        | "EIN Application"
        | "Support"
      sync_direction: "to_hubspot" | "from_hubspot" | "bidirectional"
      task_category:
        | "Client Response"
        | "Document"
        | "Filing"
        | "Follow-up"
        | "Payment"
        | "CRM Update"
        | "Internal"
        | "KYC"
        | "Shipping"
        | "Notarization"
        | "Client Communication"
        | "Formation"
      task_priority: "Urgent" | "High" | "Normal" | "Low"
      task_status: "To Do" | "In Progress" | "Waiting" | "Done" | "Cancelled"
      tax_return_status:
        | "Payment Pending"
        | "Link Sent - Awaiting Data"
        | "Data Received"
        | "Sent to India"
        | "Extension Filed"
        | "TR Completed - Awaiting Signature"
        | "TR Filed"
        | "Paid - Not Started"
        | "Activated - Need Link"
        | "Not Invoiced"
        | "Extension Requested"
      tax_return_type: "SMLLC" | "MMLLC" | "Corp" | "LSE"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_status: [
        "Active",
        "Pending Formation",
        "Delinquent",
        "Suspended",
        "Offboarding",
        "Cancelled",
        "Closed",
      ],
      billing_type: ["Included", "Standalone"],
      company_type: ["Single Member LLC", "Multi Member LLC", "C-Corp Elected"],
      conversation_channel: [
        "WhatsApp",
        "Telegram",
        "Email",
        "Phone",
        "Portal",
        "In-Person",
        "Calendly",
        "Zoom",
      ],
      conversation_status: ["New", "Proposed", "Approved", "Sent", "Archived"],
      currency: ["USD", "EUR"],
      deal_stage: [
        "Initial Consultation",
        "Offer Sent",
        "Negotiation",
        "Agreement Signed",
        "Paid",
        "Closed Won",
        "Closed Lost",
      ],
      dev_task_priority: ["critical", "high", "medium", "low"],
      dev_task_status: [
        "backlog",
        "todo",
        "in_progress",
        "blocked",
        "done",
        "cancelled",
      ],
      dev_task_type: [
        "feature",
        "bugfix",
        "refactor",
        "cleanup",
        "docs",
        "infra",
      ],
      email_queue_status: ["Draft", "Queued", "Sent", "Failed", "Cancelled"],
      india_status: [
        "Not Sent",
        "Sent - Pending",
        "In Progress",
        "Completed",
        "Filed",
      ],
      interaction_type: [
        "Email Inbound",
        "Email Outbound",
        "WhatsApp Inbound",
        "WhatsApp Outbound",
        "Telegram Inbound",
        "Telegram Outbound",
        "Phone Call",
        "Portal Message",
        "Meeting",
        "Note",
      ],
      lead_status: [
        "New",
        "Call Scheduled",
        "Call Done",
        "Offer Sent",
        "Negotiating",
        "Paid",
        "Converted",
        "Lost",
        "Suspended",
      ],
      offer_status: [
        "Sent",
        "Accepted",
        "Rejected",
        "Expired",
        "Negotiating",
        "Draft",
        "Viewed",
      ],
      partner_type: [
        "Reseller",
        "Referral",
        "Affiliate",
        "Service Partner",
        "RA Provider",
        "Banking Partner",
        "External Partner",
      ],
      payment_period: ["January", "June", "One-Time", "Custom"],
      payment_status: [
        "Pending",
        "Paid",
        "Overdue",
        "Delinquent",
        "Waived",
        "Refunded",
        "Not Invoiced",
        "Cancelled",
      ],
      service_status: [
        "Not Started",
        "In Progress",
        "Waiting Client",
        "Waiting Third Party",
        "Completed",
        "Cancelled",
      ],
      service_type: [
        "Company Formation",
        "Client Onboarding",
        "Tax Return",
        "State RA Renewal",
        "CMRA",
        "Shipping",
        "Public Notary",
        "Banking Fintech",
        "Banking Physical",
        "ITIN",
        "Company Closure",
        "Client Offboarding",
        "State Annual Report",
        "EIN Application",
        "Support",
      ],
      sync_direction: ["to_hubspot", "from_hubspot", "bidirectional"],
      task_category: [
        "Client Response",
        "Document",
        "Filing",
        "Follow-up",
        "Payment",
        "CRM Update",
        "Internal",
        "KYC",
        "Shipping",
        "Notarization",
        "Client Communication",
        "Formation",
      ],
      task_priority: ["Urgent", "High", "Normal", "Low"],
      task_status: ["To Do", "In Progress", "Waiting", "Done", "Cancelled"],
      tax_return_status: [
        "Payment Pending",
        "Link Sent - Awaiting Data",
        "Data Received",
        "Sent to India",
        "Extension Filed",
        "TR Completed - Awaiting Signature",
        "TR Filed",
        "Paid - Not Started",
        "Activated - Need Link",
        "Not Invoiced",
        "Extension Requested",
      ],
      tax_return_type: ["SMLLC", "MMLLC", "Corp", "LSE"],
    },
  },
} as const
