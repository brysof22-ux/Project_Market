import {readFile} from 'node:fs/promises'
import {createV13Database} from './v13-fixture'
export async function createV14Database(){const db=await createV13Database();await db.exec('SET ROLE credit_migrator');await db.exec(await readFile('supabase/migrations/20261027001200_v14_admin_ux.sql','utf8'));await db.exec('RESET ROLE');return db}
