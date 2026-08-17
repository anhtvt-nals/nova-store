import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

const sessionStartedAtKey = 'nodenesia-session-started-at';
const configuredSessionDays = Number(import.meta.env.VITE_SESSION_MAX_AGE_DAYS || 3);
const sessionMaxAgeMs = (Number.isFinite(configuredSessionDays) ? Math.max(1, Math.min(configuredSessionDays, 30)) : 3) * 24 * 60 * 60 * 1000;

function sessionIsExpired() {
  const startedAt = Number(window.localStorage.getItem(sessionStartedAtKey));
  return Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt >= sessionMaxAgeMs;
}

function rememberSessionStart() {
  if (!window.localStorage.getItem(sessionStartedAtKey)) window.localStorage.setItem(sessionStartedAtKey, String(Date.now()));
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    const clearLocalSession = async () => {
      window.localStorage.removeItem(sessionStartedAtKey);
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      if (!disposed) { setSession(null); setLoading(false); }
    };
    const restore = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session && sessionIsExpired()) { await clearLocalSession(); return; }
      if (data.session) rememberSessionStart();
      if (!disposed) { setSession(data.session); setLoading(false); }
    };
    void restore();
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!nextSession) window.localStorage.removeItem(sessionStartedAtKey);
      else if (event === 'SIGNED_IN') window.localStorage.setItem(sessionStartedAtKey, String(Date.now()));
      if (nextSession && sessionIsExpired()) { void clearLocalSession(); return; }
      if (!disposed) { setSession(nextSession); setLoading(false); }
    });
    const onInvalidSession = () => { void clearLocalSession(); };
    window.addEventListener('nodenesia:session-invalid', onInvalidSession);
    return () => { disposed = true; data.subscription.unsubscribe(); window.removeEventListener('nodenesia:session-invalid', onInvalidSession); };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    user: session?.user ?? null,
    loading,
    signOut: async () => {
      window.localStorage.removeItem(sessionStartedAtKey);
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
  }), [session, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
