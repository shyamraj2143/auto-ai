import { FormEvent, useCallback, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowRight, KeyRound, Lock } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { authErrorMessage } from "../../utils/apiErrors";
import { isMobileAppRuntime } from "../../utils/runtime";
import { LogoIcon } from "../brand/LogoIcon";
import { GoogleSignInButton } from "./GoogleSignInButton";

export function LoginPage() {
  const { googleLogin, login, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(authErrorMessage(err, "Unable to log in"));
    } finally {
      setLoading(false);
    }
  }

  const handleGoogleCredential = useCallback(async (idToken: string) => {
    setError("");
    setLoading(true);
    try {
      await googleLogin(idToken);
    } catch (err) {
      setError(authErrorMessage(err, "Google Sign-In failed"));
    } finally {
      setLoading(false);
    }
  }, [googleLogin]);

  const handleGoogleError = useCallback((message: string) => {
    setError(message);
  }, []);

  function toggleForgotPassword() {
    setForgotOpen((current) => !current);
    setResetEmail((current) => current || email);
    setResetLink(null);
    setResetMessage("");
    setError("");
  }

  async function requestPasswordReset() {
    const targetEmail = (resetEmail || email).trim();
    if (!targetEmail) {
      setError("Enter your email to receive a reset link.");
      return;
    }
    setError("");
    setResetMessage("");
    setResetLink(null);
    setResetLoading(true);
    try {
      const result = await api.requestPasswordReset({ email: targetEmail });
      setResetMessage(result.message);
      setResetLink(result.reset_url ?? null);
    } catch (err) {
      setError(authErrorMessage(err, "Unable to send password reset link"));
    } finally {
      setResetLoading(false);
    }
  }

  if (user) return <Navigate to="/chat" replace />;

  return (
    <div className="auth-page">
      <Link className="brand-mark absolute left-5 top-5" to={isMobileAppRuntime() ? "/login" : "/"}>
        <span className="brand-icon"><LogoIcon /></span>
        Auto-AI
      </Link>
      <section className="auth-visual">
        <p className="hero-kicker"><Lock size={14} /> Secure workspace</p>
        <h1>Welcome back.</h1>
        <p>Pick up the thread with your chats, documents, memory, and model settings intact.</p>
      </section>
      <form onSubmit={onSubmit} className="auth-card">
        <div className="mb-6">
          <p className="text-xs uppercase text-cyan-200">Login</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Enter Auto-AI</h2>
        </div>
        {error && <p className="mb-4 rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</p>}
        <GoogleSignInButton disabled={loading} intent="signin" onCredential={handleGoogleCredential} onError={handleGoogleError} />
        <div className="auth-divider"><span>or use email</span></div>
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Email</span>
          <input className="input-dark" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </label>
        <label className="mb-2 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Password</span>
          <input className="input-dark" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        </label>
        <div className="auth-inline-row">
          <button className="auth-link-button" type="button" onClick={toggleForgotPassword}>
            <KeyRound size={14} />
            Forgot password?
          </button>
        </div>
        {forgotOpen && (
          <div className="auth-reset-panel">
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium text-slate-200">Reset email</span>
              <input
                className="input-dark"
                type="email"
                value={resetEmail}
                onChange={(event) => setResetEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void requestPasswordReset();
                  }
                }}
                autoComplete="email"
                placeholder="you@example.com"
              />
            </label>
            <button className="btn-secondary h-10 w-full" disabled={resetLoading} onClick={requestPasswordReset} type="button">
              {resetLoading ? "Sending reset link" : "Send reset link"}
            </button>
            {resetMessage && <p className="auth-status">{resetMessage}</p>}
            {resetLink && <a className="auth-reset-link" href={resetLink}>Open reset page</a>}
          </div>
        )}
        <button className="btn-primary h-11 w-full" disabled={loading}>
          {loading ? "Signing in" : "Login"}
          <ArrowRight size={17} />
        </button>
        <p className="mt-4 text-center text-sm text-slate-400">
          New here? <Link className="font-medium text-cyan-200" to="/register">Create an account</Link>
        </p>
      </form>
    </div>
  );
}
