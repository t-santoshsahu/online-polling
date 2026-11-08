import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import { createClient } from '@supabase/supabase-js'

const apply = process.argv.includes('--apply')
const csvPath = process.argv.find((argument, index) => index > 1 && !argument.startsWith('--')) ?? 'test_data/resident.csv'
const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='))
const limit = limitArgument ? Number(limitArgument.slice('--limit='.length)) : Infinity
if (!(limit === Infinity || (Number.isInteger(limit) && limit > 0))) throw new Error('Limit must be a positive integer.')
const prepareArgument = process.argv.find((argument) => argument.startsWith('--prepare-existing-through='))
const prepareThrough = prepareArgument ? Number(prepareArgument.slice('--prepare-existing-through='.length)) : null
if (prepareArgument && (!Number.isInteger(prepareThrough) || prepareThrough < 2)) throw new Error('The preparation row must be a positive CSV row number.')
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

const parsed = Papa.parse(readFileSync(csvPath, 'utf8'), { skipEmptyLines: 'greedy' })
const expectedHeader = ['Name', 'Email', 'Phone', 'Apartment Name', 'Approved On', 'Created On', 'Occupancy Status']
if (parsed.errors.length || JSON.stringify(parsed.data[0]) !== JSON.stringify(expectedHeader)) {
  throw new Error('Unexpected CSV format or invalid CSV quoting.')
}
const rows = parsed.data.slice(1).map((fields, index) => ({
  row: index + 2,
  fields,
  name: fields[0]?.trim(),
  email: fields[1]?.trim().toLowerCase(),
  contact: fields[2]?.trim() || null,
  flat: fields[3]?.trim(),
  status: fields[7]?.trim().toLowerCase(),
}))
const emailCounts = new Map()
for (const row of rows) {
  if (row.email) emailCounts.set(row.email, (emailCounts.get(row.email) ?? 0) + 1)
}

const authUsers = []
for (let page = 1; ; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
  if (error) throw error
  authUsers.push(...data.users)
  if (data.users.length < 1000) break
}
const profiles = []
for (let offset = 0; ; offset += 1000) {
  const { data, error } = await supabase.from('users').select('id,email,auth_user_id,role,name,flat_number').range(offset, offset + 999)
  if (error) throw error
  profiles.push(...data)
  if (data.length < 1000) break
}
const authByEmail = new Map(authUsers.filter((user) => user.email).map((user) => [user.email.trim().toLowerCase(), user]))
const profileEmails = new Set(profiles.map((profile) => profile.email.trim().toLowerCase()))
const linkedAuthIds = new Set(profiles.map((profile) => profile.auth_user_id).filter(Boolean))
const skipped = { missingOrInvalid: [], duplicateEmail: [], existingProfile: [], existingAuth: [] }
const eligible = []
for (const row of rows) {
  if (row.fields.length !== 8 || !row.name || !row.flat || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email ?? '') || !['owner', 'tenant'].includes(row.status)) {
    skipped.missingOrInvalid.push(row.row)
  } else if (emailCounts.get(row.email) > 1) {
    skipped.duplicateEmail.push(row.row)
  } else if (profileEmails.has(row.email)) {
    skipped.existingProfile.push(row.row)
  } else if (authByEmail.has(row.email)) {
    skipped.existingAuth.push(row.row)
  } else {
    eligible.push(row)
  }
}

const prepareRows = prepareThrough ? rows.filter((row) => {
  const profile = profiles.find((candidate) => candidate.email.trim().toLowerCase() === row.email)
  const authUser = authByEmail.get(row.email)
  return row.row <= prepareThrough && emailCounts.get(row.email) === 1 && profile?.role === 'regular' &&
    profile.name === row.name && profile.flat_number === row.flat && profile.auth_user_id === authUser?.id &&
    linkedAuthIds.has(authUser?.id) && !authUser.email_confirmed_at
}) : []
const batch = (prepareThrough ? prepareRows : eligible).slice(0, limit)
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', action: prepareThrough ? 'prepare-existing' : 'import', projectRef, totalRows: rows.length, eligible: prepareThrough ? prepareRows.length : eligible.length, batch: batch.length, skipped }, null, 2))
if (apply) {
  let imported = 0
  const failures = []
  for (const row of batch) {
    try {
      if (prepareThrough) {
        const { error } = await supabase.auth.admin.updateUserById(authByEmail.get(row.email).id, {
          password: randomBytes(32).toString('base64url'),
          email_confirm: true,
        })
        if (error) throw error
        imported += 1
        if (imported % 50 === 0) console.log(`Prepared ${imported} of ${batch.length}.`)
        continue
      }
      let authUser = authByEmail.get(row.email)
      if (!authUser) {
        const { data, error } = await supabase.auth.admin.createUser({
          email: row.email,
          password: randomBytes(32).toString('base64url'),
          email_confirm: true,
        })
        if (error) throw error
        authUser = data.user
      }
      const { data: profile, error: profileError } = await supabase.from('users').insert({
        auth_user_id: authUser.id,
        email: row.email,
        name: row.name,
        contact: row.contact,
        flat_number: row.flat,
        resident_type: row.status === 'owner' ? 'owner' : 'resident',
        role: 'regular',
      }).select('id').single()
      if (profileError) throw profileError
      const residentTypes = row.status === 'owner' ? ['owner', 'resident'] : ['resident']
      const { error: membershipError } = await supabase.from('user_resident_types').insert(
        residentTypes.map((residentType) => ({ user_id: profile.id, resident_type: residentType })),
      )
      if (membershipError) throw membershipError
      imported += 1
      if (imported % 50 === 0) console.log(`Imported ${imported} of ${batch.length}.`)
    } catch (error) {
      failures.push({ row: row.row, message: error.message })
    }
  }
  console.log(JSON.stringify({ imported, failures }, null, 2))
  if (failures.length) process.exitCode = 1
}