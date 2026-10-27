-- Read-only reset-fix metadata audit. Never invokes reset.preview/reset.confirm.
BEGIN READ ONLY;
DO $$ DECLARE role_name text; BEGIN
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261027001300') THEN RAISE EXCEPTION 'MISSING_RESET_FIX_HISTORY';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='pos.purge_operation(jsonb,uuid)'::regprocedure AND proowner='pos_owner'::regrole AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, pos, pg_temp'] AND md5(replace(prosrc,chr(13),''))='8ecc63f925e19d4150807b79b4d7f125') THEN RAISE EXCEPTION 'RESET_FIX_FUNCTION_MISMATCH';END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role','pos_app','pos_scheduler'] LOOP
  IF has_function_privilege(role_name,'pos.purge_operation(jsonb,uuid)','EXECUTE') THEN RAISE EXCEPTION 'UNSAFE_RESET_HELPER_ACCESS';END IF;
 END LOOP;
 IF has_schema_privilege('pos_owner','pos','CREATE') THEN RAISE EXCEPTION 'RESIDUAL_CREATE';END IF;
 IF NOT EXISTS(SELECT FROM pg_db_role_setting WHERE setrole='authenticator'::regrole AND array_to_string(setconfig,',') LIKE '%safeupdate%') THEN RAISE EXCEPTION 'SAFEUPDATE_CONFIG_MISSING';END IF;
END $$;
SELECT 'RESET_FIX_INTEGRITY_PASS' result;
ROLLBACK;
