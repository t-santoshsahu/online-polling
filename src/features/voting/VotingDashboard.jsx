import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import { formatDeadlineIST, hasDeadlinePassed } from '../../lib/time'
import { getSupabaseClient } from '../../supabaseClient.js'
import ImageLightbox from '../polls/ImageLightbox.jsx'
import PollResults from '../polls/PollResults.jsx'

function moveToPosition(items, index, position) {
  const reordered = [...items]
  const [selectedId] = reordered.splice(index, 1)
  reordered.splice(position - 1, 0, selectedId)
  return reordered
}

export default function VotingDashboard({ isAdmin = false }) {
  const { user } = useAuth()
  const [polls, setPolls] = useState([])
  const [optionsByPoll, setOptionsByPoll] = useState({})
  const [statuses, setStatuses] = useState({})
  const [resultAccess, setResultAccess] = useState({})
  const [selectedOptions, setSelectedOptions] = useState({})
  const [rankedOptions, setRankedOptions] = useState({})
  const [busyPollId, setBusyPollId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [clock, setClock] = useState(null)

  const loadPolls = useCallback(async () => {
    try {
      const supabase = getSupabaseClient()
      const { data: activePolls, error: pollsError } = await supabase
        .from('polls')
        .select('id, title, description, poll_type, restriction, deadline, result_visibility')
        .eq('is_deleted', false)
        .order('deadline', { ascending: true })
      if (pollsError) throw pollsError
      setError('')

      const pollIds = (activePolls ?? []).map((poll) => poll.id)
      if (!pollIds.length) {
        setPolls([])
        setOptionsByPoll({})
        setStatuses({})
        setResultAccess({})
        return
      }

      const [statusResult, resultAccessResult] = await Promise.all([
        supabase.rpc('get_my_poll_vote_status', { p_poll_ids: pollIds }),
        supabase.rpc('get_my_poll_result_status', { p_poll_ids: pollIds }),
      ])
      if (statusResult.error) throw statusResult.error
      if (resultAccessResult.error) throw resultAccessResult.error

      const statusMap = Object.fromEntries(
        (statusResult.data ?? []).map((status) => [status.poll_id, status]),
      )
      const resultAccessMap = Object.fromEntries(
        (resultAccessResult.data ?? []).map((status) => [status.poll_id, status]),
      )
      const now = Date.now()
      const visiblePolls = (activePolls ?? []).filter((poll) => {
        const isOpen = new Date(poll.deadline).getTime() > now
        return isOpen || resultAccessMap[poll.id]?.can_view_results
      })
      const visiblePollIds = visiblePolls.map((poll) => poll.id)
      const optionsResult = visiblePollIds.length
        ? await supabase
          .from('poll_options')
          .select('id, poll_id, option_text, image_url, image_urls, display_order')
          .in('poll_id', visiblePollIds)
          .order('display_order', { ascending: true })
        : { data: [], error: null }
      if (optionsResult.error) throw optionsResult.error

      const groupedOptions = {}
      for (const option of optionsResult.data ?? []) {
        groupedOptions[option.poll_id] ??= []
        groupedOptions[option.poll_id].push(option)
      }

      setPolls(visiblePolls)
      setOptionsByPoll(groupedOptions)
      setStatuses(statusMap)
      setResultAccess(resultAccessMap)
      setRankedOptions((previous) => {
        const next = { ...previous }
        for (const poll of visiblePolls) {
          next[poll.id] ??= []
        }
        return next
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load polls.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadPolls(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [loadPolls, user?.id])

  useEffect(() => {
    const intervalId = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [])

  async function submitBallot(poll) {
    const pollOptions = optionsByPoll[poll.id] ?? []
    const optionIds = poll.poll_type === 'single_choice'
      ? [selectedOptions[poll.id]].filter(Boolean)
      : (rankedOptions[poll.id] ?? []).filter((id) => pollOptions.some((option) => option.id === id)).slice(0, 3)

    if (poll.poll_type === 'ranked_choice' && optionIds.length !== 3) {
      setNotice('Choose exactly three options and set their positions before submitting.')
      return
    }
    if (!optionIds.length) {
      setNotice('Choose an option before submitting.')
      return
    }

    setBusyPollId(poll.id)
    setNotice('')
    try {
      const { error: ballotError } = await getSupabaseClient().rpc('submit_poll_ballot', {
        p_poll_id: poll.id,
        p_option_ids: optionIds,
        p_rank_positions: optionIds.map((_, index) => index + 1),
      })
      if (ballotError) throw ballotError
      setStatuses((current) => ({
        ...current,
        [poll.id]: { eligible: true, has_voted: true },
      }))
      setNotice('Your vote has been recorded.')
    } catch (submitError) {
      setNotice(submitError instanceof Error ? submitError.message : 'Your vote could not be submitted.')
      void loadPolls()
    } finally {
      setBusyPollId(null)
    }
  }

  return (
    <div className="rise-in space-y-6 sm:space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--line)] pb-5">
        <div>
          <p className="text-[10px] font-bold uppercase text-[var(--coral)]">Your community</p>
          <h1 className="mt-1 font-serif text-3xl font-semibold">Open polls</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">Eligibility is checked against your resident categories and the poll's voting rule.</p>
        </div>
        <span className="rounded-full border border-[var(--line)] bg-white/70 px-3 py-1.5 text-xs font-medium text-[var(--muted)]">{polls.length} available</span>
      </header>

      {error && <p className="rounded-lg border border-[#e9c4b8] bg-[#fff4ef] px-4 py-3 text-sm text-[#8e422d]" role="alert">{error}</p>}
      {notice && <p className="rounded-lg border border-[#cbdac1] bg-[#f7faf1] px-4 py-3 text-sm text-[var(--leaf)]" role="status">{notice}</p>}

      {loading ? (
        <p className="rounded-xl border border-[var(--line)] bg-white/70 px-5 py-8 text-sm text-[var(--muted)]" role="status">Loading polls...</p>
      ) : polls.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-white/55 px-5 py-10 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-full bg-[#e8eddf] text-lg text-[var(--leaf)]">—</span>
          <p className="mt-3 font-semibold">No open polls right now</p>
          <p className="mt-1 text-sm text-[var(--muted)]">New society polls will appear here when available.</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {polls.map((poll) => {
            const pollOptions = optionsByPoll[poll.id] ?? []
            const status = statuses[poll.id]
            const expired = clock !== null && hasDeadlinePassed(poll.deadline, new Date(clock))
            const disabled = expired || !status?.eligible || status?.has_voted || busyPollId === poll.id
            const orderedIds = rankedOptions[poll.id] ?? pollOptions.map((option) => option.id)
            const orderedOptions = orderedIds
              .map((id) => pollOptions.find((option) => option.id === id))
              .filter(Boolean)

            return (
              <article className="min-w-0 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 shadow-[0_12px_30px_rgba(29,48,41,0.045)] sm:p-5" key={poll.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-serif text-xl font-semibold text-[var(--ink)]">{poll.title}</h2>
                    {poll.description && <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--muted)]">{poll.description}</p>}
                    <p className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-[var(--muted)]"><span className="size-1.5 rounded-full bg-[var(--coral)]" />Closes {formatDeadlineIST(poll.deadline)} IST</p>
                  </div>
                  <span className="rounded-full bg-[#edf1e8] px-2.5 py-1 text-[10px] font-bold uppercase text-[var(--leaf)]">
                    {poll.poll_type === 'ranked_choice' ? 'Ranked choice' : 'Single choice'}
                  </span>
                </div>

                <PollResults
                  pollId={poll.id}
                  pollType={poll.poll_type}
                  resultVisibility={poll.result_visibility}
                  canViewResults={isAdmin || resultAccess[poll.id]?.can_view_results === true}
                  hasPersonVoted={resultAccess[poll.id]?.has_person_voted === true}
                  isClosed={expired}
                  isAdmin={isAdmin}
                />

                {status?.has_voted ? (
                  <p className="mt-4 rounded-lg bg-[#edf4e9] px-3 py-2 text-sm font-semibold text-[var(--leaf)]">
                    {poll.restriction === 'all_owners_and_residents'
                      ? 'You have already voted in this poll.'
                      : 'Your flat has already voted in this poll.'}
                  </p>
                ) : !status?.eligible ? (
                  <p className="mt-4 rounded-lg bg-[#f0f2ed] px-3 py-2 text-sm text-[var(--muted)]">This poll is not available for your resident category or flat.</p>
                ) : (
                  <div className="mt-4 max-w-2xl">
                    {poll.poll_type === 'single_choice' ? (
                      <fieldset className="grid gap-2">
                        <legend className="mb-1 text-sm font-medium">Select one option</legend>
                        {pollOptions.map((option) => (
                          <div className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-white px-3 py-3 text-sm transition has-[:checked]:border-[var(--leaf)] has-[:checked]:ring-2 has-[:checked]:ring-[var(--leaf)]/10" key={option.id}>
                            <input
                              id={`option-${poll.id}-${option.id}`}
                              type="radio"
                              name={`poll-${poll.id}`}
                              value={option.id}
                              checked={selectedOptions[poll.id] === option.id}
                              disabled={disabled}
                              onChange={() => setSelectedOptions((current) => ({ ...current, [poll.id]: option.id }))}
                            />
                            <label className="min-w-0 flex-1 cursor-pointer font-medium" htmlFor={`option-${poll.id}-${option.id}`}>
                              {option.option_text || `Image option ${option.display_order}`}
                            </label>
                            {option.image_url && <ImageLightbox className="size-24 rounded-lg bg-[#edf1e8] sm:size-28" src={option.image_url} images={option.image_urls} alt={option.option_text || `Option ${option.display_order}`} />}
                          </div>
                        ))}
                      </fieldset>
                    ) : (
                      <fieldset className="grid gap-2">
                        <legend className="mb-1 text-sm font-medium">Choose exactly three and rank them: 1st = 5 pts, 2nd = 3 pts, 3rd = 1 pt</legend>
                        <p className="text-xs text-[var(--muted)]">Selected: {orderedOptions.length} of 3</p>
                        {pollOptions.map((option) => {
                          const selectedIndex = orderedIds.indexOf(option.id)
                          const isSelected = selectedIndex !== -1
                          const label = option.option_text || `Image option ${option.display_order}`
                          return (
                            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 sm:flex-nowrap sm:gap-3" key={option.id}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                disabled={disabled || (!isSelected && orderedIds.length >= 3)}
                                aria-label={`Include ${label} in top three`}
                                onChange={(event) => {
                                  if (event.target.checked && orderedIds.length >= 3) {
                                    setNotice('Ranked votes require exactly three choices.')
                                    return
                                  }
                                  setNotice('')
                                  setRankedOptions((current) => ({
                                    ...current,
                                    [poll.id]: event.target.checked
                                      ? [...(current[poll.id] ?? []), option.id]
                                      : (current[poll.id] ?? []).filter((id) => id !== option.id),
                                  }))
                                }}
                              />
                              {option.image_url && <ImageLightbox className="size-24 rounded-lg bg-[#edf1e8] sm:size-28" src={option.image_url} images={option.image_urls} alt={label} />}
                              <span className="min-w-[7rem] flex-1 text-sm font-medium">{label}</span>
                              {isSelected && (
                                <label className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                                  Position
                                  <select
                                    className="min-h-9 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]"
                                    aria-label={`Position for ${label}`}
                                    value={selectedIndex + 1}
                                    disabled={disabled}
                                    onChange={(event) => setRankedOptions((current) => ({
                                      ...current,
                                      [poll.id]: moveToPosition(current[poll.id] ?? [], selectedIndex, Number(event.target.value)),
                                    }))}
                                  >
                                    {[1, 2, 3].map((position) => <option key={position} value={position}>{position}</option>)}
                                  </select>
                                </label>
                              )}
                            </div>
                          )
                        })}
                      </fieldset>
                    )}
                    <button
                      className="mt-4 min-h-11 w-full rounded-lg bg-[var(--forest)] px-4 text-sm font-bold text-white shadow-sm hover:bg-[var(--leaf)] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      type="button"
                      disabled={disabled || (poll.poll_type === 'ranked_choice' ? orderedOptions.length !== 3 : pollOptions.length < 2)}
                      onClick={() => void submitBallot(poll)}
                    >
                      {busyPollId === poll.id ? 'Submitting...' : 'Submit vote'}
                    </button>
                    {expired && <p className="mt-2 text-sm font-medium text-[var(--coral)]">This poll has closed.</p>}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}