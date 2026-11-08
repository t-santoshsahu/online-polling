import { useCallback, useEffect, useState } from 'react'
import { getSupabaseClient } from '../../supabaseClient.js'

function formatPercent(value) {
  return `${value.toFixed(1)}%`
}

export default function PollResults({ pollId, pollType }) {
  const [results, setResults] = useState([])
  const [totalBallots, setTotalBallots] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refreshResults = useCallback(async () => {
    try {
      const { data, error: resultError } = await getSupabaseClient()
        .rpc('get_poll_results', { p_poll_id: pollId })
      if (resultError) throw resultError

      const rows = data ?? []
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
  }, [pollId, refreshResults])

  const rankedResults = [...results].sort((left, right) => {
    const scoreDifference = Number(right.borda_score) - Number(left.borda_score)
    return scoreDifference || left.display_order - right.display_order
  })

  return (
    <section className="mt-6 border-t border-[#d9ded5] pt-4" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Live results</h3>
        <p className="text-xs text-[#667064]">
          {totalBallots} {totalBallots === 1 ? 'ballot' : 'ballots'}
        </p>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-[#667064]" role="status">Loading results...</p>
      ) : error ? (
        <p className="mt-3 text-sm text-[#a84435]" role="alert">{error}</p>
      ) : pollType === 'ranked_choice' ? (
        <ol className="mt-3 divide-y divide-[#e4e8e1]">
          {rankedResults.map((option, index) => (
            <li className="flex items-center justify-between gap-4 py-2 text-sm" key={option.option_id}>
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-6 shrink-0 place-items-center bg-[#eaf0e6] text-xs font-semibold text-[#355f3a]">{index + 1}</span>
                <span className="truncate">{option.option_text}</span>
              </span>
              <span className="shrink-0 font-medium tabular-nums">{option.borda_score} pts</span>
            </li>
          ))}
          {rankedResults.length === 0 && <li className="py-2 text-sm text-[#667064]">No ranked ballots yet.</li>}
        </ol>
      ) : (
        <ul className="mt-3 grid gap-3">
          {results.map((option) => {
            const votes = Number(option.single_votes)
            const percentage = totalBallots ? (votes / totalBallots) * 100 : 0
            return (
              <li key={option.option_id}>
                <div className="mb-1 flex justify-between gap-3 text-sm">
                  <span className="truncate">{option.option_text}</span>
                  <span className="shrink-0 font-medium tabular-nums">{formatPercent(percentage)} · {votes}</span>
                </div>
                <div className="h-2 overflow-hidden bg-[#e4e8e1]" role="meter" aria-label={`${option.option_text} vote share`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
                  <div className="h-full bg-[#527247] transition-[width] duration-300" style={{ width: `${percentage}%` }} />
                </div>
              </li>
            )
          })}
          {results.length === 0 && <li className="text-sm text-[#667064]">No ballots yet.</li>}
        </ul>
      )}
    </section>
  )
}