import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'

const usage = `Usage: node --env-file=.env scripts/add-user.mjs --email EMAIL --name NAME --flat FLAT --type owner|tenant [--contact PHONE] [--role regular|admin]

Creates an email-confirmed Auth user with a random, discarded password and no email,
then creates its linked profile and resident memberships. Requires a linked Supabase
project and an authenticated Supabase CLI with access to its service role key.`

export function parseUserArguments(args) {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      flat: { type: 'string' },
      type: { type: 'string' },
      contact: { type: 'string' },
      role: { type: 'string', default: 'regular' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help) return null
  const email = values.email?.trim().toLowerCase()
  const name = values.name?.trim()
  const flat = values.flat?.trim()
  const type = values.type?.trim().toLowerCase()
  const role = values.role.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Provide a valid --email.')
  if (!name || !flat) throw new Error('Provide a non-empty --name and --flat.')
  if (!['owner', 'tenant'].includes(type)) throw new Error('--type must be owner or tenant.')
  if (!['regular', 'admin'].includes(role)) throw new Error('--role must be regular or admin.')
  return { email, name, flat, type, role, contact: values.contact?.trim() || null }
}

async function findAuthUserByEmail(supabase, email) {
  const perPage = 1000
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    const users = data.users ?? []
    const match = users.find((candidate) => candidate.email?.trim().toLowerCase() === email)
    if (match) return match
    if (users.length < perPage) return null
  }
}

export async function createUser(supabase, user) {
  const pattern = user.email.replace(/[\\%_]/g, '\\$&')
  const { data: existing, error: lookupError } = await supabase.from('users').select('id').ilike('email', pattern).limit(1)
  if (lookupError) throw lookupError
  if (existing.length) throw new Error('A public profile already exists for this email; no changes were made.')

  let authUser = await findAuthUserByEmail(supabase, user.email)
  let authCreated = false
  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: user.email,
      password: randomBytes(32).toString('base64url'),
      email_confirm: true,
    })
    if (error) {
      authUser = await findAuthUserByEmail(supabase, user.email)
      if (!authUser) throw error
    } else {
      authUser = data.user
      authCreated = true
    }
  }
  const authId = authUser.id
  let profileId
  try {
    const { data: profile, error: profileError } = await supabase.from('users').insert({
      auth_user_id: authId,
      email: user.email,
      name: user.name,
      contact: user.contact,
      flat_number: user.flat,
      resident_type: user.type === 'owner' ? 'owner' : 'resident',
      role: user.role,
    }).select('id').single()
    if (profileError) throw profileError
    profileId = profile.id

    const types = user.type === 'owner' ? ['owner', 'resident'] : ['resident']
    const { error: membershipError } = await supabase.from('user_resident_types').insert(
      types.map((residentType) => ({ user_id: profileId, resident_type: residentType })),
    )
    if (membershipError) throw membershipError
    return { authId, profileId, residentTypes: types, authCreated }
  } catch (error) {
    if (profileId) {
      const { error: cleanupError } = await supabase.from('users').delete().eq('id', profileId)
      if (cleanupError) throw new Error(`Profile creation failed: ${error.message}. Cleanup failed for profile ${profileId} and Auth user ${authId}: ${cleanupError.message}`)
    }
    if (!authCreated) {
      throw new Error(`Profile creation failed: ${error.message}. The existing Auth account ${authId} was retained.`)
    }
    const { error: cleanupError } = await supabase.auth.admin.deleteUser(authId)
    if (cleanupError) throw new Error(`Profile creation failed: ${error.message}. Cleanup failed for Auth user ${authId}: ${cleanupError.message}`)
    throw new Error(`Profile creation failed: ${error.message}. The newly created account was removed.`)
  }
}

async function main() {
  const user = parseUserArguments(process.argv.slice(2))
  if (!user) {
    console.log(usage)
    return
  }
  const projectRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
  const projectUrl = process.env.VITE_SUPABASE_URL
  if (!projectUrl || new URL(projectUrl).hostname !== `${projectRef}.supabase.co`) {
    throw new Error('VITE_SUPABASE_URL must match the linked Supabase project.')
  }
  const keys = JSON.parse(execFileSync('npx', ['--yes', 'supabase', 'projects', 'api-keys', '--reveal', '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  const serviceKey = keys.find((key) => key.name === 'service_role')?.api_key
  if (!serviceKey) throw new Error('Could not obtain the linked project service role key.')
  const supabase = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const result = await createUser(supabase, user)
  console.log(JSON.stringify({ projectRef, email: user.email, ...result }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}