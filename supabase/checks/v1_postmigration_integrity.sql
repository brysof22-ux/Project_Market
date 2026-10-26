-- READ ONLY: V1 (001-008) database invariants and least-privilege checks.
-- Not an Auth HTTP test or proof of the external Data API exposed schemas.
-- Does not register migrations, repair data, or create any database objects.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ DECLARE f text; r text; BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND
   (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'UNSAFE_POS_OWNER'; END IF;
 IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'RESIDUAL_CREATE'; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','pos_app','pos_scheduler') AND pg_has_role(oid,'pos_owner','MEMBER')) THEN RAISE EXCEPTION 'UNSAFE_OWNER_MEMBERSHIP'; END IF;
 IF EXISTS(SELECT FROM pg_tables WHERE schemaname='pos' AND (tableowner<>'pos_owner' OR NOT rowsecurity)) THEN RAISE EXCEPTION 'UNSAFE_TABLE_OWNER_OR_RLS'; END IF;
 IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r
   WHERE n.nspname='pos' AND c.relkind IN ('r','p','v') AND r.rolname IN ('anon','authenticated','pos_app','pos_scheduler')
   AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) THEN RAISE EXCEPTION 'UNSAFE_DIRECT_TABLE_ACCESS'; END IF;
 FOREACH f IN ARRAY ARRAY['public.cai_catalog(text,jsonb,text)','public.cai_operations(text,jsonb,text)','public.cai_report(jsonb)'] LOOP
   IF NOT EXISTS(SELECT FROM pg_proc WHERE oid=to_regprocedure(f) AND proowner='pos_owner'::regrole AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog, pos, pg_temp']) THEN RAISE EXCEPTION 'UNSAFE_V1_RPC'; END IF;
   IF NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'MISSING_AUTHENTICATED_EXECUTE'; END IF;
   FOREACH r IN ARRAY ARRAY['anon','service_role','pos_app','pos_scheduler'] LOOP
     IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'UNSAFE_V1_EXECUTE'; END IF;
   END LOOP;
 END LOOP;
 IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='pos.capture_sale_cost()'::regprocedure AND NOT prosecdef AND proowner='pos_owner'::regrole) THEN RAISE EXCEPTION 'UNSAFE_COST_TRIGGER_FUNCTION'; END IF;
 IF has_function_privilege('authenticated','pos.capture_sale_cost()','EXECUTE') OR has_function_privilege('anon','pos.capture_sale_cost()','EXECUTE') THEN RAISE EXCEPTION 'UNSAFE_TRIGGER_EXECUTE'; END IF;
 IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('pos','public') AND p.prosecdef
   AND NOT EXISTS(SELECT FROM unnest(p.proconfig) s WHERE s LIKE 'search_path=pg_catalog%')) THEN RAISE EXCEPTION 'UNSAFE_DEFINER_SEARCH_PATH'; END IF;
 IF EXISTS(SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND (NOT i.indisvalid OR NOT i.indisready)) THEN RAISE EXCEPTION 'INVALID_INDEX'; END IF;
 IF EXISTS(SELECT FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND NOT k.convalidated) THEN RAISE EXCEPTION 'UNVALIDATED_CONSTRAINT'; END IF;
 IF EXISTS(SELECT FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND t.tgenabled='D') THEN RAISE EXCEPTION 'DISABLED_TRIGGER'; END IF;
END $$;
SET LOCAL ROLE pos_owner;
DO $$ BEGIN
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
END $$;
ROLLBACK;
SELECT 'V1_POSTMIGRATION_INTEGRITY_PASS' AS result;
