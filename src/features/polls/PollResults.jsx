import { useCallback, useEffect, useState } from 'react'
import { getSupabaseClient } from '../../supabaseClient.js'
import ImageLightbox from './ImageLightbox.jsx'

function formatPercent(value) {
  return `${value.toFixed(1)}%`
}

export default function PollResults({ pollId, pollType, resultVisibility = 'always', canViewResults, hasPersonVoted, isClosed }) {
  const [results, setResults] = useState([])
  const [totalBallots, setTotalBallots] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshResults = useCallback(async () => {
    try {
      const { data, error: resultError } = await getSupabaseClient()
        .rpc('get_poll_results', { p_poll_id: pollId })
      if (resultError) throw resultError

      const { data: options, error: optionsError } = await getSupabaseClient()
        .from('poll_options')
        .select('id, image_urls')
        .eq('poll_id', pollId)
      if (optionsError) throw optionsError
      const galleries = new Map((options ?? []).map((option) => [option.id, option.image_urls]))
      const rows = (data ?? []).map((option) => ({ ...option, image_urls: galleries.get(option.option_id) }))
      setResults(rows)
      setTotalBallots(Number(rows[0]?.total_ballots ?? 0))
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load poll results.')
    } finally {
      setLoading(false)
    }
  }, [pollId])

  useEffect(() => {
    if (!canViewResults) return undefined

    const supabase = getSupabaseClient()
    let refreshTimer
    let channel
    let cancelled = false

    async function subscribeToChanges() {
      await supabase.realtime.setAuth()
      if (cancelled) return

      channel = supabase
        .channel(`poll-results:${pollId}`, { config: { private: true } })
        .on('broadcast', { event: 'poll_results_changed' }, () => {
          window.clearTimeout(refreshTimer)
          refreshTimer = window.setTimeout(() => void refreshResults(), 150)
        })
        .subscribe()
    }

    void subscribeToChanges()

    const initialLoadTimer = window.setTimeout(() => void refreshResults(), 0)
    return () => {
      cancelled = true
      window.clearTimeout(initialLoadTimer)
      window.clearTimeout(refreshTimer)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [pollId, refreshResults, canViewResults])

  const rankedResults = [...results].sort((left, right) => {
    const scoreDifference = Number(right.borda_score) - Number(left.borda_score)
    return scoreDifference || left.display_order - right.display_order
  })

  return (
    <section className="mt-5 border-t border-[var(--line)] pt-4" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-[var(--ink)]">Live results</h3>
        <p className="rounded-full bg-[#edf1e8] px-2.5 py-1 text-[10px] font-bold uppercase text-[var(--leaf)]">
          {totalBallots} {totalBallots === 1 ? 'vote' : 'votes'}
        </p>
      </div>

      {!canViewResults ? (
        <p className="mt-3 rounded-lg bg-[#f0f3eb] px-3 py-2 text-sm text-[var(--muted)]">
          {resultVisibility === 'after_vote' && !hasPersonVoted
            ? 'Results will be visible after you submit your vote.'
            : resultVisibility === 'after_close' && !isClosed
              ? 'Results will be visible after voting closes.'
              : 'Results are not available for your account.'}
        </p>
      ) : loading ? (
        <p className="mt-3 text-sm text-[var(--muted)]" role="status">Loading results...</p>
      ) : error ? (
        <p className="mt-3 rounded-lg bg-[#fff4ef] px-3 py-2 text-sm text-[#8e422d]" role="alert">{error}</p>
      ) : pollType === 'ranked_choice' ? (
        <ol className="mt-3 divide-y divide-[var(--line)]">
          {rankedResults.map((option, index) => (
            <li className="flex items-center justify-between gap-3 py-2.5 text-sm" key={option.option_id}>
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--forest)] text-xs font-bold text-white">{index + 1}</span>
                {option.image_url && <ImageLightbox className="size-10 rounded-lg bg-[#edf1e8]" src={option.image_url} images={option.image_urls} alt={option.option_text || `Option ${index + 1}`} />}
                <span className="truncate">{option.option_text || `Image option ${index + 1}`}</span>
              </span>
              <span className="shrink-0 rounded-md bg-[#f0f3eb] px-2 py-1 text-xs font-bold tabular-nums text-[var(--leaf)]">{option.borda_score} pts</span>
            </li>
          ))}
          {rankedResults.length === 0 && <li className="py-3 text-sm text-[var(--muted)]">No ranked votes yet.</li>}
        </ol>
      ) : (
        <ul className="mt-3 grid gap-3">
          {results.map((option) => {
            const votes = Number(option.single_votes)
            const percentage = totalBallots ? (votes / totalBallots) * 100 : 0
            return (
              <li className="min-w-0" key={option.option_id}>
                <div className="mb-1 flex justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2.5">
                    {option.image_url && <ImageLightbox className="size-10 rounded-lg bg-[#edf1e8]" src={option.image_url} images={option.image_urls} alt={option.option_text || 'Poll option image'} />}
                    <span className="truncate font-medium">{option.option_text || `Image option ${option.display_order}`}</span>
                  </span>
                  <span className="shrink-0 text-xs font-bold tabular-nums text-[var(--muted)]">{formatPercent(percentage)} · {votes}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[#e4e9df]" role="meter" aria-label={`${option.option_text || `Image option ${option.display_order}`} vote share`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
                  <div className="h-full rounded-full bg-[var(--leaf)] transition-[width] duration-300" style={{ width: `${percentage}%` }} />
                </div>
              </li>
            )
          })}
          {results.length === 0 && <li className="text-sm text-[var(--muted)]">No votes yet.</li>}
        </ul>
      )}
    </section>
  )
}