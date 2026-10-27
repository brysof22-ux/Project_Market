import { readFile } from 'node:fs/promises'
import { createV12Database } from './v12-fixture'
export async function createV13Database() {
 const db=await createV12Database()
 await db.exec('SET ROLE credit_migrator')
 await db.exec(await readFile('supabase/migrations/20261027001100_v13_operations.sql','utf8'))
 await db.exec('RESET ROLE')
 return db
}
