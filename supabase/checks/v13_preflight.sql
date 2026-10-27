-- Read-only metadata and invariants. Never invokes reset, queues or sends.
BEGIN READ ONLY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261026001000') THEN RAISE EXCEPTION 'MIGRATION_010_REQUIRED'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version>='20261027001100') OR to_regclass('pos.whatsapp_settings') IS NOT NULL OR to_regclass('pos.inventory_purchases') IS NOT NULL THEN RAISE EXCEPTION 'V13_ALREADY_PRESENT_REVIEW_HISTORY'; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND (rolsuper OR rolcanlogin OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN RAISE EXCEPTION 'UNSAFE_OWNER'; END IF;
 IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'RESIDUAL_CREATE'; END IF;
 IF EXISTS(SELECT FROM pos.inventory_balances WHERE quantity<0) THEN RAISE EXCEPTION 'NEGATIVE_STOCK'; END IF;
END $$;
SELECT 'V13_PREFLIGHT_PASS' AS result;
SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user;
ROLLBACK;
