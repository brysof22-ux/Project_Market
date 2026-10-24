-- READ ONLY. Run with the intended migrator in the intended project BEFORE 005.
-- Does not certify historical absence of arbitrary changes; compare with 004/baseline.
BEGIN TRANSACTION READ ONLY;
SELECT current_database(), current_user, session_user,
  current_setting('server_version') AS postgres_version;
DO $$ DECLARE v_applied boolean; BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE NOTICE 'NO_MIGRATION_HISTORY_TABLE: SQL Editor/psql execution is not tracked automatically';
  ELSE
    EXECUTE 'SELECT EXISTS (SELECT FROM supabase_migrations.schema_migrations WHERE version=$1)'
      INTO v_applied USING '20261023000500';
    IF v_applied THEN RAISE EXCEPTION 'MIGRATION_005_ALREADY_RECORDED: stop and audit; do not edit/reapply'; END IF;
    RAISE NOTICE '005_NOT_RECORDED';
  END IF;
  IF EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='public' AND p.proname='cai_current_profile')
       OR (n.nspname='pos' AND p.proname='current_profile_auth_uid'))
    OR has_schema_privilege('pos_owner','public','CREATE')
    OR has_schema_privilege('pos_owner','pos','CREATE') THEN
    RAISE EXCEPTION 'REVIEW_PARTIAL_OR_EXISTING_005_STATE';
  END IF;
END $$;
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
FROM pg_roles WHERE rolname IN ('pos_owner', 'authenticator', 'authenticated', current_user);
SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_rpc,
  has_schema_privilege(current_user, 'public', 'CREATE WITH GRANT OPTION') AS can_transfer_rpc,
  has_schema_privilege(current_user, 'pos', 'CREATE') AS can_create_private_bridge,
  has_schema_privilege(current_user, 'auth', 'USAGE') AS bridge_owner_auth_usage_required,
  has_function_privilege(current_user, 'auth.uid()', 'EXECUTE') AS bridge_owner_auth_execute_required,
  has_schema_privilege(current_user, 'auth', 'USAGE WITH GRANT OPTION') AS auth_grant_option_not_required,
  has_schema_privilege('pos_owner', 'auth', 'USAGE') AS owner_auth_usage_not_required,
  has_schema_privilege('pos_owner', 'public', 'CREATE') AS owner_public_create_must_be_false,
  has_schema_privilege('pos_owner', 'pos', 'CREATE') AS owner_pos_create_must_be_false,
  pg_has_role('authenticated', 'pos_owner', 'MEMBER') AS unsafe_owner_membership;
SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl
FROM pg_namespace WHERE nspname IN ('public', 'pos', 'auth');
-- Inspect the actual managed helper, never assume its definition across versions.
SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS managed_uid_definition;
SELECT schemaname, tablename, tableowner, rowsecurity FROM pg_tables WHERE schemaname='pos';
-- Expected: pos_owner owns all existing financial tables; RLS true, as in 004.
SELECT to_regprocedure('public.cai_current_profile()') AS existing_rpc_must_be_null,
  to_regprocedure('pos.current_profile_auth_uid()') AS existing_bridge_must_be_null;
COMMIT;
-- Verify Data API exposed schemas separately: public allowed, pos excluded.
