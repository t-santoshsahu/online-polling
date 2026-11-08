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
    <main className="min-h-screen bg-[#f6f7f2] text-[#20251f]">
      <header className="border-b border-[#d9ded5] bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-8">
          <a className="text-lg font-semibold tracking-normal" href="/">
            Society Polling
          </a>
          {user ? (
            <div className="flex items-center gap-4">
              <span className="hidden text-sm text-[#667064] sm:inline">{user.email}</span>
              <button className="text-sm font-semibold text-[#355f3a] hover:underline" type="button" onClick={() => void handleSignOut()}>
                Sign out
              </button>
            </div>
          ) : <span className="text-sm text-[#667064]">Resident voting</span>}
        </div>
      </header>

      {!isSupabaseConfigured ? (
        <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
          <h1 className="text-3xl font-semibold">Community voting</h1>
          <p className="mt-3 max-w-xl text-[#596257]">Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your local environment to enable sign-in.</p>
        </section>
      ) : authLoading || profileLoading ? (
        <section className="mx-auto max-w-6xl px-5 py-12 text-sm text-[#667064] sm:px-8" role="status">Checking your session...</section>
      ) : user && profileRole ? (
        <section className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
          {profileRole === 'admin' && (
            <nav className="mb-8 flex gap-1 border-b border-[#d9ded5]" aria-label="Dashboard views">
              <button className={`border-b-2 px-4 py-3 text-sm font-semibold ${view === 'voting' ? 'border-[#527247] text-[#355f3a]' : 'border-transparent text-[#667064]'}`} type="button" onClick={() => setView('voting')}>Open polls</button>
              <button className={`border-b-2 px-4 py-3 text-sm font-semibold ${view === 'admin' ? 'border-[#527247] text-[#355f3a]' : 'border-transparent text-[#667064]'}`} type="button" onClick={() => setView('admin')}>Administration</button>
            </nav>
          )}
          {view === 'admin' && profileRole === 'admin' ? <AdminDashboard /> : <VotingDashboard />}
          {message && <p className="mt-4 text-sm text-[#a84435]" role="alert">{message}</p>}
        </section>
      ) : user ? (
        <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
          <h1 className="text-2xl font-semibold">Account not registered</h1>
          <p className="mt-2 text-sm text-[#596257]">Your email has no linked resident profile. Contact a society administrator.</p>
          {message && <p className="mt-3 text-sm text-[#a84435]" role="alert">{message}</p>}
        </section>
      ) : (
        <section className="mx-auto grid min-h-[calc(100vh-73px)] max-w-6xl content-center gap-10 px-5 py-12 sm:px-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#527247]">Housing society elections and decisions</p>
            <h1 className="max-w-2xl text-4xl font-semibold leading-tight sm:text-5xl">A clear place for every community vote.</h1>
            <p className="mt-5 max-w-xl text-lg leading-7 text-[#596257]">Sign in with your registered email to take part in polls for your society.</p>
          </div>
          <form className="grid gap-4 border-l-4 border-[#527247] bg-white p-6 shadow-sm sm:p-8" onSubmit={otpSent ? handleVerifyOtp : handleRequestOtp}>
            <h2 className="text-xl font-semibold">Resident sign in</h2>
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="email">Registered email
              <input className="border border-[#cbd3c6] px-3 py-2 font-normal outline-none focus:border-[#527247] focus:ring-2 focus:ring-[#527247]/20" id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={otpSent} />
            </label>
            {otpSent && <label className="grid gap-1.5 text-sm font-medium" htmlFor="otp">Email code
              <input className="border border-[#cbd3c6] px-3 py-2 font-normal outline-none focus:border-[#527247] focus:ring-2 focus:ring-[#527247]/20" id="otp" type="text" inputMode="numeric" autoComplete="one-time-code" required value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))} />
            </label>}
            <button className="min-h-10 bg-[#355f3a] px-4 text-sm font-semibold text-white hover:bg-[#294b2e] disabled:opacity-50" type="submit" disabled={busy}>
              {busy ? 'Please wait...' : otpSent ? 'Verify & Login' : 'Send Code'}
            </button>
            {otpSent && <button className="justify-self-start text-sm font-medium text-[#355f3a] hover:underline" type="button" onClick={() => { setOtpSent(false); setOtp(''); setMessage('') }}>Use a different email</button>}
            {message && <p className="text-sm text-[#596257]" role="status">{message}</p>}
          </form>
        </section>
      )}
    </main>
  )
}

export default App
