import { useCallback, useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import { getSupabaseClient } from '../../supabaseClient.js'
import { formatDeadlineIST, hasDeadlinePassed } from '../../lib/time'

const restrictions = [
  ['one_per_flat', 'One vote per flat'],
  ['owners_only_one_per_flat', 'Owners only, one per flat'],
  ['residents_only_one_per_flat', 'Residents only, one per flat'],
  ['all_owners', 'All owners, one owner vote per flat'],
  ['all_residents', 'All residents, one resident vote per flat'],
  ['all_owners_and_residents', 'Owners and residents, one each per flat'],
]

const requiredColumns = ['email', 'name', 'flat_number', 'resident_type']
const restrictionLabels = Object.fromEntries(restrictions)

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.trim().toLowerCase(),
      complete: (result) => {
        try {
          if (result.errors.length) {
            reject(new Error(result.errors[0].message))
            return
          }

          const headers = result.meta.fields ?? []
          const missing = requiredColumns.filter((column) => !headers.includes(column))
          if (missing.length) {
            reject(new Error(`Missing CSV columns: ${missing.join(', ')}`))
            return
          }

          const users = result.data.map((row, index) => {
            const residentType = row.resident_type?.trim().toLowerCase()
            const role = row.role?.trim().toLowerCase() || 'regular'
            if (!row.email?.trim() || !row.name?.trim() || !row.flat_number?.trim()) {
              throw new Error(`Row ${index + 2} needs email, name, and flat_number.`)
            }
            if (!['owner', 'resident'].includes(residentType)) {
              throw new Error(`Row ${index + 2} resident_type must be owner or resident.`)
            }
            if (!['admin', 'regular'].includes(role)) {
              throw new Error(`Row ${index + 2} role must be admin or regular.`)
            }

            return {
              email: row.email.trim().toLowerCase(),
              name: row.name.trim(),
              contact: row.contact?.trim() || null,
              flat_number: row.flat_number.trim(),
              resident_type: residentType,
              role,
              auth_user_id: row.auth_user_id?.trim() || null,
            }
          })
          resolve(users)
        } catch (parseError) {
          reject(parseError)
        }
      },
      error: reject,
    })
  })
}

function istInputToIso(value) {
  const parsedDate = new Date(`${value}:00+05:30`)
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Enter a valid deadline in India Standard Time.')
  }
  return parsedDate.toISOString()
}

function Field({ label, children }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-[#31392f]">
      <span>{label}</span>
      {children}
    </label>
  )
}

const inputClassName = 'w-full border border-[#cbd3c6] bg-white px-3 py-2 text-sm text-[#20251f] outline-none focus:border-[#527247] focus:ring-2 focus:ring-[#527247]/20'

export default function AdminDashboard() {
  const csvInputRef = useRef(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const [pollBusy, setPollBusy] = useState(false)
  const [pollsLoading, setPollsLoading] = useState(true)
  const [pollsError, setPollsError] = useState('')
  const [polls, setPolls] = useState([])
  const [csvMessage, setCsvMessage] = useState('')
  const [pollMessage, setPollMessage] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [pollType, setPollType] = useState('single_choice')
  const [restriction, setRestriction] = useState('one_per_flat')
  const [deadline, setDeadline] = useState('')
  const [optionsText, setOptionsText] = useState('')

  const loadPolls = useCallback(async () => {
    setPollsLoading(true)
    try {
      const { data, error } = await getSupabaseClient()
        .from('polls')
        .select('id, title, poll_type, restriction, deadline, is_deleted, created_at')
        .order('created_at', { ascending: false })
      if (error) throw error
      setPolls(data ?? [])
      setPollsError('')
    } catch (error) {
      setPollsError(error instanceof Error ? error.message : 'Could not load polls.')
    } finally {
      setPollsLoading(false)
    }
  }, [])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadPolls(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [loadPolls])

  async function handleCsvUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return

    setCsvBusy(true)
    setCsvMessage('')
    try {
      const users = await parseCsv(file)
      if (!users.length) throw new Error('The CSV has no voter rows.')
      const { data, error } = await getSupabaseClient().rpc('admin_import_users', {
        p_users: users,
      })
      if (error) throw error
      setCsvMessage(`${data} voter record${data === 1 ? '' : 's'} imported.`)
    } catch (error) {
      setCsvMessage(error instanceof Error ? error.message : 'CSV import failed.')
    } finally {
      setCsvBusy(false)
      event.target.value = ''
    }
  }

  async function handleCreatePoll(event) {
    event.preventDefault()
    setPollBusy(true)
    setPollMessage('')
    try {
      const options = optionsText.split('\n').map((option) => option.trim()).filter(Boolean)
      const { error } = await getSupabaseClient().rpc('admin_create_poll', {
        p_title: title.trim(),
        p_description: description.trim(),
        p_poll_type: pollType,
        p_restriction: restriction,
        p_deadline: istInputToIso(deadline),
        p_options: options,
      })
      if (error) throw error
      setPollMessage('Poll created.')
      setTitle('')
      setDescription('')
      setDeadline('')
      setOptionsText('')
      await loadPolls()
    } catch (error) {
      setPollMessage(error instanceof Error ? error.message : 'Poll creation failed.')
    } finally {
      setPollBusy(false)
    }
  }

  return (
    <div className="space-y-10">
      <section className="border-b border-[#d9ded5] pb-6">
        <h1 className="text-2xl font-semibold">Administration</h1>
        <p className="mt-1 text-sm text-[#667064]">Manage registered voters and create society polls.</p>
      </section>

      <section className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <h2 className="text-lg font-semibold">Import voters</h2>
          <p className="mt-1 text-sm leading-6 text-[#667064]">
            CSV columns: email, name, flat_number, resident_type. Optional: contact, role, auth_user_id.
          </p>
          <input
            ref={csvInputRef}
            className="sr-only"
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvUpload}
          />
          <button
            className="mt-4 inline-flex min-h-10 items-center border border-[#527247] px-4 text-sm font-semibold text-[#355333] hover:bg-[#eaf0e6] disabled:opacity-50"
            type="button"
            disabled={csvBusy}
            onClick={() => csvInputRef.current?.click()}
          >
            {csvBusy ? 'Importing...' : 'Choose CSV file'}
          </button>
          {csvMessage && <p className="mt-3 text-sm" role="status">{csvMessage}</p>}
        </div>

        <form className="grid gap-4 border-l-2 border-[#d9ded5] pl-6" onSubmit={handleCreatePoll}>
          <h2 className="text-lg font-semibold">Create poll</h2>
          <Field label="Poll title">
            <input className={inputClassName} required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Description">
            <textarea className={inputClassName} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Voting method">
              <select className={inputClassName} value={pollType} onChange={(event) => setPollType(event.target.value)}>
                <option value="single_choice">Single choice</option>
                <option value="ranked_choice">Ranked choice</option>
              </select>
            </Field>
            <Field label="Voter restriction">
              <select className={inputClassName} value={restriction} onChange={(event) => setRestriction(event.target.value)}>
                {restrictions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Deadline (India Standard Time)">
            <input className={inputClassName} type="datetime-local" required value={deadline} onChange={(event) => setDeadline(event.target.value)} />
          </Field>
          <Field label="Options (one per line)">
            <textarea className={inputClassName} required rows={4} value={optionsText} onChange={(event) => setOptionsText(event.target.value)} placeholder={'Option A\nOption B'} />
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <button className="min-h-10 bg-[#355f3a] px-4 text-sm font-semibold text-white hover:bg-[#294b2e] disabled:opacity-50" type="submit" disabled={pollBusy}>
              {pollBusy ? 'Creating...' : 'Create poll'}
            </button>
            {pollMessage && <p className="text-sm" role="status">{pollMessage}</p>}
          </div>
        </form>
      </section>

      <section className="border-t border-[#d9ded5] pt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Polls</h2>
            <p className="mt-1 text-sm text-[#667064]">All society polls, including closed and deleted polls.</p>
          </div>
          <button
            className="min-h-9 border border-[#cbd3c6] px-3 text-sm font-medium hover:bg-white disabled:opacity-50"
            type="button"
            disabled={pollsLoading}
            onClick={() => void loadPolls()}
          >
            {pollsLoading ? 'Refreshing...' : 'Refresh list'}
          </button>
        </div>

        {pollsError ? (
          <p className="border-l-4 border-[#a84435] bg-[#fff4f1] px-4 py-3 text-sm text-[#7b2f25]" role="alert">{pollsError}</p>
        ) : pollsLoading ? (
          <p className="py-4 text-sm text-[#667064]" role="status">Loading polls...</p>
        ) : polls.length === 0 ? (
          <p className="py-4 text-sm text-[#667064]">No polls have been created yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[#cbd3c6] text-xs uppercase text-[#667064]">
                  <th className="py-2 pr-4 font-medium">Poll</th>
                  <th className="py-2 pr-4 font-medium">Method</th>
                  <th className="py-2 pr-4 font-medium">Restriction</th>
                  <th className="py-2 pr-4 font-medium">Deadline (IST)</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {polls.map((poll) => {
                  const status = poll.is_deleted
                    ? 'Deleted'
                    : hasDeadlinePassed(poll.deadline)
                      ? 'Closed'
                      : 'Open'
                  return (
                    <tr className="border-b border-[#e4e8e1]" key={poll.id}>
                      <td className="py-3 pr-4 font-medium">{poll.title}</td>
                      <td className="py-3 pr-4">{poll.poll_type === 'ranked_choice' ? 'Ranked choice' : 'Single choice'}</td>
                      <td className="py-3 pr-4">{restrictionLabels[poll.restriction] ?? poll.restriction}</td>
                      <td className="py-3 pr-4 whitespace-nowrap">{formatDeadlineIST(poll.deadline)}</td>
                      <td className="py-3">
                        <span className={status === 'Open' ? 'font-medium text-[#355f3a]' : 'text-[#667064]'}>{status}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}