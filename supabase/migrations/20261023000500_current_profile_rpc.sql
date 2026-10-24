-- Corrected after the reported failed production attempt; never reapply if recorded.
-- The four already-applied migrations remain unchanged.
-- Prepared only. Apply remotely only after review and explicit authorization.
BEGIN;

DO $$ DECLARE v_applied boolean; BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT FROM supabase_migrations.schema_migrations WHERE version = $1)'
      INTO v_applied USING '20261023000500';
    IF v_applied THEN RAISE EXCEPTION 'MIGRATION_005_ALREADY_RECORDED'; END IF;
  END IF;
  IF EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='public' AND p.proname='cai_current_profile')
       OR (n.nspname='pos' AND p.proname='current_profile_auth_uid')) THEN
    RAISE EXCEPTION 'REVIEW_EXISTING_PROFILE_RPC_OR_HELPER';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_owner'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'REVIEW_UNSAFE_POS_OWNER';
  END IF;
  IF has_schema_privilege('pos_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'REVIEW_POS_OWNER_PUBLIC_CREATE_PRIVILEGE';
  END IF;
  IF has_schema_privilege('pos_owner', 'pos', 'CREATE') THEN
    RAISE EXCEPTION 'REVIEW_POS_OWNER_POS_CREATE_PRIVILEGE';
  END IF;
  IF NOT has_schema_privilege(current_user, 'auth', 'USAGE')
    OR NOT has_function_privilege(current_user, 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATOR_REQUIRES_AUTH_UID_ACCESS';
  END IF;
END $$;
-- Hosted postgres has auth USAGE, but cannot delegate it. Keep this tiny bridge
-- owned by the migration administrator (normally postgres), never pos_owner.
-- pos remains private and its CREATE privilege is NOT given to pos_owner.
CREATE FUNCTION pos.current_profile_auth_uid()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT auth.uid() $$;
REVOKE ALL ON FUNCTION pos.current_profile_auth_uid() FROM PUBLIC, anon,
  authenticated, service_role, pos_app, pos_scheduler;
GRANT EXECUTE ON FUNCTION pos.current_profile_auth_uid() TO pos_owner;

-- PostgreSQL requires CREATE on the containing schema for ownership transfer.
-- The precondition above guarantees this temporary grant can be safely revoked.
GRANT USAGE, CREATE ON SCHEMA public TO pos_owner;
CREATE FUNCTION public.cai_current_profile()
RETURNS TABLE (id uuid, display_name text, role text, active boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_uid uuid; v_claims jsonb;
BEGIN
  -- Custom GUCs alone are forgeable over a raw SQL connection. Only accept
  -- the Auth-verified PostgREST gateway context; same boundary as require_staff.
  IF session_user <> 'authenticator' THEN
    RAISE EXCEPTION 'UNTRUSTED_AUTH_CONTEXT' USING ERRCODE = '42501';
  END IF;
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_uid := pos.current_profile_auth_uid();
  IF v_uid IS NULL OR (v_claims->>'role') IS DISTINCT FROM 'authenticated'
    OR (v_claims->>'sub') IS DISTINCT FROM v_uid::text
    OR coalesce((v_claims->>'exp')::numeric, 0) <= extract(epoch FROM statement_timestamp()) THEN
    RAISE EXCEPTION 'INVALID_AUTH_CONTEXT' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT p.id, p.display_name, p.role, p.active
    FROM pos.profiles AS p WHERE p.id = v_uid AND p.active;
END $$;
ALTER FUNCTION public.cai_current_profile() OWNER TO pos_owner;
REVOKE CREATE ON SCHEMA public FROM pos_owner;

SET LOCAL ROLE pos_owner;
REVOKE ALL ON FUNCTION public.cai_current_profile() FROM PUBLIC, anon, authenticated,
  service_role, pos_app, pos_scheduler;
GRANT EXECUTE ON FUNCTION public.cai_current_profile() TO authenticated;
-- No table grants, financial function changes, role mutations or pos exposure.
NOTIFY pgrst, 'reload schema';
COMMIT;
