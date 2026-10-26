// Local dry-run only. No deployment branch and no remote configuration changes.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const executable=path.resolve('.cache/npm/_npx/c943b712072b77c4/node_modules/wrangler/bin/wrangler.js')
assert(fs.existsSync(executable),'APPROVED_WRANGLER_4_152_0_REQUIRED')
const configuration=JSON.parse(fs.readFileSync('worker/api/wrangler.jsonc','utf8'))
assert(configuration.name==='cai-market-api'&&configuration.keep_vars===true,'PRODUCTION_WORKER_SCOPE_REQUIRED')
assert(configuration.vars.SUPABASE_URL==='https://sauoekefntzxhqxycdgo.supabase.co'
  &&configuration.vars.ALLOWED_ORIGIN==='https://project-market.pages.dev'
  &&configuration.vars.LOCAL_ONLY===undefined,'PRODUCTION_BINDINGS_CHANGED')
assert.deepEqual(configuration.r2_buckets,[{binding:'MEDIA',bucket_name:'cai-market-media'}])
const directory=path.resolve('.cache/v11-prepared-worker')
fs.mkdirSync(directory,{recursive:true})
const execution=spawnSync(process.execPath,[executable,'deploy','--dry-run','--outdir',directory,'--config',path.resolve('worker/api/wrangler.jsonc'),'--keep-vars'],{
  windowsHide:true,encoding:'utf8',timeout:90_000,
  env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'f2f2dcbac86bc1a805d13cc387c8a568',CLOUDFLARE_SEND_METRICS:'false',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',CI:'true'},
})
fs.writeFileSync(path.join(directory,'dry-run.private.log'),(execution.stdout??'')+(execution.stderr??''))
assert(!execution.error&&execution.status===0,'WORKER_DRY_RUN_FAILED')
const contents=fs.readFileSync(path.join(directory,'index.js'))
assert(!/sb_secret_[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9_-]{20,}|-----BEGIN[^\r\n]*PRIVATE KEY-----/.test(contents.toString()),'PRIVATE_CREDENTIAL_PATTERN_IN_BUNDLE')
const result={status:'PASS',dryRun:true,deployed:false,artifact:path.relative(process.cwd(),path.join(directory,'index.js')),bytes:contents.length,sha256:crypto.createHash('sha256').update(contents).digest('hex'),productionBindingsUnchanged:true}
fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result))
