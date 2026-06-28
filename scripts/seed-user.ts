/**
 * Bootstrap an initial admin user and create the gateway's Mongo indexes.
 * Idempotent for indexes; fails if the email already exists.
 *
 *   npm run seed:user -- --email admin@acme.com --password 'S3cret!' --tenant acme
 *   # or via env: SEED_EMAIL, SEED_PASSWORD, SEED_TENANT
 */
import { ensureIndexes } from '../src/db/collections.js'
import { createUser } from '../src/auth/users.js'
import { closeDb } from '../src/db/connection.js'

function arg(flag: string, envKey: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return process.env[envKey] ?? fallback
}

async function main() {
  const email = arg('--email', 'SEED_EMAIL')
  const password = arg('--password', 'SEED_PASSWORD')
  const tenantId = arg('--tenant', 'SEED_TENANT', 'root') as string

  if (!email || !password) {
    throw new Error('Provide --email and --password (or SEED_EMAIL / SEED_PASSWORD)')
  }

  console.log('Creating indexes…')
  await ensureIndexes()

  const user = await createUser({
    email,
    password,
    tenantId,
    scopes: ['admin', 'api:read', 'api:write', 'ai:invoke'],
  })

  console.log('\nAdmin user created:')
  console.log(`  id:      ${user._id}`)
  console.log(`  email:   ${user.email}`)
  console.log(`  tenant:  ${user.tenantId}`)
  console.log(`  scopes:  ${user.scopes.join(', ')}\n`)
  console.log('Log in via POST /_gw/auth/login to obtain an access token.')
}

main()
  .catch((err) => {
    console.error('seed-user failed:', err)
    process.exitCode = 1
  })
  .finally(() => closeDb())
