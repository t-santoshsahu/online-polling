import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import { formatDeadlineIST, hasDeadlinePassed } from '../../lib/time'
import { getSupabaseClient } from '../../supabaseClient.js'
import PollResults from '../polls/PollResults.jsx'

function moveItem(items, index, offset) {
  const targetIndex = index + offset
  if (targetIndex < 0 || targetIndex >= items.length) return items
  const reordered = [...items]
  ;[reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]]
  return reordered
}

export default function VotingDashboard() {
  const { user } = useAuth()
  const [polls, setPolls] = useState([])
  const [optionsByPoll, setOptionsByPoll] = useState({})
  const [statuses, setStatuses] = useState({})
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
        .select('id, title, description, poll_type, restriction, deadline')
        .eq('is_deleted', false)
        .gt('deadline', new Date().toISOString())
        .order('deadline', { ascending: true })
      if (pollsError) throw pollsError
      setError('')

      const pollIds = (activePolls ?? []).map((poll) => poll.id)
      if (!pollIds.length) {
        setPolls([])
        setOptionsByPoll({})
        setStatuses({})
        return
      }

      const [optionsResult, statusResult] = await Promise.all([
        supabase
          .from('poll_options')
          .select('id, poll_id, option_text, image_url, display_order')
          .in('poll_id', pollIds)
          .order('display_order', { ascending: true }),
        supabase.rpc('get_my_poll_vote_status', { p_poll_ids: pollIds }),
      ])
      if (optionsResult.error) throw optionsResult.error
      if (statusResult.error) throw statusResult.error

      const groupedOptions = {}
      for (const option of optionsResult.data ?? []) {
        groupedOptions[option.poll_id] ??= []
        groupedOptions[option.poll_id].push(option)
      }
      const statusMap = Object.fromEntries(
        (statusResult.data ?? []).map((status) => [status.poll_id, status]),
      )

      setPolls(activePolls ?? [])
      setOptionsByPoll(groupedOptions)
      setStatuses(statusMap)
      setRankedOptions((previous) => {
        const next = { ...previous }
        for (const poll of activePolls ?? []) {
          next[poll.id] ??= (groupedOptions[poll.id] ?? []).map((option) => option.id)
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
      : (rankedOptions[poll.id] ?? []).filter((id) => pollOptions.some((option) => option.id === id))

    if (!optionIds.length) {
      setNotice('Choose at least one option before submitting.')
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
      setNotice('Your ballot has been recorded.')
    } catch (submitError) {
      setNotice(submitError instanceof Error ? submitError.message : 'Your ballot could not be submitted.')
      void loadPolls()
    } finally {
      setBusyPollId(null)
    }
  }

  return (
    <div className="space-y-6">
      <header className="border-b border-[#d9ded5] pb-5">
        <h1 className="text-2xl font-semibold">Open polls</h1>
        <p className="mt-1 text-sm text-[#667064]">Your flat eligibility is checked securely before ballot submission.</p>
      </header>

      {error && <p className="border-l-4 border-[#a84435] bg-[#fff4f1] px-4 py-3 text-sm text-[#7b2f25]" role="alert">{error}</p>}
      {notice && <p className="border-l-4 border-[#527247] bg-white px-4 py-3 text-sm" role="status">{notice}</p>}

      {loading ? (
        <p className="py-8 text-sm text-[#667064]" role="status">Loading polls...</p>
      ) : polls.length === 0 ? (
        <p className="py-8 text-sm text-[#667064]">There are no open polls right now.</p>
      ) : (
        <div className="divide-y divide-[#d9ded5]">
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
              <article className="py-6 first:pt-0" key={poll.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{poll.title}</h2>
                    {poll.description && <p className="mt-1 max-w-3xl text-sm leading-6 text-[#596257]">{poll.description}</p>}
                    <p className="mt-2 text-xs font-medium text-[#667064]">Closes {formatDeadlineIST(poll.deadline)} IST</p>
                  </div>
                  <span className="border border-[#d9ded5] px-2 py-1 text-xs text-[#596257]">
                    {poll.poll_type === 'ranked_choice' ? 'Ranked choice' : 'Single choice'}
                  </span>
                </div>

                <PollResults pollId={poll.id} pollType={poll.poll_type} />

                {status?.has_voted ? (
                  <p className="mt-4 text-sm font-medium text-[#355f3a]">Your flat has already voted in this poll.</p>
                ) : !status?.eligible ? (
                  <p className="mt-4 text-sm text-[#667064]">This poll is not available for your resident category or flat.</p>
                ) : (
                  <div className="mt-4 max-w-2xl">
                    {poll.poll_type === 'single_choice' ? (
                      <fieldset className="grid gap-2">
                        <legend className="mb-1 text-sm font-medium">Select one option</legend>
                        {pollOptions.map((option) => (
                          <label className="flex cursor-pointer items-center gap-3 border border-[#d9ded5] bg-white px-3 py-3 text-sm hover:border-[#8da185]" key={option.id}>
                            <input
                              type="radio"
                              name={`poll-${poll.id}`}
                              value={option.id}
                              checked={selectedOptions[poll.id] === option.id}
                              disabled={disabled}
                              onChange={() => setSelectedOptions((current) => ({ ...current, [poll.id]: option.id }))}
                            />
                            {option.image_url && <img className="size-12 object-cover" src={option.image_url} alt="" />}
                            <span>{option.option_text}</span>
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      <fieldset className="grid gap-2">
                        <legend className="mb-1 text-sm font-medium">Order options from first choice downward</legend>
                        {orderedOptions.map((option, index) => (
                          <div className="flex items-center gap-3 border border-[#d9ded5] bg-white px-3 py-2" key={option.id}>
                            <span className="grid size-7 shrink-0 place-items-center bg-[#eaf0e6] text-sm font-semibold text-[#355f3a]">{index + 1}</span>
                            {option.image_url && <img className="size-12 object-cover" src={option.image_url} alt="" />}
                            <span className="min-w-0 flex-1 text-sm">{option.option_text}</span>
                            <button
                              className="border border-[#cbd3c6] px-2 py-1 text-xs disabled:opacity-40"
                              type="button"
                              disabled={disabled || index === 0}
                              aria-label={`Move ${option.option_text} up`}
                              onClick={() => setRankedOptions((current) => ({ ...current, [poll.id]: moveItem(orderedIds, index, -1) }))}
                            >Move up</button>
                            <button
                              className="border border-[#cbd3c6] px-2 py-1 text-xs disabled:opacity-40"
                              type="button"
                              disabled={disabled || index === orderedOptions.length - 1}
                              aria-label={`Move ${option.option_text} down`}
                              onClick={() => setRankedOptions((current) => ({ ...current, [poll.id]: moveItem(orderedIds, index, 1) }))}
                            >Move down</button>
                          </div>
                        ))}
                      </fieldset>
                    )}
                    <button
                      className="mt-4 min-h-10 bg-[#355f3a] px-4 text-sm font-semibold text-white hover:bg-[#294b2e] disabled:cursor-not-allowed disabled:opacity-50"
                      type="button"
                      disabled={disabled || pollOptions.length < 2}
                      onClick={() => void submitBallot(poll)}
                    >
                      {busyPollId === poll.id ? 'Submitting...' : 'Submit ballot'}
                    </button>
                    {expired && <p className="mt-2 text-sm text-[#a84435]">This poll has closed.</p>}
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