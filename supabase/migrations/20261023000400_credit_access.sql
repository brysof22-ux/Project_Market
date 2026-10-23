BEGIN;
-- Keep the schema owned by the trusted migration administrator. Transferring
-- schema ownership would require CREATE on the hosted database for pos_owner.
-- Object ownership only requires temporary CREATE on the containing schema.
GRANT USAGE, CREATE ON SCHEMA pos TO pos_owner;
REVOKE ALL ON SCHEMA pos FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA pos TO pos_app, pos_scheduler, authenticated;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'pos' LOOP
    EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('ALTER TABLE pos.%I OWNER TO pos_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'pos' LOOP
    EXECUTE format('ALTER VIEW pos.%I OWNER TO pos_owner', r.viewname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pos' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO pos_owner', r.signature);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA pos FROM pos_owner;
SET LOCAL ROLE pos_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA pos FROM PUBLIC, anon, authenticated, service_role, pos_app, pos_scheduler;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pos FROM PUBLIC, anon, authenticated, service_role, pos_app, pos_scheduler;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pos FROM PUBLIC, anon, authenticated, service_role, pos_app, pos_scheduler;

GRANT EXECUTE ON FUNCTION pos.authorize_credit_limit(uuid,uuid,numeric,text,text),
  pos.confirm_sale(uuid,uuid,uuid,jsonb,jsonb,boolean,text),
  pos.record_credit_receipt(uuid,uuid,uuid,numeric,uuid,text,text),
  pos.get_credit_account(uuid,uuid), pos.list_credits(uuid,uuid,text,date,date,integer,integer),
  pos.credit_summary(uuid,date), pos.set_whatsapp_contact(uuid,uuid,text),
  pos.get_credit_history(uuid,uuid,integer,integer),
  pos.record_communication_consent(uuid,uuid,text,boolean,text,text) TO pos_app, authenticated;
-- Financial calls use PostgREST with the original Supabase user JWT. Configure
-- `pos` as an exposed API schema explicitly. No table, helper or scheduler grants
-- are given to authenticated. require_staff binds p_actor to that verified JWT.

GRANT EXECUTE ON FUNCTION pos.enqueue_credit_reminders(timestamptz),
  pos.preflight_credit_reminder(uuid,timestamptz),
  pos.record_reminder_delivery(text,text,text,text,timestamptz),
  pos.claim_credit_reminder(timestamptz), pos.finish_credit_reminder(uuid,text,text,text,timestamptz)
  TO pos_scheduler;
-- verify_whatsapp_contact intentionally has no application/scheduler grant.
-- Provision its trusted verification service separately after designing proof of ownership.
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner IN SCHEMA pos REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner IN SCHEMA pos REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
