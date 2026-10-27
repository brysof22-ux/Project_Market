import {readFile} from 'node:fs/promises'
import {createV14Database} from './v14-fixture'
export async function createResetFixDatabase(){const db=await createV14Database();await db.exec('SET ROLE credit_migrator');await db.exec(await readFile('supabase/migrations/20261027001300_reset_safeupdate.sql','utf8'));await db.exec('RESET ROLE');return db}
