// LOCAL ONLY. Restores a verified private archive into a new, network-less
// Supabase PostgreSQL container, preserves it, then rehearses 009 in a clone.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const pg = createRequire(path.resolve('.cache/automation/package.json'))('pg')
const [backupArg, workArg, verifiedRecoveryArg] = process.argv.slice(2)
const backup = path.resolve(backupArg ?? ''), work = path.resolve(workArg ?? '')
assert(backup.startsWith('E:\\CAI_Market_Backups\\') && work.startsWith('E:\\CAI_Market_Rehearsals\\'), 'PRIVATE_LOCAL_DIRECTORIES_REQUIRED')
assert(fs.existsSync(work) && fs.readdirSync(work).length === 0, 'NEW_PRIVATE_WORK_DIRECTORY_REQUIRED')
const source = JSON.parse(fs.readFileSync(path.join(backup, 'source-state.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')))
assert(source.project === 'sauoekefntzxhqxycdgo' && manifest.status === 'EXPORTED_NOT_YET_RESTORED', 'BACKUP_SCOPE_REJECTED')
const image = 'public.ecr.aws/supabase/postgres@sha256:7374d196da7e301512cc5329e18040e0f7bb856287b323777cdadecccbc6c7e4'
const suffix = path.basename(work).split('_').at(-1)
assert(/^[a-f0-9]{8}$/.test(suffix), 'WORK_SUFFIX_REQUIRED')
const recoveryProof = verifiedRecoveryArg ? JSON.parse(fs.readFileSync(path.join(path.resolve(verifiedRecoveryArg),'restoration-result.json'))) : null
if(recoveryProof) assert(recoveryProof.restorationVerified===true && recoveryProof.sourceCapturedAt===source.capturedAt && /^cai-v11-restore-[a-f0-9]{8}$/.test(recoveryProof.containers.restore), 'VERIFIED_RECOVERY_PROOF_REQUIRED')
const restore = recoveryProof?.containers.restore ?? 'cai-v11-restore-' + suffix, clone = 'cai-v11-upgrade-' + suffix
const migration = '20261025000900_v11_periods_permissions.sql'
const expectedHash = '6e7c588f6cd9bdd91f85b33cb9a90610e27d49aecfc2c544f92280b9f336d810'
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const q = value => "'" + String(value).replaceAll("'", "''") + "'"
const qi = value => '"' + value.replaceAll('"', '""') + '"'
const json = value => q(JSON.stringify(value)) + '::jsonb'
const save = (name, value) => fs.writeFileSync(path.join(work, name + '.json'), JSON.stringify(value, null, 2))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const sorted = values => [...values].sort((a,b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))))
const result = { project: source.project, sourceCapturedAt: source.capturedAt, backupHashes: false, restorationVerified: false, migrationApplied: false, migrationRegistered: false, syntheticTests: [], containers: { restore, clone }, productionModified: false }
let phase = 'verify_backup', labelSequence = 0
const running = new Set()
const maintenance = { active:false, original:[], restored:false, probes:[] }
function docker(label, args, input) {
  phase = label
  const value = spawnSync('docker', args, { encoding: 'utf8', input, windowsHide: true, timeout: 120_000, maxBuffer: 30_000_000 })
  fs.writeFileSync(path.join(work, label + '.stdout.log'), value.stdout ?? '')
  fs.writeFileSync(path.join(work, label + '.stderr.log'), value.stderr ?? '')
  assert(!value.error && value.status === 0, label + '_FAILED')
  return value.stdout.trim()
}
function sql(container, label, statement, database = 'postgres', bootstrap = false) {
  return docker(label, ['exec','-i',container,'psql','-h','/tmp','-U','supabase_admin','-d',bootstrap ? 'template1' : database,'-X','-qAt','-v','ON_ERROR_STOP=1'], statement)
}
function rows(container, label, statement, owner = 'postgres') {
  return JSON.parse(sql(container, label, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL ROLE ${qi(owner)}; SET LOCAL search_path=public; SET LOCAL TIME ZONE 'UTC'; SET LOCAL extra_float_digits=3; SELECT coalesce(json_agg(t),'[]'::json) FROM (${statement}) t; ROLLBACK;`))
}
function assertIsolated(container) {
  const configuration = JSON.parse(docker(container + '_isolation', ['inspect','--format','{{json .HostConfig}}',container]))
  assert(configuration.NetworkMode === 'none' && Object.keys(configuration.PortBindings ?? {}).length === 0, 'ISOLATION_FAILED')
}
async function ready(container) {
  for (let n=0;n<40;n++) {
    const check=spawnSync('docker',['exec',container,'pg_isready','-h','/tmp','-U','supabase_admin','-d','template1'],{windowsHide:true})
    if(check.status===0) return
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  throw new Error('LOCAL_POSTGRES_NOT_READY')
}
const normalizeAcl = (acl,owner,kind='r') => acl===null ? [`${owner}=${kind==='S'?'rwU':'arwdDxtm'}/${owner}`] : pg.types.getTypeParser(1009)(acl).sort()
function normalizeCatalog(name,value) {
  if(name==='schemaPermissions') return value.map(row=>({name:row.name,owner:row.owner,grants:sorted(row.grants)}))
  if(name==='relationPermissions') return value.map(row=>({...row,acl:normalizeAcl(row.acl,row.owner,row.kind)}))
  if(name==='functionPermissions') return value.map(row=>({...row,acl:row.acl===null ? [`=X/${row.owner}`,`${row.owner}=X/${row.owner}`].sort() : pg.types.getTypeParser(1009)(row.acl).sort()}))
  if(name==='defaultPermissions') return value.map(row=>({...row,acl:pg.types.getTypeParser(1009)(row.acl).sort()}))
  return value
}
function tableHashes(container,label) {
  return rows(container,label,source.tables.map(table=>`SELECT ${q(table.schema)} AS schema,${q(table.name)} AS name,x.* FROM (${table.hashSql}) x`).join(' UNION ALL '))
}
function compareRows(container,label,excludeHistory=false) {
  const current=tableHashes(container,label)
  const differences=source.tables.filter(table=>{
    if(excludeHistory && table.schema==='supabase_migrations' && table.name==='schema_migrations') return false
    const actual=current.find(row=>row.schema===table.schema && row.name===table.name)
    return !actual || actual.rows!==table.rows || actual.digest!==table.digest
  }).map(row=>row.schema+'.'+row.name)
  save(label,{tables:current.length,differences})
  assert.equal(differences.length,0,'ORIGINAL_ROW_DIFFERENCES_'+label)
}
function compareCatalog(container,label) {
  const comparisons={},actual={}
  for(const [name,statement] of Object.entries(source.catalogQueries)) {
    actual[name]=rows(container,label+'_'+name,statement,['financial','stock','ledgerTotals'].includes(name)?'pos_owner':'postgres')
    comparisons[name]=same(normalizeCatalog(name,source.catalog[name]),normalizeCatalog(name,actual[name]))
  }
  save(label+'_catalog',{comparisons,actual})
  const failed=Object.entries(comparisons).filter(([,pass])=>!pass).map(([name])=>name)
  assert.equal(failed.length,0,'CATALOG_DIFFERENCES_'+failed.join('_'))
  return comparisons
}
function sequenceStatements(text) { return text.replaceAll('\r','').split('\n').filter(line=>line.startsWith('SELECT pg_catalog.setval(')).sort() }
function normalizedSqlLines(text) { return text.replaceAll('\r','').split('\n').filter(line=>!line.startsWith('--')&&!line.startsWith('\\restrict')&&!line.startsWith('\\unrestrict')&&line.trim()).map(line=>line.trim()).sort() }
function managedSupplement(container) {
  const actual=rows(container,'schema_acl_before_supplement',source.catalogQueries.schemaPermissions)
  const modifications=[]
  for(const expected of source.catalog.schemaPermissions) {
    const restored=actual.find(row=>row.name===expected.name)
    assert(restored,'SCHEMA_MISSING')
    if(same(sorted(expected.grants),sorted(restored.grants))) continue
    assert(expected.matches_managed_initial && ['graphql','graphql_public'].includes(expected.name),'UNEXPECTED_SCHEMA_ACL_DIFFERENCE')
    const extras=restored.grants.filter(value=>!expected.grants.some(grant=>same(grant,value)))
    assert.equal(extras.length,0,'UNEXPECTED_EXTRA_SCHEMA_PRIVILEGE')
    for(const grant of expected.grants.filter(value=>!restored.grants.some(actual=>same(value,actual)))) {
      assert(grant.grantor===expected.owner && grant.privilege==='USAGE' && ['postgres','anon','authenticated','service_role'].includes(grant.grantee),'UNEXPECTED_MANAGED_PRIVILEGE')
      modifications.push({schema:expected.name,...grant})
    }
  }
  if(modifications.length) {
    const text='-- LOCAL RESTORE ONLY. Exactly the missing source-managed initial ACLs.\nBEGIN;\n'+modifications.map(grant=>`SET LOCAL ROLE ${qi(grant.grantor)}; GRANT ${grant.privilege} ON SCHEMA ${qi(grant.schema)} TO ${qi(grant.grantee)}${grant.grantable?' WITH GRANT OPTION':''};`).join('\n')+'\nCOMMIT;'
    fs.writeFileSync(path.join(work,'managed-initial-acls.local.sql'),text)
    sql(container,'apply_managed_initial_acls',text)
  }
  save('managed-initial-acl-adaptations',modifications)
  return modifications
}

const fakeAdmin=crypto.randomUUID(), fakeCashier=crypto.randomUUID(), fakeSupervisor=crypto.randomUUID()
function claims(actor,recent=false) { return {sub:actor,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600,...(recent?{session_id:'80000000-0000-4000-8000-000000000001',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]}:{})} }
function staff(actor,statement,recent=false,label='staff') {
  return sql(clone,label+'_'+(++labelSequence),`BEGIN; SET LOCAL SESSION AUTHORIZATION authenticator; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims=${q(JSON.stringify(claims(actor,recent)))}; ${statement} COMMIT;`)
}
function command(actor,action,body={},key=crypto.randomUUID(),section='operations',recent=false) {
  const output=staff(actor,`SELECT public.cai_${section}(${q(action)},${json(body)},${q(key)});`,recent,action.replaceAll('.','_'))
  return JSON.parse(output.split(/\r?\n/).filter(line=>line.startsWith('{')).at(-1))
}
function denied(actor,action,body,expected,section='operations',recent=false) {
  const statement=`BEGIN; SET LOCAL SESSION AUTHORIZATION authenticator; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims=${q(JSON.stringify(claims(actor,recent)))}; SELECT public.cai_${section}(${q(action)},${json(body)},${q(crypto.randomUUID())}); COMMIT;`
  const output=spawnSync('docker',['exec','-i',clone,'psql','-h','/tmp','-U','supabase_admin','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:statement,encoding:'utf8',windowsHide:true,timeout:30000})
  fs.writeFileSync(path.join(work,'expected_rejection_'+(++labelSequence)+'.stderr.log'),output.stderr??'')
  assert(output.status!==0 && output.stderr?.includes(expected),'EXPECTED_REJECTION_'+action+'_'+expected)
}
const syntheticPass=name=>result.syntheticTests.push({name,pass:true})

function maintenanceInventory() {
  return rows(clone,'maintenance_acl_inventory_'+(++labelSequence),`SELECT c.relname AS name,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,
    has_table_privilege('pos_owner',c.oid,'INSERT') AND has_table_privilege('pos_owner',c.oid,'UPDATE')
      AND has_table_privilege('pos_owner',c.oid,'DELETE') AND has_table_privilege('pos_owner',c.oid,'TRUNCATE') AS owner_dml
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND c.relkind='r' ORDER BY c.relname`)
}
function assertNoIncompatibleTransactions(label) {
  const activity=rows(clone,label,`SELECT a.pid,a.state,a.xact_start FROM pg_stat_activity a WHERE datname=current_database()
    AND pid<>pg_backend_pid() AND backend_type='client backend' AND (state<>'idle' OR xact_start IS NOT NULL)`)
  assert.equal(activity.length,0,'INCOMPATIBLE_LOCAL_TRANSACTIONS')
  const locks=rows(clone,label+'_locks',`SELECT l.pid,c.relname,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pos' AND l.pid<>pg_backend_pid()`)
  assert.equal(locks.length,0,'PERSISTENT_LOCAL_RELATION_LOCKS')
}
function cutMaintenance() {
  const initial=maintenanceInventory()
  const implicit=initial.filter(row=>row.acl===null)
  if(implicit.length) {
    for(const row of implicit) {
      const expected=source.catalog.relationPermissions.find(value=>value.schema==='pos'&&value.kind==='r'&&value.name===row.name)
      assert(expected && same(normalizeAcl(expected.acl,expected.owner),normalizeAcl(null,row.owner)),'DEFAULT_ACL_NOT_SOURCE_EQUIVALENT')
    }
    // pg_dump omits explicit owner-only defaults. Materialize precisely those
    // already-effective privileges in this CLONE so a literal ACL recovery test
    // matches production's representation. No privilege/role is added in effect.
    sql(clone,'materialize_source_owner_acls',`SET ROLE postgres; BEGIN; SET LOCAL ROLE pos_owner; GRANT ALL PRIVILEGES ON ${implicit.map(row=>'pos.'+qi(row.name)).join(',')} TO pos_owner; COMMIT;`)
    save('source-owner-acl-representation-adaptation',{cloneOnly:true,effectivePrivilegesUnchanged:true,tables:implicit.map(row=>row.name)})
  }
  maintenance.original=maintenanceInventory()
  assert.equal(maintenance.original.length,29,'EXPECTED_29_EXISTING_TABLES')
  assert(maintenance.original.every(row=>row.owner==='pos_owner' && row.owner_dml && row.acl!==null),'ORIGINAL_OWNER_ACL_REQUIRES_REVIEW')
  assert(maintenance.original.every(row=>source.catalog.relationPermissions.find(value=>value.schema==='pos'&&value.kind==='r'&&value.name===row.name)?.acl===row.acl),'SOURCE_LITERAL_OWNER_ACL_MISMATCH')
  save('maintenance_original_acl',maintenance.original)
  const refs=maintenance.original.map(row=>'pos.'+qi(row.name)).join(',')
  assertNoIncompatibleTransactions('before_maintenance_cut')
  sql(clone,'maintenance_cut',`SET ROLE postgres; BEGIN; SET LOCAL ROLE pos_owner; SET LOCAL lock_timeout='3s';
    LOCK TABLE ${refs} IN ACCESS EXCLUSIVE MODE NOWAIT;
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ${refs} FROM pos_owner;
    REVOKE SELECT ON pos.idempotency_requests FROM pos_owner; COMMIT;`)
  maintenance.active=true
  const inventory=maintenanceInventory()
  assert(inventory.every(row=>!row.owner_dml),'MAINTENANCE_DML_STILL_AVAILABLE')
  assert.equal(rows(clone,'maintenance_cache_read_closed',`SELECT has_table_privilege('pos_owner','pos.idempotency_requests','SELECT') AS available`)[0].available,false)
  assertNoIncompatibleTransactions('after_maintenance_cut')
}
function maintenanceProbe(label,v11=false) {
  const actor=crypto.randomUUID()
  const body={name:'ENSAYO bloqueo mantenimiento',sku:'ENSAYO-MAINT',price:'100',...(v11?{expected_period:'11111111-1111-4111-8111-111111111111'}:{})}
  sql(clone,label,`BEGIN; INSERT INTO auth.users(id) VALUES(${q(actor)});
    INSERT INTO pos.profiles(id,display_name,role) VALUES(${q(actor)},'ENSAYO mantenimiento','admin');
    SET LOCAL SESSION AUTHORIZATION authenticator; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claims=${q(JSON.stringify(claims(actor)))};
    DO $probe$ BEGIN
      BEGIN PERFORM public.cai_catalog('product.save',${json(body)},${q(crypto.randomUUID())});
        RAISE EXCEPTION 'WRITER_WAS_ALLOWED';
      EXCEPTION WHEN insufficient_privilege THEN
        -- SELECT FOR SHARE in require_staff needs UPDATE on profiles, so the
        -- same DML cut may reject before reaching the idempotency SELECT fence.
        IF position('idempotency_requests' IN SQLERRM)=0 AND position('profiles' IN SQLERRM)=0 THEN RAISE; END IF;
      END;
    END $probe$; ROLLBACK;`)
  maintenance.probes.push({name:label,blocked:true,syntheticIdentityRolledBack:true})
  assertNoIncompatibleTransactions(label+'_released')
}
function restoreMaintenance() {
  const refs=maintenance.original.map(row=>'pos.'+qi(row.name)).join(',')
  sql(clone,'maintenance_restore',`SET ROLE postgres; BEGIN; SET LOCAL ROLE pos_owner;
    GRANT INSERT,UPDATE,DELETE,TRUNCATE ON ${refs} TO pos_owner;
    GRANT SELECT ON pos.idempotency_requests TO pos_owner; COMMIT;`)
  const current=maintenanceInventory()
  assert(maintenance.original.every(original=>{
    const after=current.find(row=>row.name===original.name)
    return after && after.owner_dml && after.owner===original.owner && after.acl===original.acl
  }),'EXACT_MAINTENANCE_ACL_RESTORATION_FAILED')
  maintenance.active=false; maintenance.restored=true
  assertNoIncompatibleTransactions('after_maintenance_restore')
}

try {
  assert.equal(hash(fs.readFileSync(path.resolve('supabase/migrations',migration))),expectedHash,'MIGRATION_HASH_MISMATCH')
  for(const file of manifest.files) assert.equal(hash(fs.readFileSync(path.join(backup,file.name))),file.sha256,'BACKUP_HASH_MISMATCH')
  result.backupHashes=true
  if(!recoveryProof) {
  const roleText=fs.readFileSync(path.join(backup,'roles.sql'),'utf8')
  assert.equal(roleText.split('CREATE ROLE supabase_admin;').length,2,'BOOTSTRAP_ROLE_STATEMENT_CHANGED')
  fs.writeFileSync(path.join(work,'roles.local.sql'),roleText.replace('CREATE ROLE supabase_admin;','-- LOCAL ONLY: initdb already created supabase_admin as bootstrap OID 10.'))
  docker('create_restore_volume',['volume','create','--label','cai.purpose=v11-backup-verification',restore+'-data'])
  docker('restore_volume_owner',['run','--rm','--network','none','--mount',`type=volume,source=${restore}-data,target=/var/lib/postgresql/data`,'--entrypoint','chown',image,'100:101','/var/lib/postgresql/data'])
  docker('start_restore',['run','-d','--name',restore,'--label','cai.purpose=v11-backup-verification','--network','none','--user','100:101','--mount',`type=volume,source=${restore}-data,target=/var/lib/postgresql/data`,'--mount',`type=bind,source=${backup},target=/backup,readonly`,'--mount',`type=bind,source=${work},target=/work,readonly`,'--entrypoint','/bin/sh',image,'-c','set -eu; initdb -D /var/lib/postgresql/data --username=supabase_admin --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >/tmp/cai-init.log 2>&1; exec postgres -D /var/lib/postgresql/data -c listen_addresses= -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_stat_statements'])
  running.add(restore); await ready(restore); assertIsolated(restore)
  sql(restore,'restore_roles','\\i /work/roles.local.sql',undefined,true)
  sql(restore,'rename_empty_database','ALTER DATABASE postgres RENAME TO cai_bootstrap_empty;',undefined,true)
  let restoreSql=docker('extract_restore_sql',['exec',restore,'pg_restore','--create','--file=-','/backup/database.dump'])
  const extensionAdaptations=[]
  for(const extension of ['pg_stat_statements','pgcrypto','"uuid-ossp"']) {
    const statement=`CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA extensions;`
    assert.equal(restoreSql.split(statement).length,2,'EXTENSION_CREATE_STATEMENT_CHANGED')
    restoreSql=restoreSql.replace(statement,`SET SESSION AUTHORIZATION postgres;\n${statement}\nSET SESSION AUTHORIZATION supabase_admin;`)
    extensionAdaptations.push({extension,creator:'postgres',reason:'Preserve source ownership and extension initial ACLs'})
  }
  fs.writeFileSync(path.join(work,'restore.local.sql'),restoreSql)
  save('restore-adaptations',{originalFilesUnchanged:true,roleCreateOnlySkipped:'supabase_admin already bootstrap OID10',extensionAdaptations,postgresSuperuserOnlyInsideOfflineRestoration:true})
  sql(restore,'enable_local_extension_creator','ALTER ROLE postgres SUPERUSER;',undefined,true)
  try { sql(restore,'restore_complete_archive','\\i /work/restore.local.sql',undefined,true) }
  finally { sql(restore,'reset_local_extension_creator','ALTER ROLE postgres NOSUPERUSER;',undefined,true) }
  const supplement=managedSupplement(restore)
  compareRows(restore,'restored_table_hashes')
  result.restorationCatalog=compareCatalog(restore,'restored')
  const redumpedRoles=docker('restore_roles_redump',['exec',restore,'pg_dumpall','-h','/tmp','-U','supabase_admin','--roles-only','--no-role-passwords','--role=postgres'])
  assert(same(normalizedSqlLines(roleText),normalizedSqlLines(redumpedRoles)),'GLOBAL_ROLE_SQL_MISMATCH')
  const redumpedData=docker('restore_data_redump',['exec',restore,'pg_dump','-h','/tmp','-U','supabase_admin','-d','postgres','--data-only','--role=postgres'])
  assert(same(sequenceStatements(fs.readFileSync(path.join(backup,'data.sql'),'utf8')),sequenceStatements(redumpedData)),'SEQUENCE_STATE_MISMATCH')
  result.sequenceStates=sequenceStatements(redumpedData).length
  result.managedAclSupplement=supplement
  result.restorationVerified=true
  save('restoration-result',result)
  docker('stop_verified_restore',['stop',restore]); running.delete(restore)
  console.log(JSON.stringify({phase:'restore',status:'PASS',tables:source.tables.length,originalRows:source.tables.reduce((sum,table)=>sum+Number(table.rows),0),recoveryContainer:restore,recoveryStopped:true}))
  } else {
    const existingState=JSON.parse(docker('verified_recovery_stopped',['inspect','--format','{{json .State}}',restore]))
    assert(existingState.Running===false,'RECOVERY_MUST_REMAIN_STOPPED')
    assertIsolated(restore)
    result.restorationVerified=true
    result.restorationCatalog=recoveryProof.restorationCatalog
    result.sequenceStates=recoveryProof.sequenceStates
    result.managedAclSupplement=recoveryProof.managedAclSupplement
    result.recoveryProofDirectory=path.resolve(verifiedRecoveryArg)
    save('restoration-result',result)
  }

  docker('create_upgrade_volume',['volume','create','--label','cai.purpose=v11-migration-rehearsal',clone+'-data'])
  docker('clone_verified_volume',['run','--rm','--network','none','--mount',`type=volume,source=${restore}-data,target=/source,readonly`,'--mount',`type=volume,source=${clone}-data,target=/target`,'--entrypoint','/bin/sh',image,'-c','set -eu; test -z "$(ls -A /target)"; cp -a /source/. /target/'])
  docker('start_upgrade',['run','-d','--name',clone,'--label','cai.purpose=v11-migration-rehearsal','--network','none','--user','100:101','--mount',`type=volume,source=${clone}-data,target=/var/lib/postgresql/data`,'--mount',`type=bind,source=${work},target=/work,readonly`,'--entrypoint','postgres',image,'-D','/var/lib/postgresql/data','-c','listen_addresses=','-c','unix_socket_directories=/tmp','-c','shared_preload_libraries=pg_stat_statements'])
  running.add(clone); await ready(clone); assertIsolated(clone)
  compareRows(clone,'clone_before_table_hashes')
  compareCatalog(clone,'clone_before')
  sql(clone,'v11_production_preflight','SET ROLE postgres;\n'+fs.readFileSync('supabase/checks/v11_production_preflight.sql','utf8'))
  cutMaintenance()
  maintenanceProbe('maintenance_writer_blocked_before_009')
  assertNoIncompatibleTransactions('before_009_ddl')
  const migrationSql=fs.readFileSync(path.resolve('supabase/migrations',migration),'utf8')
  sql(clone,'apply_009','SET ROLE postgres;\n'+migrationSql)
  result.migrationApplied=true
  assert(!fs.readFileSync(path.join(work,'apply_009.stderr.log'),'utf8').includes('WARNING:'),'MIGRATION_WARNING_REQUIRES_REVIEW')
  maintenanceProbe('maintenance_writer_blocked_after_009',true)
  assertNoIncompatibleTransactions('after_009_ddl')
  result.migrationSha256=hash(Buffer.from(migrationSql))
  compareRows(clone,'clone_after_009_table_hashes')

  // Reuse the exact official CLI already used by this project. Copy only the
  // executable from its stopped local rehearsal; no credential configuration.
  docker('copy_approved_cli',['cp','cai-v1-rehearsal-dffc5be4:/tmp/cai-supabase',path.join(work,'supabase-cli-linux')])
  fs.mkdirSync(path.join(work,'cli-project','supabase','migrations'),{recursive:true})
  for(const name of fs.readdirSync('supabase/migrations').filter(name=>name.endsWith('.sql'))) fs.copyFileSync(path.join('supabase/migrations',name),path.join(work,'cli-project','supabase','migrations',name))
  docker('copy_cli_into_clone',['cp',path.join(work,'supabase-cli-linux'),clone+':/tmp/cai-supabase'])
  docker('copy_cli_project_into_clone',['cp',path.join(work,'cli-project'),clone+':/tmp/cai-project'])
  docker('register_009_with_official_cli',['exec',clone,'/nix/store/vr7ds8vwbl2fz7pr221d5y0f8n9a5wda-glibc-2.40-218/lib/ld-linux-x86-64.so.2','--library-path','/nix/store/vr7ds8vwbl2fz7pr221d5y0f8n9a5wda-glibc-2.40-218/lib','/tmp/cai-supabase','migration','repair','20261025000900','--status','applied','--db-url','postgresql://postgres@localhost/postgres?host=%2Ftmp&sslmode=disable','--workdir','/tmp/cai-project','--yes'])
  const history=rows(clone,'history_after_009','SELECT version,name,statements FROM supabase_migrations.schema_migrations ORDER BY version')
  assert.equal(history.length,9,'HISTORY_COUNT_MISMATCH')
  assert.equal(history.at(-1).version,'20261025000900','HISTORY_VERSION_MISMATCH')
  assert.equal(history.at(-1).name,'v11_periods_permissions','HISTORY_NAME_MISMATCH')
  assert(Array.isArray(history.at(-1).statements) && history.at(-1).statements.length>1,'CLI_HISTORY_STATEMENTS_MISSING')
  save('official-cli-history-009',history.at(-1))
  fs.writeFileSync(path.join(work,'register_20261025000900.prepared.sql'),`-- Prepared from official CLI 2.122.0 history after isolated validation.\nBEGIN;\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES(${q(history.at(-1).version)},${q(history.at(-1).name)},ARRAY[${history.at(-1).statements.map(q).join(',\n')}]);\nCOMMIT;\n`)
  result.migrationRegistered=true
  result.cliStatements=history.at(-1).statements.length
  sql(clone,'postmigration_integrity_before_fixtures','SET ROLE postgres;\n'+fs.readFileSync('supabase/checks/v11_postmigration_integrity.sql','utf8'))
  restoreMaintenance()
  result.maintenance=maintenance
  compareRows(clone,'clone_after_history_table_hashes',true)
  save('upgrade-original-data-result',result)
  console.log(JSON.stringify({phase:'009',status:'PASS',history:9,originalRowsPreserved:true,sha256:result.migrationSha256,statements:result.cliStatements}))

  // Synthetic identities only. No Auth server or external network is running.
  sql(clone,'seed_synthetic_identities',`INSERT INTO auth.users(id) VALUES(${q(fakeAdmin)}),(${q(fakeCashier)}),(${q(fakeSupervisor)}); INSERT INTO pos.profiles(id,display_name,role) VALUES(${q(fakeAdmin)},'ENSAYO V11 ADMIN','admin'),(${q(fakeCashier)},'ENSAYO V11 CAJA','cashier'),(${q(fakeSupervisor)},'ENSAYO V11 SUPERVISOR','supervisor');`)
  const period=command(fakeAdmin,'bootstrap').period_id
  const cash=rows(clone,'synthetic_cash_method',"SELECT id FROM pos.payment_methods WHERE code='cash'")[0].id
  const product=command(fakeAdmin,'product.save',{name:'ENSAYO V11 PRODUCTO',price:'100',purchase_price:'60',minimum:1,quantity:10,expected_stock:0,expected_period:period},undefined,'catalog').id
  const sessionAdmin=command(fakeAdmin,'cash.open',{opening_float:'1000',register_code:'V11ADMIN',expected_period:period}).id
  const sessionCashier=command(fakeCashier,'cash.open',{opening_float:'500',register_code:'V11CAJA',expected_period:period}).id
  const sale=(actor,session,finance,payments,key)=>command(actor,'sale.confirm',{session_id:session,finance,payments,customer_name:'ENSAYO Persona',customer_phone:'3001234567',expected_total:'100.00',lines:[{product_id:product,quantity:1}],expected_period:period},key)
  sale(fakeAdmin,sessionAdmin,false,[{method_id:cash,amount:'100'}])
  const firstCredit=sale(fakeCashier,sessionCashier,true,[{method_id:cash,amount:'25'}],'synthetic-credit-one')
  assert.equal(firstCredit.financed,'75.00')
  const receiptData={charge_id:firstCredit.charge_id,amount:'30',session_id:sessionCashier,method_id:cash,expected_period:period}
  const firstReceipt=command(fakeCashier,'debt.receipt',receiptData,'synthetic-receipt-one')
  assert(same(firstReceipt,command(fakeCashier,'debt.receipt',receiptData,'synthetic-receipt-one')))
  denied(fakeCashier,'debt.receipt',{...receiptData,amount:'999'},'AMOUNT_EXCEEDS_DEBT')
  syntheticPass('cashier_inline_credit_initial_payment_and_targeted_idempotent_receipt')
  for(const action of ['product.save','inventory.adjust','supplier.save','customer.save']) denied(fakeCashier,action,{expected_period:period},'FORBIDDEN','catalog')
  for(const action of ['cash.move','sale.return','credit.limit','users.list','user.save','settings.save','reset.preview','reset.confirm','periods.list','periods.detail']) denied(fakeCashier,action,{expected_period:period},'FORBIDDEN')
  denied(fakeSupervisor,'bootstrap',{},'ROLE_RECLASSIFICATION_REQUIRED')
  denied(fakeCashier,'cash.close',{session_id:sessionAdmin,counted:'1100',expected_period:period},'FORBIDDEN')
  syntheticPass('cashier_direct_sql_administrative_denial_supervisor_retained_own_cash_only')
  command(fakeAdmin,'sale.return',{sale_id:firstCredit.sale_id,session_id:sessionAdmin,method_id:cash,reason:'ENSAYO devolución ficticia',expected_period:period})
  const returned=command(fakeCashier,'debt.detail',{charge_id:firstCredit.charge_id})
  assert.equal(returned.outstanding,'0.00'); assert.equal(returned.refund_amount,'55.00'); assert.equal(returned.return_credit_reduction,'45.00')
  const archivedCredit=sale(fakeCashier,sessionCashier,true,[])
  const debtBefore=command(fakeCashier,'debt.detail',{charge_id:archivedCredit.charge_id})
  assert.equal(debtBefore.outstanding,'100.00')
  syntheticPass('return_preserves_receipts_and_compensates_debt_without_duplicate_payment')
  const openPreview=command(fakeAdmin,'reset.preview',{expected_period:period},undefined,'operations',true)
  denied(fakeAdmin,'reset.confirm',{expected_period:period,intent_id:openPreview.intent_id,confirmation:'REINICIAR OPERACION',reason:'ENSAYO con caja abierta'},'OPEN_CASH_SESSIONS','operations',true)
  assert.equal(command(fakeAdmin,'bootstrap').period_id,period)
  command(fakeAdmin,'cash.close',{session_id:sessionAdmin,counted:'1045',expected_period:period})
  command(fakeCashier,'cash.close',{session_id:sessionCashier,counted:'555',expected_period:period})
  const preview=command(fakeAdmin,'reset.preview',{expected_period:period},undefined,'operations',true)
  const resetData={expected_period:period,intent_id:preview.intent_id,confirmation:'REINICIAR OPERACION',reason:'ENSAYO nueva operación con historial conservado'}
  denied(fakeAdmin,'reset.confirm',resetData,'RECENT_AUTH_REQUIRED')
  const reset=command(fakeAdmin,'reset.confirm',resetData,'synthetic-reset-one','operations',true)
  assert.notEqual(reset.period_id,period)
  assert(same(reset,command(fakeAdmin,'reset.confirm',resetData,'synthetic-reset-one','operations',true)))
  assert.equal(rows(clone,'synthetic_active_stock',`SELECT quantity FROM pos.inventory_balances WHERE operating_period_id=${q(reset.period_id)}`)[0].quantity,0)
  const archive=command(fakeAdmin,'periods.detail',{period_id:period,limit:100,offset:0})
  assert.equal(archive.stock.find(row=>row.product_id===product).quantity,8)
  assert.equal(archive.debts.find(row=>row.charge_id===archivedCredit.charge_id).outstanding,'100.00')
  assert.equal(archive.sales.length,3)
  denied(fakeCashier,'debt.receipt',{...receiptData,expected_period:reset.period_id},'DEBT_NOT_FOUND')
  assert.equal(rows(clone,'synthetic_product_preserved',`SELECT price::text,purchase_price::text FROM pos.products WHERE id=${q(product)}`)[0].price,'100.00')
  assert.equal(rows(clone,'synthetic_users_preserved',`SELECT count(*)::integer AS count FROM pos.profiles WHERE id IN (${[fakeAdmin,fakeCashier,fakeSupervisor].map(q).join(',')})`)[0].count,3)
  syntheticPass('reset_recent_auth_open_cash_archive_zero_stock_idempotency_original_debt_preserved')
  sql(clone,'postmigration_integrity_after_reset','SET ROLE postgres;\n'+fs.readFileSync('supabase/checks/v11_postmigration_integrity.sql','utf8'))
  assert.equal(hash(fs.readFileSync(path.resolve('supabase/migrations',migration))),expectedHash,'MIGRATION_CHANGED_DURING_REHEARSAL')
  for(const file of manifest.files) assert.equal(hash(fs.readFileSync(path.join(backup,file.name))),file.sha256,'BACKUP_CHANGED_DURING_REHEARSAL')
  result.passed=true
} catch(error) {
  result.passed=false; result.phase=phase; result.failure=error.message; process.exitCode=1
} finally {
  if(maintenance.active) {
    try { restoreMaintenance() } catch { maintenance.recoveryFailed=true; process.exitCode=1 }
  }
  result.maintenance=maintenance
  for(const container of [...running]) { try { docker('stop_'+container,['stop',container]); running.delete(container) } catch { result.stopFailed=true; process.exitCode=1 } }
  result.containersStopped=running.size===0
  save('result',result)
  console.log(JSON.stringify({status:result.passed?'PASS':'STOPPED',phase:result.phase??'complete',failure:result.failure,restorationVerified:result.restorationVerified,migrationApplied:result.migrationApplied,migrationRegistered:result.migrationRegistered,syntheticCases:result.syntheticTests.length,containersStopped:result.containersStopped,work}))
}
