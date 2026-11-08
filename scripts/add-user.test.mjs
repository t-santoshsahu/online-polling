import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUser, parseUserArguments } from './add-user.mjs'

function client({ existing = [], authError = null, profileError = null, membershipError = null, cleanupError = null } = {}) {
  const calls = []
  return {
    calls,
    auth: { admin: {
      async createUser(payload) { calls.push(['auth', payload]); return { data: { user: { id: 'auth-id' } }, error: authError } },
      async deleteUser(id) { calls.push(['delete-auth', id]); return { error: cleanupError } },
    } },
    from(table) {
      return {
        select() { return { ilike(column, value) { calls.push(['lookup', column, value]); return { async limit() { return { data: existing, error: null } } } } } },
        insert(payload) {
          calls.push(['insert', table, payload])
          if (table === 'users') return { select() { return { async single() { return { data: { id: 'profile-id' }, error: profileError } } } } }
          return Promise.resolve({ error: membershipError })
        },
        delete() { return { async eq(column, value) { calls.push(['delete-profile', column, value]); return { error: cleanupError } } } },
      }
    },
  }
}

const user = parseUserArguments(['--email', ' Person@Example.com ', '--name', ' Person ', '--flat', 'A-1', '--type', 'owner'])

test('validates arguments and normalizes user details', () => {
  assert.equal(user.email, 'person@example.com')
  assert.equal(user.name, 'Person')
  assert.equal(user.role, 'regular')
  assert.throws(() => parseUserArguments(['--email', 'bad']), /valid --email/)
  assert.throws(() => parseUserArguments(['--email', 'a@b.com', '--name', 'A', '--flat', 'A', '--type', 'other']), /--type/)
})

test('creates an owner and resident without sending email', async () => {
  const supabase = client()
  const result = await createUser(supabase, user)
  assert.deepEqual(result.residentTypes, ['owner', 'resident'])
  const auth = supabase.calls.find(([operation]) => operation === 'auth')[1]
  assert.equal(auth.email_confirm, true)
  assert.ok(auth.password.length >= 32)
  assert.equal(supabase.calls.find(([operation, table]) => operation === 'insert' && table === 'users')[2].auth_user_id, 'auth-id')
  assert.deepEqual(supabase.calls.find(([operation, table]) => operation === 'insert' && table === 'user_resident_types')[2].map((row) => row.resident_type), ['owner', 'resident'])
})

test('creates tenant membership only', async () => {
  const supabase = client()
  const result = await createUser(supabase, { ...user, type: 'tenant' })
  assert.deepEqual(result.residentTypes, ['resident'])
})

test('does not modify an existing profile or Auth account', async () => {
  const supabase = client({ existing: [{ id: 'existing' }] })
  await assert.rejects(createUser(supabase, user), /already exists/)
  assert.equal(supabase.calls.length, 1)
  const duplicateAuth = client({ authError: new Error('already registered') })
  await assert.rejects(createUser(duplicateAuth, user), /already registered/)
  assert.equal(duplicateAuth.calls.length, 2)
})

test('cleans up new records on membership failure', async () => {
  const supabase = client({ membershipError: new Error('membership failed') })
  await assert.rejects(createUser(supabase, user), /account was removed/)
  assert.deepEqual(supabase.calls.slice(-2).map(([operation]) => operation), ['delete-profile', 'delete-auth'])
})

test('removes the new Auth account on profile failure', async () => {
  const supabase = client({ profileError: new Error('profile failed') })
  await assert.rejects(createUser(supabase, user), /account was removed/)
  assert.equal(supabase.calls.at(-1)[0], 'delete-auth')
})

test('reports cleanup failures without deleting a linked Auth account', async () => {
  const supabase = client({ membershipError: new Error('membership failed'), cleanupError: new Error('cleanup failed') })
  await assert.rejects(createUser(supabase, user), /profile profile-id and Auth user auth-id/)
  assert.equal(supabase.calls.at(-1)[0], 'delete-profile')
})