import { useEffect, useRef, useState, type FormEvent } from 'react'
import AdminDashboard from './features/admin/AdminDashboard.jsx'
import VotingDashboard from './features/voting/VotingDashboard.jsx'
import { useAuth } from './contexts/useAuth'
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabase'

function App() {
  const { user, loading: authLoading, requestOtp, verifyOtp, signOut } = useAuth()
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [profile, setProfile] = useState<{ userId: string | null; role: string | null }>({ userId: null, role: null })
  const [view, setView] = useState('voting')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const profileLinkRequests = useRef(new Map<string, Promise<string>>())

  function linkMyUserProfile(userId: string): Promise<string> {
    const pendingRequest = profileLinkRequests.current.get(userId)
    if (pendingRequest) return pendingRequest

    const request = Promise.resolve(
      getSupabaseClient().rpc('link_my_user_profile'),
    )
      .then(({ data, error }) => {
        if (error) throw error
        const role = typeof data === 'string' ? data.trim().toLowerCase() : ''
        if (role !== 'admin' && role !== 'regular') {
          throw new Error(
            `Profile link returned role ${JSON.stringify(data)}; expected "admin" or "regular".`,
          )
        }
        return role
      })
      .finally(() => profileLinkRequests.current.delete(userId))

    profileLinkRequests.current.set(userId, request)
    return request
  }

  useEffect(() => {
    if (!user || profile.userId === user.id) {
      return
    }

    let active = true
    void linkMyUserProfile(user.id)
      .then((role) => {
        if (!active) return
        setProfile({ userId: user.id, role })
      })
      .catch((error: unknown) => {
        if (!active) return
        setProfile({ userId: user.id, role: null })
        setMessage(error instanceof Error ? error.message : 'Could not load your resident profile.')
      })

    return () => { active = false }
  }, [user, profile.userId])

  async function handleRequestOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      await requestOtp(email)
      setOtpSent(true)
      setMessage('A sign-in code has been sent to your registered email.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not send the sign-in code.')
    } finally {
      setBusy(false)
    }
  }

  const profileLoading = Boolean(user && profile.userId !== user.id)
  const profileRole = profile.userId === user?.id ? profile.role : null

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      await verifyOtp(email, otp)
    } catch (error) {
      setMessage(error instanceof Error ? `Invalid or expired code: ${error.message}` : 'Invalid or expired code.')
      setBusy(false)
      return
    }

    try {
      const { data, error } = await getSupabaseClient().auth.getSession()
      if (error) throw error
      if (!data.session) throw new Error('Verification succeeded, but no session was created.')

      const role = await linkMyUserProfile(data.session.user.id)
      setProfile({ userId: data.session.user.id, role })
    } catch (error) {
      setMessage(error instanceof Error
        ? `OTP verified, but your resident profile could not be linked: ${error.message}`
        : 'OTP verified, but your resident profile could not be linked.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSignOut() {
    setMessage('')
    try {
      await signOut()
      setOtpSent(false)
      setOtp('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sign out failed.')
    }
  }

  return (
    <main className="min-h-screen text-[var(--ink)]">
      <header className="relative z-10 border-b border-white/10 bg-[var(--forest)] text-white shadow-[0_8px_24px_rgba(29,48,41,0.12)]">
        <div className="mx-auto flex min-h-[72px] max-w-[1440px] flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-8 lg:px-12">
          <a className="group flex items-center gap-3" href="/">
            <span className="grid size-10 place-items-center rounded-xl bg-[var(--citrus)] text-sm font-black text-[var(--forest)] shadow-inner">SP</span>
            <span className="grid leading-tight">
              <span className="text-base font-semibold tracking-normal">Society Polling</span>
              <span className="mt-0.5 text-[10px] font-medium uppercase text-white/55">Community decisions</span>
            </span>
          </a>
          {user ? (
            <div className="flex items-center gap-3 sm:gap-5">
              <span className="hidden rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/75 sm:inline">{user.email}</span>
              <button className="rounded-lg border border-white/20 px-3 py-2 text-sm font-semibold text-white hover:border-[var(--citrus)] hover:text-[var(--citrus)]" type="button" onClick={() => void handleSignOut()}>
                Sign out
              </button>
            </div>
          ) : <span className="flex items-center gap-2 text-xs font-medium text-white/65"><span className="size-2 rounded-full bg-[var(--citrus)]" /> Resident access</span>}
        </div>
      </header>

      {!isSupabaseConfigured ? (
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
          <p className="text-xs font-bold uppercase text-[var(--coral)]">Setup required</p>
          <h1 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">Community voting</h1>
          <p className="mt-4 max-w-xl text-[var(--muted)]">Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your local environment to enable sign-in.</p>
        </section>
      ) : authLoading || profileLoading ? (
        <section className="mx-auto flex min-h-[60vh] max-w-6xl items-center px-5 py-12 text-sm text-[var(--muted)] sm:px-8" role="status">
          <span className="mr-3 size-2 animate-pulse rounded-full bg-[var(--leaf)]" />Checking your session...
        </section>
      ) : user && profileRole ? (
        <section className="rise-in mx-auto max-w-[1440px] px-5 py-7 sm:px-8 lg:px-12 lg:py-10">
          {profileRole === 'admin' && (
            <nav className="mb-8 inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-[var(--line)] bg-white/75 p-1 shadow-sm" aria-label="Dashboard views">
              <button className={`whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-semibold ${view === 'voting' ? 'bg-[var(--forest)] text-white shadow-sm' : 'text-[var(--muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]'}`} type="button" onClick={() => setView('voting')}>Open polls</button>
              <button className={`whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-semibold ${view === 'admin' ? 'bg-[var(--forest)] text-white shadow-sm' : 'text-[var(--muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]'}`} type="button" onClick={() => setView('admin')}>Administration</button>
            </nav>
          )}
          {view === 'admin' && profileRole === 'admin' ? <AdminDashboard /> : <VotingDashboard />}
          {message && <p className="mt-5 rounded-lg border border-[#e9c4b8] bg-[#fff4ef] px-4 py-3 text-sm text-[#8e422d]" role="alert">{message}</p>}
        </section>
      ) : user ? (
        <section className="rise-in mx-auto max-w-3xl px-5 py-16 sm:px-8">
          <div className="border-l-4 border-[var(--coral)] bg-white p-6 shadow-[0_12px_30px_rgba(29,48,41,0.06)] sm:p-8">
            <p className="text-xs font-bold uppercase text-[var(--coral)]">Profile required</p>
            <h1 className="mt-2 font-serif text-2xl font-semibold sm:text-3xl">Account not registered</h1>
            <p className="mt-3 text-sm leading-6 text-[var(--muted)]">Your email has no linked resident profile. Contact a society administrator.</p>
            {message && <p className="mt-4 rounded-lg bg-[#fff4ef] px-4 py-3 text-sm text-[#8e422d]" role="alert">{message}</p>}
          </div>
        </section>
      ) : (
        <section className="mx-auto grid min-h-[calc(100svh-72px)] max-w-[1440px] items-center gap-5 px-4 py-4 sm:gap-8 sm:px-8 sm:py-8 md:grid-cols-[1fr_0.88fr] md:gap-8 lg:gap-12 lg:px-12 lg:py-10">
          <div className="rise-in relative flex min-h-[300px] flex-col justify-between overflow-hidden rounded-2xl bg-[var(--forest)] p-5 text-white shadow-[0_24px_70px_rgba(27,69,57,0.18)] sm:p-10 md:min-h-[440px] md:p-8 lg:min-h-[590px] lg:p-12">
            <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'linear-gradient(135deg, transparent 48%, rgba(213,227,106,.18) 48.2%, transparent 48.6%), linear-gradient(45deg, transparent 72%, rgba(255,255,255,.1) 72.2%, transparent 72.5%)' }} />
            <div className="relative">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-[10px] font-bold uppercase text-[var(--citrus)]">
                <span className="size-1.5 rounded-full bg-[var(--citrus)]" /> Your community, your voice
              </span>
              <h1 className="mt-5 max-w-2xl font-serif text-[2rem] font-medium leading-[1.08] sm:mt-8 sm:text-5xl md:mt-6 md:text-4xl lg:mt-8 lg:text-6xl">
                Decisions are better when everyone has a say.
              </h1>
              <p className="mt-3 max-w-lg text-[13px] leading-5 text-white/70 sm:mt-5 sm:text-base sm:leading-7 md:mt-4 md:text-sm lg:mt-5 lg:text-base">
                A secure place for residents to take part in society polls and shared decisions.
              </p>
            </div>
            <div className="relative mt-6 flex items-end justify-between gap-4 border-t border-white/15 pt-4 sm:mt-10 sm:pt-5">
              <p className="text-[11px] leading-4 text-white/55 sm:text-xs sm:leading-5">Private access for registered society members</p>
              <span className="font-serif text-4xl leading-none text-[var(--citrus)] sm:text-5xl">01</span>
            </div>
          </div>

          <form className="rise-in flex flex-col justify-center px-3 py-3 sm:px-8 sm:py-5 md:px-2 lg:px-10" onSubmit={otpSent ? handleVerifyOtp : handleRequestOtp}>
            <div className="mb-5 sm:mb-8">
              <p className="text-xs font-bold uppercase text-[var(--coral)]">Member sign in</p>
              <h2 className="mt-2 font-serif text-3xl font-semibold sm:text-4xl">Welcome back.</h2>
              <p className="mt-2 text-sm leading-5 text-[var(--muted)] sm:mt-3 sm:leading-6">Use your registered email to access society polls.</p>
            </div>
            <label className="grid gap-2 text-sm font-semibold" htmlFor="email">Registered email
              <input className="min-h-12 rounded-lg border border-[var(--line)] bg-white px-4 font-normal shadow-sm outline-none transition focus:border-[var(--leaf)] focus:ring-4 focus:ring-[var(--leaf)]/10 disabled:bg-[#ecefe8]" id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={otpSent} placeholder="name@example.com" />
            </label>
            {otpSent && <label className="mt-4 grid gap-2 text-sm font-semibold" htmlFor="otp">Email code
              <input className="min-h-12 rounded-lg border border-[var(--line)] bg-white px-4 font-normal tracking-[0.16em] shadow-sm outline-none transition focus:border-[var(--leaf)] focus:ring-4 focus:ring-[var(--leaf)]/10" id="otp" type="text" inputMode="numeric" autoComplete="one-time-code" required value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))} placeholder="Enter your code" />
            </label>}
            <button className="mt-5 flex min-h-12 items-center justify-center gap-3 rounded-lg bg-[var(--forest)] px-5 text-sm font-bold text-white shadow-[0_8px_18px_rgba(27,69,57,0.16)] hover:bg-[var(--leaf)] disabled:opacity-55" type="submit" disabled={busy}>
              {busy ? 'Please wait...' : otpSent ? 'Verify & sign in' : 'Send sign-in code'}
              {!busy && <span aria-hidden="true">→</span>}
            </button>
            {otpSent && <button className="mt-4 self-start text-sm font-semibold text-[var(--leaf)] hover:text-[var(--forest)] hover:underline" type="button" onClick={() => { setOtpSent(false); setOtp(''); setMessage('') }}>Use a different email</button>}
            {message && <p className="mt-4 rounded-lg border border-[var(--line)] bg-white px-4 py-3 text-sm leading-5 text-[var(--muted)]" role="status">{message}</p>}
            <p className="mt-5 border-t border-[var(--line)] pt-3 text-xs leading-5 text-[var(--muted)] sm:mt-8 sm:pt-4">Only emails registered with your housing society can sign in.</p>
          </form>
        </section>
      )}
    </main>
  )
}

export default App
