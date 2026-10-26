import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {createRequire} from 'node:module';
// Reuse the approved backup toolchain, without adding frontend dependencies.
const pg=createRequire(path.resolve('.cache/automation/package.json'))('pg');

const dir = process.env.CAI_BACKUP_DIRECTORY;
if (!dir || !path.resolve(dir).startsWith('E:\\CAI_Market_Backups\\')) throw new Error('BACKUP_PATH_REJECTED');
const state = JSON.parse(fs.readFileSync(path.join(dir, 'session.dpapi.json'), 'utf8').replace(/^\uFEFF/, ''));
if (state.project !== 'sauoekefntzxhqxycdgo' || Date.parse(state.expiresAt) <= Date.now() + 20_000) throw new Error('CREDENTIAL_SCOPE_OR_EXPIRY');
const ca = fs.readFileSync(path.join(dir, 'prod-ca-2021.crt'));
if (new crypto.X509Certificate(ca).fingerprint256.replaceAll(':', '') !== '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA') throw new Error('CA_PIN');
const client = new pg.Client({ host: 'aws-0-us-east-2.pooler.supabase.com', port: 5432,
  database: 'postgres', user: state.role + '.' + state.project, password: process.env.PGPASSWORD,
  ssl: { ca, rejectUnauthorized: true, servername: 'aws-0-us-east-2.pooler.supabase.com' },
  connectionTimeoutMillis: 15000, application_name: 'cai_authorized_backup_read_only' });
const q = s => '"' + s.replaceAll('"', '""') + '"';
let phase = 'snapshot_connect';
const redact = s => String(s).replaceAll(process.env.PGPASSWORD || '\0', '[REDACTED]').replace(/sbp_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]');
function runTool(label, command, args, remote = true) {
  phase = label;
  const docker = ['run', '--rm'];
  if (remote) for (const name of ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGCONNECT_TIMEOUT']) docker.push('--env', name);
  docker.push('--mount', `type=bind,source=${dir},target=/backup`, state.image, command, ...args);
  const result = spawnSync('docker', docker, { env: process.env, encoding: null, timeout: 120_000, maxBuffer: 20_000_000 });
  fs.writeFileSync(path.join(dir, label + '.stdout.log'), result.stdout || Buffer.alloc(0));
  fs.writeFileSync(path.join(dir, label + '.stderr.log'), redact(result.stderr || ''));
  if (result.error || result.status !== 0) throw Object.assign(new Error('BACKUP_TOOL_FAILED'), { code: 'LOCAL_TOOL_EXIT_' + result.status });
}
try {
  for (const name of ['database.dump','roles.sql','schema.sql','history_data.sql','source-state.json']) if (fs.existsSync(path.join(dir,name))) throw new Error('REFUSE_OVERWRITE');
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('SET LOCAL ROLE postgres');
  await client.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL extra_float_digits=3; SET LOCAL statement_timeout='60s'");
  const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const context = (await client.query(`SELECT current_user AS effective_role,current_database() AS database,
    current_setting('transaction_read_only') AS read_only,current_setting('server_version') AS version,
    pg_database_size(current_database())::text AS bytes`)).rows[0];
  if (context.effective_role !== 'postgres' || context.read_only !== 'on') throw new Error('READ_ONLY_CONTEXT_NOT_ESTABLISHED');
  const backendTransport=(await client.query('SELECT ssl,version,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  // pg_stat_ssl describes the server-to-pooler hop, not this client's TLS socket.
  // Never accept an insecure client connection merely because a backend uses TLS.
  const socket=client.connection.stream;
  if(socket.encrypted!==true||socket.authorized!==true)throw new Error('AUTHENTICATED_TLS_REQUIRED');
  const transport={ssl:true,version:socket.getProtocol(),certificateAndHostnameVerified:true,backendHopSsl:backendTransport?.ssl??null};
  fs.writeFileSync(path.join(dir,'authenticated-tls.json'),JSON.stringify({project:state.project,...transport,certificateAndHostnameVerified:true,caPinned:true,mode:'verify-full',readOnly:true},null,2));
  const history = (await client.query('SELECT version::text FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(r=>r.version);
  const tables = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname`)).rows;
  phase = 'snapshot_table_hashes';
  for (const table of tables) {
    const relation = q(table.schema)+'.'+q(table.name);
    table.hashSql = `SELECT count(*)::text AS rows,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text) COLLATE "C"),'')) AS digest FROM (SELECT ${table.columns.map(q).join(',')} FROM ONLY ${relation}) t`;
    Object.assign(table, (await client.query(table.hashSql)).rows[0]);
  }
  const catalogQueries = {
    roles: `SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolvaliduntil::text,rolconfig FROM pg_roles ORDER BY rolname`,
    memberships: `SELECT r.rolname AS role,mr.rolname AS member,g.rolname AS grantor,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles mr ON mr.oid=m.member JOIN pg_roles g ON g.oid=m.grantor ORDER BY 1,2,3`,
    schemaPermissions: `SELECT n.nspname AS name,pg_get_userbyid(n.nspowner) AS owner,n.nspacl::text AS explicit_acl,EXISTS(SELECT FROM pg_init_privs i WHERE i.classoid='pg_namespace'::regclass AND i.objoid=n.oid AND i.initprivs=n.nspacl AND i.privtype='e') AS matches_managed_initial,coalesce((SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a),'[]'::jsonb) AS grants FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname`,
    relationPermissions: `SELECT n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','S') ORDER BY 1,2`,
    functionPermissions: `SELECT n.nspname AS schema,p.oid::regprocedure::text AS signature,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prokind IN ('f','p') ORDER BY 1,2`,
    policies: `SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies ORDER BY 1,2,3`,
    defaultPermissions: `SELECT pg_get_userbyid(defaclrole) AS owner,defaclnamespace::regnamespace::text AS schema,defaclobjtype,defaclacl::text AS acl FROM pg_default_acl ORDER BY 1,2,3`,
    schemas: `SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY nspname`,
    functions: `SELECT n.nspname AS schema,p.oid::regprocedure::text AS signature,pg_get_userbyid(p.proowner) AS owner,p.prosecdef AS security_definer,p.proconfig AS settings,md5(pg_get_functiondef(p.oid)) AS definition_digest FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prokind IN ('f','p') ORDER BY n.nspname,p.oid::regprocedure::text`,
    constraints: `SELECT n.nspname AS schema,c.relname AS relation,k.conname AS name,k.contype AS type,k.convalidated AS validated,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname,k.conname`,
    indexes: `SELECT n.nspname AS schema,c.relname AS relation,x.relname AS name,i.indisvalid AS valid,i.indisready AS ready,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname,x.relname`,
    triggers: `SELECT n.nspname AS schema,c.relname AS relation,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`,
    sequences: `SELECT schemaname AS schema,sequencename AS name,sequenceowner AS owner,last_value::text FROM pg_sequences WHERE schemaname NOT LIKE 'pg_%' ORDER BY schemaname,sequencename`,
    financial: `SELECT id::text,authorized_limit::text,outstanding::text,available::text FROM pos.credit_account_balances ORDER BY id`,
    stock: `SELECT product_id::text,quantity FROM pos.inventory_balances ORDER BY product_id`,
    ledgerTotals: `SELECT 'sales' AS ledger,count(*)::text AS rows,coalesce(sum(total),0)::text AS amount FROM pos.sales UNION ALL SELECT 'payments',count(*)::text,coalesce(sum(amount),0)::text FROM pos.payments UNION ALL SELECT 'credit_charges',count(*)::text,coalesce(sum(principal),0)::text FROM pos.credit_charges UNION ALL SELECT 'credit_receipts',count(*)::text,coalesce(sum(amount),0)::text FROM pos.credit_receipts UNION ALL SELECT 'cash_entries',count(*)::text,coalesce(sum(amount),0)::text FROM pos.cash_entries ORDER BY ledger`,
  };
  const catalog = {};
  for (const [name,sql] of Object.entries(catalogQueries)) {
    phase = 'catalog_' + name;
    const financial = ['financial','stock','ledgerTotals'].includes(name);
    if (financial) await client.query('SET LOCAL ROLE pos_owner');
    catalog[name] = (await client.query(sql)).rows;
    if (financial) await client.query('SET LOCAL ROLE postgres');
  }
  if(JSON.stringify(history)!==JSON.stringify(Array.from({length:8},(_,i)=>'20261023000'+(i+1)+'00')))throw new Error('SOURCE_HISTORY_NOT_001_008');
  fs.writeFileSync(path.join(dir,'source-state.json'),JSON.stringify({project:state.project,capturedAt:new Date().toISOString(),context,transport,history,tables,catalog,catalogQueries},null,2));
  runTool('roles_dump','pg_dumpall',['--roles-only','--no-role-passwords','--role=postgres','--no-password','--file=/backup/roles.sql']);
  runTool('database_dump','pg_dump',['--format=custom','--role=postgres','--no-password','--snapshot='+snapshot,'--lock-wait-timeout=10s','--file=/backup/database.dump']);
  await client.query('COMMIT');
  await client.end();
  runTool('schema_extract','pg_restore',['--schema-only','--file=/backup/schema.sql','/backup/database.dump'],false);
  runTool('history_extract','pg_restore',['--data-only','--schema=supabase_migrations','--file=/backup/history_data.sql','/backup/database.dump'],false);
  runTool('history_schema_extract','pg_restore',['--schema-only','--schema=supabase_migrations','--file=/backup/history_schema.sql','/backup/database.dump'],false);
  runTool('archive_list','pg_restore',['--list','/backup/database.dump'],false);
  fs.copyFileSync(path.join(dir,'archive_list.stdout.log'),path.join(dir,'archive.list'));
  runTool('data_extract','pg_restore',['--data-only','--file=/backup/data.sql','/backup/database.dump'],false);
  const files=['database.dump','roles.sql','schema.sql','data.sql','history_data.sql','history_schema.sql','source-state.json','authenticated-tls.json','archive.list','prod-ca-2021.crt'].map(name=>{const data=fs.readFileSync(path.join(dir,name));return{name,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({project:state.project,status:'EXPORTED_NOT_YET_RESTORED',capturedAt:new Date().toISOString(),image:state.image,sharedSnapshot:true,rolePasswordsIncluded:false,files},null,2));
  console.log(JSON.stringify({phase:'export',result:'PASS',backupDirectory:dir,tables:tables.length,files:files.map(({name,bytes})=>({name,bytes})),restorationVerified:false}));
} catch(error) {
  fs.writeFileSync(path.join(dir,'export-failure.json'),JSON.stringify({phase,code:error.code||'LOCAL_ERROR',message:redact(error.message),time:new Date().toISOString()},null,2));
  try { await client.query('ROLLBACK'); } catch {} try { await client.end(); } catch {}
  console.log(JSON.stringify({phase,result:'FAIL',code:error.code||'LOCAL_ERROR',diagnosticsPreserved:true}));process.exitCode=1;
} finally { delete process.env.PGPASSWORD; }
