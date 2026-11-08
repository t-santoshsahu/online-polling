import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { getSupabaseClient, isSupabaseConfigured } from '../supabaseClient.js'
import { AuthContext, type AuthContextValue } from './context'

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000
const SESSION_STARTED_AT_KEY = 'society-polling.auth.session-started-at'

function readSessionStartedAt(): number | null {
  try {
    const storedValue = Number(window.localStorage.getItem(SESSION_STARTED_AT_KEY))
    if (!Number.isFinite(storedValue) || storedValue <= 0 || storedValue > Date.now()) {
      return null
    }
    return storedValue
  } catch {
    return null
  }
}

function writeSessionStartedAt(timestamp: number): void {
  try {
    window.localStorage.setItem(SESSION_STARTED_AT_KEY, String(timestamp))
  } catch {
    // The in-memory timer still enforces the limit for this page session.
  }
}

function clearSessionStartedAt(): void {
  try {
    window.localStorage.removeItem(SESSION_STARTED_AT_KEY)
  } catch {
    // Continue clearing the in-memory session if storage is unavailable.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(isSupabaseConfigured)
  const sessionStartedAtRef = useRef<number | null>(null)
  const activeUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return
    }

    const { data: { subscription } } = getSupabaseClient().auth.onAuthStateChange(
      (event, nextSession) => {
        if (!nextSession) {
          sessionStartedAtRef.current = null
          activeUserIdRef.current = null
          clearSessionStartedAt()
          setSession(null)
          setLoading(false)
          return
        }

        const isNewSignIn =
          event === 'SIGNED_IN' && activeUserIdRef.current !== nextSession.user.id
        const sessionStartedAt = isNewSignIn
          ? Date.now()
          : readSessionStartedAt() ?? sessionStartedAtRef.current ?? Date.now()

        sessionStartedAtRef.current = sessionStartedAt
        activeUserIdRef.current = nextSession.user.id
        writeSessionStartedAt(sessionStartedAt)
        setSession(nextSession)
        setLoading(false)
      },
    )

    return () => subscription.unsubscribe()
  }, [])

  const signOut = useCallback(async () => {
    try {
      const { error } = await getSupabaseClient().auth.signOut({ scope: 'local' })
      if (error) throw error
    } finally {
      sessionStartedAtRef.current = null
      activeUserIdRef.current = null
      clearSessionStartedAt()
      setSession(null)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!session || sessionStartedAtRef.current === null) return

    const expiresAt = sessionStartedAtRef.current + MAX_SESSION_AGE_MS
    const remainingTime = expiresAt - Date.now()
    if (remainingTime <= 0) {
      void signOut().catch(() => undefined)
      return
    }

    const timeoutId = window.setTimeout(() => {
      void signOut().catch(() => undefined)
    }, remainingTime)

    return () => window.clearTimeout(timeoutId)
  }, [session, signOut])

  const requestOtp = useCallback(async (email: string) => {
    const { error } = await getSupabaseClient().auth.signInWithOtp({
      email: email.trim().toLowerCase(),
    })
    if (error) throw error
  }, [])

  const verifyOtp = useCallback(async (email: string, token: string) => {
    const { error } = await getSupabaseClient().auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: token.trim(),
      type: 'email',
    })
    if (error) throw error
  }, [])

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    loading,
    requestOtp,
    verifyOtp,
    signOut,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}