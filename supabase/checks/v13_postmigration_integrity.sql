-- READ ONLY. Run after 011 and its exact migration-history registration.
-- Checks all operating periods without invoking any commercial RPC.
-- SET LOCAL changes session context only and is undone by ROLLBACK.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='3s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261026001000') THEN RAISE EXCEPTION 'MISSING_V12_HISTORY'; END IF;
 IF NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261027001100') THEN RAISE EXCEPTION 'MISSING_V13_HISTORY'; END IF;
END $$;
DO $$ DECLARE v text; r text; t text; n integer; BEGIN
  IF current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'READ_ONLY_REQUIRED'; END IF;
  FOREACH v IN ARRAY ARRAY['20261023000100','20261023000200','20261023000300','20261023000400',
    '20261023000500','20261023000600','20261023000700','20261023000800','20261025000900'] LOOP
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version::text=$1' INTO n USING v;
    IF n<>1 THEN RAISE EXCEPTION 'MISSING_HISTORY_%',v; END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS(SELECT FROM pg_auth_members WHERE member='pos_owner'::regrole) THEN RAISE EXCEPTION 'UNSAFE_POS_OWNER'; END IF;
  IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'RESIDUAL_CREATE'; END IF;
  IF EXISTS(SELECT FROM pg_tables WHERE schemaname='pos' AND (tableowner<>'pos_owner' OR NOT rowsecurity)) THEN RAISE EXCEPTION 'UNSAFE_TABLE_OWNER_OR_RLS'; END IF;
  IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace CROSS JOIN pg_roles r
    WHERE s.nspname='pos' AND c.relkind IN ('r','p','v') AND r.rolname IN ('anon','authenticated','service_role','pos_app','pos_scheduler')
      AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) THEN RAISE EXCEPTION 'UNSAFE_DIRECT_TABLE_ACCESS'; END IF;
  FOREACH v IN ARRAY ARRAY['public.cai_catalog(text,jsonb,text)','public.cai_operations(text,jsonb,text)','public.cai_report(jsonb)'] LOOP
    IF NOT EXISTS(SELECT FROM pg_proc WHERE oid=to_regprocedure(v) AND proowner='pos_owner'::regrole AND prosecdef
      AND proconfig @> ARRAY['search_path=pg_catalog, pos, pg_temp']) THEN RAISE EXCEPTION 'UNSAFE_PUBLIC_RPC_%',v; END IF;
    IF NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'MISSING_AUTHENTICATED_EXECUTE_%',v; END IF;
    FOREACH r IN ARRAY ARRAY['anon','service_role','pos_app','pos_scheduler'] LOOP
      IF has_function_privilege(r,v,'EXECUTE') THEN RAISE EXCEPTION 'UNSAFE_RPC_EXECUTE_%',v; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace CROSS JOIN pg_roles r
    WHERE s.nspname='pos' AND p.oid<>to_regprocedure('pos.current_profile_auth_uid()')
      AND r.rolname IN ('anon','authenticated','service_role','pos_app')
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'UNSAFE_PRIVATE_FUNCTION_EXECUTE'; END IF;
  IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname IN ('pos','public') AND p.prosecdef
    AND NOT EXISTS(SELECT FROM unnest(p.proconfig) setting WHERE setting LIKE 'search_path=pg_catalog%')) THEN RAISE EXCEPTION 'UNSAFE_DEFINER_SEARCH_PATH'; END IF;
  FOREACH t IN ARRAY ARRAY['sales','sale_items','payments','inventory_movements','cash_entries','cash_sessions',
    'credit_accounts','credit_limit_authorizations','credit_charges','credit_receipts','credit_allocations','sale_returns',
    'cash_adjustments','cash_closings','inventory_adjustments','inventory_balances','credit_reminders','reminder_attempts','reminder_delivery_events'] LOOP
    IF NOT EXISTS(SELECT FROM pg_class WHERE oid=to_regclass('pos.'||t) AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'MISSING_FORCED_RLS_%',t; END IF;
    IF NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('pos.'||t) AND attname='operating_period_id' AND attnotnull AND NOT attisdropped) THEN RAISE EXCEPTION 'MISSING_PERIOD_COLUMN_%',t; END IF;
    FOREACH v IN ARRAY ARRAY['active_period_read','active_period_insert','active_period_update'] LOOP
      IF NOT EXISTS(SELECT FROM pg_policy WHERE polrelid=to_regclass('pos.'||t) AND polname=v) THEN RAISE EXCEPTION 'MISSING_PERIOD_POLICY_%_%',t,v; END IF;
    END LOOP;
    IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid=to_regclass('pos.'||t) AND tgname='v11_period_links' AND tgenabled='O') THEN RAISE EXCEPTION 'MISSING_PERIOD_LINK_TRIGGER_%',t; END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_tables t WHERE schemaname='pos' AND tablename NOT IN ('operating_periods','operation_state','product_media','reset_intents','transfer_qr','transfer_qr_media','whatsapp_settings','notification_jobs','inventory_purchases')
    AND NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid=to_regclass('pos.'||t.tablename) AND tgname='v11_write_gate' AND tgenabled='O')) THEN RAISE EXCEPTION 'MISSING_WRITE_GATE'; END IF;
  IF NOT EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('pos.one_active_operating_period') AND indisunique AND indisvalid) THEN RAISE EXCEPTION 'MISSING_ACTIVE_PERIOD_UNIQUENESS'; END IF;
  IF EXISTS(SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='pos' AND (NOT i.indisvalid OR NOT i.indisready)) THEN RAISE EXCEPTION 'INVALID_INDEX'; END IF;
  IF EXISTS(SELECT FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='pos' AND NOT k.convalidated) THEN RAISE EXCEPTION 'UNVALIDATED_CONSTRAINT'; END IF;
  IF EXISTS(SELECT FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='pos' AND t.tgenabled='D') THEN RAISE EXCEPTION 'DISABLED_TRIGGER'; END IF;
END $$;
SET LOCAL ROLE pos_owner;
DO $$ DECLARE v_period uuid; v_table text; v_column text; v_target text; v_bad boolean; BEGIN
  IF (SELECT count(*) FROM pos.operation_state)<>1 OR (SELECT count(*) FROM pos.operating_periods WHERE closed_at IS NULL)<>1
    OR NOT EXISTS(SELECT FROM pos.operation_state s JOIN pos.operating_periods p ON p.id=s.period_id WHERE s.id AND p.closed_at IS NULL) THEN RAISE EXCEPTION 'INVALID_ACTIVE_PERIOD'; END IF;
  IF NOT EXISTS(SELECT FROM pos.profiles WHERE active AND role='admin') THEN RAISE EXCEPTION 'NO_ACTIVE_ADMIN'; END IF;
  FOR v_period IN SELECT id FROM pos.operating_periods ORDER BY opened_at,id LOOP
    -- Session-local archive scope exposes each period for SELECT. RLS WITH CHECK
    -- remains tied to current_period(); transaction READ ONLY forbids table writes.
    EXECUTE format('SET LOCAL cai.archive_period=%L',v_period::text);
    IF EXISTS(SELECT FROM pos.sales s WHERE s.total<>(SELECT coalesce(sum(total),0) FROM pos.sale_items WHERE sale_id=s.id)
      OR s.total<>(SELECT coalesce(sum(amount),0) FROM pos.payments WHERE sale_id=s.id)+(SELECT coalesce(sum(principal),0) FROM pos.credit_charges WHERE sale_id=s.id)) THEN RAISE EXCEPTION 'INVALID_SALE_TOTAL'; END IF;
    IF EXISTS(SELECT FROM pos.inventory_balances WHERE quantity<0) THEN RAISE EXCEPTION 'NEGATIVE_STOCK'; END IF;
    IF EXISTS(SELECT FROM pos.credit_charge_balances WHERE outstanding<0) OR EXISTS(SELECT FROM pos.credit_account_balances WHERE outstanding<0 OR available<0) THEN RAISE EXCEPTION 'INVALID_CREDIT_BALANCE'; END IF;
    IF EXISTS(SELECT FROM pos.credit_receipts r WHERE r.amount<>(SELECT coalesce(sum(amount),0) FROM pos.credit_allocations WHERE receipt_id=r.id)) THEN RAISE EXCEPTION 'INVALID_RECEIPT_ALLOCATION'; END IF;
    IF EXISTS(SELECT FROM pos.credit_allocations a JOIN pos.credit_charges c ON c.id=a.charge_id JOIN pos.credit_receipts r ON r.id=a.receipt_id WHERE a.account_id<>c.account_id OR a.account_id<>r.account_id) THEN RAISE EXCEPTION 'CROSS_ACCOUNT_ALLOCATION'; END IF;
    IF EXISTS(SELECT FROM pos.payments p JOIN pos.sales s ON s.id=p.sale_id WHERE
      (p.affects_cash_snapshot AND (SELECT count(*) FROM pos.cash_entries e WHERE e.payment_id=p.id AND e.amount=p.amount AND e.session_id=s.cash_session_id)<>1)
      OR (NOT p.affects_cash_snapshot AND EXISTS(SELECT FROM pos.cash_entries e WHERE e.payment_id=p.id))) THEN RAISE EXCEPTION 'INVALID_CASH_PAYMENT'; END IF;
    IF EXISTS(SELECT FROM pos.credit_receipts r WHERE
      (r.affects_cash_snapshot AND (SELECT count(*) FROM pos.cash_entries e WHERE e.receipt_id=r.id AND e.amount=r.amount AND e.session_id=r.cash_session_id)<>1)
      OR (NOT r.affects_cash_snapshot AND EXISTS(SELECT FROM pos.cash_entries e WHERE e.receipt_id=r.id))) THEN RAISE EXCEPTION 'INVALID_CASH_RECEIPT'; END IF;
    IF EXISTS(SELECT FROM pos.cash_entries WHERE payment_id IS NOT NULL GROUP BY payment_id HAVING count(*)>1)
      OR EXISTS(SELECT FROM pos.cash_entries WHERE receipt_id IS NOT NULL GROUP BY receipt_id HAVING count(*)>1) THEN RAISE EXCEPTION 'DUPLICATE_CASH_POSTING'; END IF;
    IF EXISTS(SELECT FROM pos.sale_returns r JOIN pos.sales s ON s.id=r.sale_id WHERE r.total<>s.total OR r.total<>r.refund_amount+r.credit_reduction) THEN RAISE EXCEPTION 'INVALID_RETURN_TOTAL'; END IF;
    IF EXISTS(SELECT FROM pos.sale_returns r JOIN pos.credit_charges c ON c.id=r.charge_id WHERE c.sale_id<>r.sale_id) THEN RAISE EXCEPTION 'INVALID_RETURN_CHARGE'; END IF;
    IF EXISTS(SELECT FROM pos.sale_returns r JOIN pos.payment_methods m ON m.id=r.refund_method_id WHERE r.refund_amount>0 AND m.affects_cash AND
      (SELECT count(*) FROM pos.cash_adjustments a WHERE a.return_id=r.id AND a.amount=-r.refund_amount AND a.session_id=r.session_id AND a.kind='refund')<>1) THEN RAISE EXCEPTION 'INVALID_REFUND_POSTING'; END IF;
    IF EXISTS(SELECT FROM pos.cash_closings c JOIN pos.cash_sessions s ON s.id=c.session_id WHERE s.closed_at IS NULL OR c.difference<>c.counted-c.expected
      OR c.expected<>s.opening_float+coalesce((SELECT sum(amount) FROM pos.cash_entries WHERE session_id=s.id),0)+coalesce((SELECT sum(amount) FROM pos.cash_adjustments WHERE session_id=s.id),0)) THEN RAISE EXCEPTION 'INVALID_CASH_CLOSING'; END IF;
    IF EXISTS(SELECT FROM pos.credit_limit_authorizations a WHERE a.scope='sale' AND NOT EXISTS(SELECT FROM pos.credit_charges c JOIN pos.sales s ON s.id=c.sale_id
      WHERE c.sale_id=a.sale_id AND c.authorization_id=a.id AND c.account_id=a.account_id AND c.principal=a.financed_amount AND s.created_by=a.authorized_by)) THEN RAISE EXCEPTION 'INVALID_SALE_FINANCING_AUTHORIZATION'; END IF;
    -- FK checks can bypass RLS. Independently reject links to another period,
    -- including relations hidden by the current archive SELECT scope.
    FOR v_table IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname='pos' AND c.relkind='r' AND EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='operating_period_id' AND NOT a.attisdropped) LOOP
      FOR v_column,v_target IN SELECT * FROM (VALUES('sale_id','sales'),('cash_session_id','cash_sessions'),('session_id','cash_sessions'),
        ('account_id','credit_accounts'),('receipt_id','credit_receipts'),('charge_id','credit_charges'),('payment_id','payments'),
        ('return_id','sale_returns'),('reminder_id','credit_reminders')) refs(col,target_table) LOOP
        IF EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('pos.'||v_table) AND attname=v_column AND NOT attisdropped) THEN
          EXECUTE format('SELECT EXISTS(SELECT FROM pos.%I source LEFT JOIN pos.%I target ON target.id=source.%I AND target.operating_period_id=source.operating_period_id WHERE source.%I IS NOT NULL AND target.id IS NULL)',v_table,v_target,v_column,v_column) INTO v_bad;
          IF v_bad THEN RAISE EXCEPTION 'CROSS_PERIOD_REFERENCE_%_%',v_table,v_column; END IF;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  SET LOCAL cai.archive_period='';
  IF EXISTS(SELECT FROM pos.products p LEFT JOIN pos.inventory_balances b ON b.product_id=p.id WHERE b.product_id IS NULL) THEN RAISE EXCEPTION 'PRODUCT_WITHOUT_ACTIVE_STOCK'; END IF;
END $$;
SELECT 'V11_POSTMIGRATION_INTEGRITY_PASS' AS result,
  (SELECT count(*) FROM pos.operating_periods) AS operating_periods,
  (SELECT count(*) FROM pos.products) AS products,
  (SELECT count(*) FROM pos.profiles) AS retained_profiles,
  (SELECT count(*) FROM pos.profiles WHERE active AND role='supervisor') AS supervisors_awaiting_reclassification;
DO $$ BEGIN
 IF (SELECT count(*) FROM pos.transfer_qr WHERE image_id IS NOT NULL)<>2 THEN RAISE EXCEPTION 'QR_NOT_CONFIGURED'; END IF;
 IF EXISTS(SELECT FROM pos.transfer_qr q JOIN pos.transfer_qr_media m ON m.image_id=q.image_id WHERE m.object_key<>'transfer-qr/'||m.image_id) THEN RAISE EXCEPTION 'INVALID_QR_KEY'; END IF;
 IF EXISTS(SELECT FROM pos.payment_methods WHERE (code='card' AND active) OR (code='transfer' AND requires_reference)) THEN RAISE EXCEPTION 'INVALID_V12_PAYMENTS'; END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid='pos.products'::regclass AND attname='purchase_price' AND format_type(atttypid,atttypmod)='numeric(24,6)') THEN
  -- numeric(24,6): do not rely on an assumed legacy column definition.
  IF NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema='pos' AND table_name='products' AND column_name='purchase_price' AND numeric_scale=6) THEN RAISE EXCEPTION 'COST_PRECISION_REQUIRED'; END IF;
 END IF;
 IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='pos.notification_jobs'::regclass AND tgname='v13_write_gate' AND tgenabled='O') THEN RAISE EXCEPTION 'QUEUE_GUARD_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='pos.inventory_purchases'::regclass AND tgname='v13_write_gate' AND tgenabled='O') THEN RAISE EXCEPTION 'PURCHASE_GUARD_REQUIRED'; END IF;
 IF has_function_privilege('anon','pos.purge_operation(jsonb,uuid)','EXECUTE') OR has_function_privilege('authenticated','pos.purge_operation(jsonb,uuid)','EXECUTE') THEN RAISE EXCEPTION 'UNSAFE_PURGE_EXECUTE'; END IF;
 IF NOT has_function_privilege('anon','public.cai_whatsapp_dispatch(text,text,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.cai_whatsapp_dispatch(text,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'UNSAFE_QUEUE_EXECUTE'; END IF;
END $$;
SELECT 'V13_INTEGRITY_PASS' AS result;
ROLLBACK;
