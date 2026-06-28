/**
 * Bootstrap an initial admin API key and create the gateway's Mongo indexes.
 * Idempotent for indexes; always mints a fresh key (the raw value is printed
 * once and cannot be recovered later).
 *
 *   npm run seed:keys                       # default tenant "root"
 *   npm run seed:keys -- --tenant acme      # custom tenant
 */
import { ensureIndexes } from '../src/db/collections.js'
import { issueKey } from '../src/auth/apiKey.js'
import { closeDb } from '../src/db/connection.js'

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

async function main() {
  const tenantId = argValue('--tenant', 'root')

  console.log('Creating indexes…')
  await ensureIndexes()

  const { raw, doc } = await issueKey({
    tenantId,
    name: 'bootstrap-admin',
    scopes: ['admin', 'api:read', 'api:write', 'ai:invoke'],
  })

  console.log('\nAdmin API key created (store it now — it will not be shown again):\n')
  console.log(`  ${raw}\n`)
  console.log(`  id:      ${doc._id}`)
  console.log(`  tenant:  ${doc.tenantId}`)
  console.log(`  scopes:  ${doc.scopes.join(', ')}\n`)
  console.log('Use it as:  Authorization: Bearer <key>   or   X-Api-Key: <key>')
}

main()
  .catch((err) => {
    console.error('seed-keys failed:', err)
    process.exitCode = 1
  })
  .finally(() => closeDb())
