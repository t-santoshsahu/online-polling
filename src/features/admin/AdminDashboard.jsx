import { useCallback, useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import { getSupabaseClient } from '../../supabaseClient.js'
import { formatDeadlineIST, hasDeadlinePassed } from '../../lib/time'
import ImageLightbox from '../polls/ImageLightbox.jsx'

const restrictions = [
  ['one_per_flat', 'One vote per flat'],
  ['owners_only_one_per_flat', 'Owners only, one per flat'],
  ['residents_only_one_per_flat', 'Residents only, one per flat'],
  ['all_owners', 'All owners, one owner vote per flat'],
  ['all_residents', 'All residents, one resident vote per flat'],
  ['all_owners_and_residents', 'All owners and residents, one vote per person'],
]

const requiredColumns = ['email', 'name', 'flat_number']
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
          if (!headers.includes('resident_types') && !headers.includes('resident_type')) {
            reject(new Error('Add a resident_types column (owner;resident) or the legacy resident_type column.'))
            return
          }

          const users = result.data.map((row, index) => {
            const residentTypes = row.resident_types?.trim()
              ? row.resident_types.split(/[;|]/).map((value) => value.trim().toLowerCase()).filter(Boolean)
              : row.resident_type?.trim()
                ? [row.resident_type.trim().toLowerCase()]
                : []
            const role = row.role?.trim().toLowerCase() || 'regular'
            if (!row.email?.trim() || !row.name?.trim() || !row.flat_number?.trim()) {
              throw new Error(`Row ${index + 2} needs email, name, and flat_number.`)
            }
            if (residentTypes.some((type) => !['owner', 'resident'].includes(type))) {
              throw new Error(`Row ${index + 2} resident_types may contain owner and/or resident.`)
            }
            if (role === 'regular' && residentTypes.length === 0) {
              throw new Error(`Row ${index + 2} regular voters need at least one resident type.`)
            }
            if (!['admin', 'regular'].includes(role)) {
              throw new Error(`Row ${index + 2} role must be admin or regular.`)
            }

            return {
              email: row.email.trim().toLowerCase(),
              name: row.name.trim(),
              contact: row.contact?.trim() || null,
              flat_number: row.flat_number.trim(),
              resident_types: [...new Set(residentTypes)],
              resident_type: residentTypes[0] ?? null,
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

function normalizeImageUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Image URLs must start with http:// or https://.')
  }

  if (url.hostname === 'drive.google.com') {
    const fileId = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get('id')
    if (fileId) {
      return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`
    }
  }

  return url.href
}

function safeImagePreviewUrl(value) {
  if (!value.trim()) return ''
  try {
    return normalizeImageUrl(value.trim())
  } catch {
    return ''
  }
}

function Field({ label, children }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-[#31392f]">
      <span>{label}</span>
      {children}
    </label>
  )
}

const inputClassName = 'min-h-11 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] outline-none transition focus:border-[var(--leaf)] focus:ring-4 focus:ring-[var(--leaf)]/10'

export default function AdminDashboard() {
  const csvInputRef = useRef(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const [pollBusy, setPollBusy] = useState(false)
  const [pollsLoading, setPollsLoading] = useState(true)
  const [pollsError, setPollsError] = useState('')
  const [polls, setPolls] = useState([])
  const [availableFlats, setAvailableFlats] = useState([])
  const [flatsLoading, setFlatsLoading] = useState(true)
  const [flatsError, setFlatsError] = useState('')
  const [flatScope, setFlatScope] = useState('all')
  const [selectedFlats, setSelectedFlats] = useState([])
  const [flatSearch, setFlatSearch] = useState('')
  const [csvMessage, setCsvMessage] = useState('')
  const [pollMessage, setPollMessage] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [pollType, setPollType] = useState('single_choice')
  const [restriction, setRestriction] = useState('one_per_flat')
  const [deadline, setDeadline] = useState('')
  const [options, setOptions] = useState([
    { text: '', imageUrl: '' },
    { text: '', imageUrl: '' },
  ])

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

  const loadFlats = useCallback(async () => {
    setFlatsLoading(true)
    try {
      const { data, error } = await getSupabaseClient().rpc('admin_list_flats')
      if (error) throw error
      setAvailableFlats((data ?? []).map((row) => row.flat_number))
      setFlatsError('')
    } catch (error) {
      setFlatsError(error instanceof Error ? error.message : 'Could not load registered flats.')
    } finally {
      setFlatsLoading(false)
    }
  }, [])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadPolls(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [loadPolls])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadFlats(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [loadFlats])

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
      const pollOptions = options.map((option, index) => {
        const text = option.text.trim()
        const rawImageUrl = option.imageUrl.trim()
        if (!text && !rawImageUrl) {
          throw new Error(`Option ${index + 1} needs text, an image URL, or both.`)
        }

        return {
          option_text: text || null,
          image_url: rawImageUrl ? normalizeImageUrl(rawImageUrl) : null,
        }
      })

      if (pollOptions.length < 2) throw new Error('Add at least two poll options.')
      if (pollType === 'ranked_choice' && pollOptions.length < 3) {
        throw new Error('Ranked-choice polls need at least three options because voters rank their top three.')
      }

      if (flatScope === 'selected' && selectedFlats.length === 0) {
        throw new Error('Select at least one flat, or choose all flats.')
      }

      const { error } = await getSupabaseClient().rpc('admin_create_scoped_poll_with_options', {
        p_title: title.trim(),
        p_description: description.trim(),
        p_poll_type: pollType,
        p_restriction: restriction,
        p_deadline: istInputToIso(deadline),
        p_options: pollOptions,
        p_flat_scope: flatScope,
        p_flat_numbers: flatScope === 'selected' ? selectedFlats : [],
      })
      if (error) throw error
      setPollMessage('Poll created.')
      setTitle('')
      setDescription('')
      setDeadline('')
      setOptions([
        { text: '', imageUrl: '' },
        { text: '', imageUrl: '' },
      ])
      setFlatScope('all')
      setSelectedFlats([])
      setFlatSearch('')
      await loadPolls()
    } catch (error) {
      setPollMessage(error instanceof Error ? error.message : 'Poll creation failed.')
    } finally {
      setPollBusy(false)
    }
  }

  return (
    <div className="rise-in space-y-7 sm:space-y-9">
      <section className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--line)] pb-5 sm:pb-6">
        <div>
          <p className="text-[10px] font-bold uppercase text-[var(--coral)]">Society tools</p>
          <h1 className="mt-1 font-serif text-3xl font-semibold text-[var(--ink)]">Administration</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">Manage registered voters and create society polls.</p>
        </div>
        <span className="rounded-full border border-[var(--line)] bg-white/70 px-3 py-1.5 text-xs font-medium text-[var(--muted)]">{polls.length} polls</span>
      </section>

      <section className="grid gap-5 lg:grid-cols-[0.72fr_1.28fr] lg:gap-6">
        <div className="flex flex-col items-start rounded-2xl bg-[var(--forest)] p-5 text-white shadow-[0_14px_36px_rgba(27,69,57,0.12)] sm:p-6">
          <span className="grid size-9 place-items-center rounded-lg bg-[var(--citrus)] text-sm font-bold text-[var(--forest)]">01</span>
          <h2 className="mt-5 font-serif text-xl font-semibold">Import voters</h2>
          <p className="mt-2 text-sm leading-6 text-white/70">
            CSV columns: email, name, flat_number, resident_types. Use owner;resident for both categories. The legacy resident_type column is also accepted. Optional: contact, role, auth_user_id. Admins may leave resident_types blank.
          </p>
          <input
            ref={csvInputRef}
            className="sr-only"
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvUpload}
          />
          <button
            className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-[var(--citrus)] px-4 text-sm font-bold text-[var(--forest)] hover:bg-white disabled:opacity-50"
            type="button"
            disabled={csvBusy}
            onClick={() => csvInputRef.current?.click()}
          >
            {csvBusy ? 'Importing...' : 'Choose CSV file'}
          </button>
          {csvMessage && <p className="mt-3 text-sm text-white/85" role="status">{csvMessage}</p>}
        </div>

        <form className="grid gap-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[0_14px_36px_rgba(29,48,41,0.055)] sm:p-6" onSubmit={handleCreatePoll}>
          <div className="flex items-center gap-3 border-b border-[var(--line)] pb-4">
            <span className="grid size-9 place-items-center rounded-lg bg-[#e8eddf] text-sm font-bold text-[var(--leaf)]">02</span>
            <div>
              <h2 className="font-serif text-xl font-semibold">Create poll</h2>
              <p className="mt-0.5 text-xs text-[var(--muted)]">Set the question, audience, and ballot choices.</p>
            </div>
          </div>
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
                <option value="ranked_choice">Ranked choice — top 3</option>
              </select>
            </Field>
            <Field label="Voter restriction">
              <select className={inputClassName} value={restriction} onChange={(event) => setRestriction(event.target.value)}>
                {restrictions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          {pollType === 'ranked_choice' && (
            <p className="rounded-lg bg-[#f0f3eb] px-3 py-2 text-xs leading-5 text-[var(--muted)]">
              Voters will choose exactly three options and assign positions 1, 2, and 3.
            </p>
          )}
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium text-[#31392f]">Flat visibility</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${flatScope === 'all' ? 'border-[var(--leaf)] bg-[#f0f3eb]' : 'border-[var(--line)] bg-white'}`}>
                <input type="radio" name="flat-scope" value="all" checked={flatScope === 'all'} onChange={() => setFlatScope('all')} />
                <span><span className="block font-semibold text-[var(--ink)]">All registered flats</span><span className="mt-0.5 block text-xs text-[var(--muted)]">Category restriction still applies.</span></span>
              </label>
              <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${flatScope === 'selected' ? 'border-[var(--leaf)] bg-[#f0f3eb]' : 'border-[var(--line)] bg-white'}`}>
                <input type="radio" name="flat-scope" value="selected" checked={flatScope === 'selected'} onChange={() => setFlatScope('selected')} />
                <span><span className="block font-semibold text-[var(--ink)]">Selected flats only</span><span className="mt-0.5 block text-xs text-[var(--muted)]">Only these flats can see and vote in this poll.</span></span>
              </label>
            </div>
            {flatScope === 'selected' && (
              <div className="grid gap-3 rounded-xl border border-[var(--line)] bg-white p-3 sm:p-4">
                {flatsError && <p className="text-sm text-[#8e422d]" role="alert">{flatsError}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--ink)]">
                    {flatsLoading ? 'Loading flats...' : `${selectedFlats.length} of ${availableFlats.length} flats selected`}
                  </p>
                  <div className="flex gap-2">
                    <button className="rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs font-semibold disabled:opacity-40" type="button" disabled={flatsLoading || availableFlats.length === 0} onClick={() => setSelectedFlats(availableFlats)}>Select all</button>
                    <button className="rounded-md border border-[var(--line)] px-2.5 py-1.5 text-xs font-semibold disabled:opacity-40" type="button" disabled={selectedFlats.length === 0} onClick={() => setSelectedFlats([])}>Clear</button>
                  </div>
                </div>
                <input className={inputClassName} type="search" value={flatSearch} onChange={(event) => setFlatSearch(event.target.value)} placeholder="Search flat number..." aria-label="Search registered flats" />
                {!flatsLoading && availableFlats.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No registered flats found.</p>
                ) : (
                  <div className="grid max-h-48 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
                    {availableFlats.filter((flat) => flat.toLowerCase().includes(flatSearch.trim().toLowerCase())).map((flat) => (
                      <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-2 text-sm hover:border-[var(--leaf)]" key={flat}>
                        <input type="checkbox" checked={selectedFlats.includes(flat)} onChange={(event) => setSelectedFlats((current) => event.target.checked ? [...current, flat] : current.filter((value) => value !== flat))} />
                        <span className="truncate">{flat}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </fieldset>
          <Field label="Deadline (India Standard Time)">
            <input className={inputClassName} type="datetime-local" required value={deadline} onChange={(event) => setDeadline(event.target.value)} />
          </Field>
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium text-[#31392f]">Poll options</legend>
            {options.map((option, index) => {
              const previewUrl = safeImagePreviewUrl(option.imageUrl)
              return (
                <div className="grid gap-2 border-b border-[var(--line)] py-3 last:border-0 sm:grid-cols-[1fr_1fr_auto]" key={index}>
                  <label className="grid gap-1 text-xs font-medium text-[#667064]">
                    Option {index + 1} text
                    <input
                      className={inputClassName}
                      value={option.text}
                      onChange={(event) => setOptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))}
                      placeholder="Optional when using an image"
                    />
                  </label>
                  <div className="grid gap-2">
                    <label className="grid gap-1 text-xs font-medium text-[#667064]">
                      Image URL
                      <input
                        className={inputClassName}
                        type="url"
                        inputMode="url"
                        value={option.imageUrl}
                        onChange={(event) => setOptions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, imageUrl: event.target.value } : item))}
                        placeholder="https://... or public Google Drive link"
                      />
                    </label>
                    {previewUrl && <ImageLightbox className="size-16 rounded-lg bg-[#edf1e8]" src={previewUrl} alt={option.text.trim() || `Option ${index + 1} preview`} />}
                  </div>
                  <button
                    className="self-end rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--muted)] hover:border-[var(--coral)] hover:text-[var(--coral)] disabled:opacity-40"
                    type="button"
                    aria-label={`Remove option ${index + 1}`}
                    disabled={options.length <= 2}
                    onClick={() => setOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >Remove</button>
                </div>
              )
            })}
            <button
              className="justify-self-start rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold text-[var(--leaf)] hover:border-[var(--leaf)]"
              type="button"
              onClick={() => setOptions((current) => [...current, { text: '', imageUrl: '' }])}
            >Add option</button>
            <p className="rounded-lg bg-[#f0f3eb] px-3 py-2 text-xs leading-5 text-[var(--muted)]">Each option needs text, an image, or both. For Google Drive, allow anyone with the link to view the image.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-4">
            <button className="min-h-11 rounded-lg bg-[var(--forest)] px-5 text-sm font-bold text-white shadow-sm hover:bg-[var(--leaf)] disabled:opacity-50" type="submit" disabled={pollBusy}>
              {pollBusy ? 'Creating...' : 'Create poll'}
            </button>
            {pollMessage && <p className="text-sm font-medium text-[var(--leaf)]" role="status">{pollMessage}</p>}
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[0_14px_36px_rgba(29,48,41,0.045)] sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl font-semibold">Polls</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">All society polls, including closed and deleted polls.</p>
          </div>
          <button
            className="min-h-10 rounded-lg border border-[var(--line)] bg-white px-3 text-sm font-semibold text-[var(--ink)] hover:border-[var(--leaf)] disabled:opacity-50"
            type="button"
            disabled={pollsLoading}
            onClick={() => void loadPolls()}
          >
            {pollsLoading ? 'Refreshing...' : 'Refresh list'}
          </button>
        </div>

        {pollsError ? (
          <p className="rounded-lg border border-[#e9c4b8] bg-[#fff4ef] px-4 py-3 text-sm text-[#8e422d]" role="alert">{pollsError}</p>
        ) : pollsLoading ? (
          <p className="py-4 text-sm text-[#667064]" role="status">Loading polls...</p>
        ) : polls.length === 0 ? (
          <p className="py-4 text-sm text-[#667064]">No polls have been created yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] bg-[#edf1e8] text-[10px] uppercase text-[var(--muted)]">
                  <th className="px-3 py-3 pr-4 font-bold sm:px-4">Poll</th>
                  <th className="py-3 pr-4 font-bold">Method</th>
                  <th className="py-3 pr-4 font-bold">Restriction</th>
                  <th className="py-3 pr-4 font-bold">Deadline (IST)</th>
                  <th className="py-3 pr-3 font-bold">Status</th>
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
                    <tr className="border-b border-[var(--line)] last:border-0 even:bg-[#f7f8f3]" key={poll.id}>
                      <td className="px-3 py-3 pr-4 font-semibold sm:px-4">{poll.title}</td>
                      <td className="py-3 pr-4">{poll.poll_type === 'ranked_choice' ? 'Ranked choice' : 'Single choice'}</td>
                      <td className="py-3 pr-4">{restrictionLabels[poll.restriction] ?? poll.restriction}</td>
                      <td className="py-3 pr-4 whitespace-nowrap">{formatDeadlineIST(poll.deadline)}</td>
                      <td className="py-3">
                        <span className={status === 'Open' ? 'inline-flex rounded-full bg-[#e4efdf] px-2.5 py-1 text-xs font-bold text-[var(--leaf)]' : 'inline-flex rounded-full bg-[#edf0eb] px-2.5 py-1 text-xs font-semibold text-[var(--muted)]'}>{status}</span>
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