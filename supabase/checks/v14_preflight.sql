-- Read-only metadata and invariants. Never invokes reset, queues or sends.
BEGIN READ ONLY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261027001100') THEN RAISE EXCEPTION 'MIGRATION_011_REQUIRED'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version>='20261027001200') OR EXISTS(SELECT FROM pg_attribute WHERE attrelid='pos.cash_adjustments'::regclass AND attname='method' AND NOT attisdropped) THEN RAISE EXCEPTION 'V14_ALREADY_PRESENT_REVIEW_HISTORY'; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND (rolsuper OR rolcanlogin OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN RAISE EXCEPTION 'UNSAFE_OWNER'; END IF;
 IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'RESIDUAL_CREATE'; END IF;
 IF EXISTS(SELECT FROM pos.inventory_balances WHERE quantity<0) THEN RAISE EXCEPTION 'NEGATIVE_STOCK'; END IF;
END $$;
SELECT 'V14_PREFLIGHT_PASS' AS result;
SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user;
ROLLBACK;
