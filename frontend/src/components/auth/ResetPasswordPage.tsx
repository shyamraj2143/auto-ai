import { FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, KeyRound } from "lucide-react";
import { api } from "../../api/client";
import { authErrorMessage } from "../../utils/apiErrors";
import { isMobileAppRuntime } from "../../utils/runtime";
import { LogoIcon } from "../brand/LogoIcon";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get("token")?.trim() ?? "", [searchParams]);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const hasToken = token.length >= 32;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!hasToken) {
      setError("Password reset link is missing or invalid.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const result = await api.resetPassword({ token, password });
      setMessage(result.message);
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(authErrorMessage(err, "Unable to reset password"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <Link className="brand-mark absolute left-5 top-5" to={isMobileAppRuntime() ? "/login" : "/"}>
        <span className="brand-icon"><LogoIcon /></span>
        Auto-AI
      </Link>
      <section className="auth-visual">
        <p className="hero-kicker"><KeyRound size={14} /> Account recovery</p>
        <h1>Set a new password.</h1>
        <p>Use the one-time reset link to restore access to your Auto-AI workspace.</p>
      </section>
      <form onSubmit={onSubmit} className="auth-card">
        <div className="mb-6">
          <p className="text-xs uppercase text-cyan-200">Reset password</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Recover Auto-AI</h2>
        </div>
        {!hasToken && <p className="mb-4 rounded-md border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Open the reset link from your email to continue.</p>}
        {error && <p className="mb-4 rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</p>}
        {message && <p className="mb-4 rounded-md border border-emerald-300/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">{message}</p>}
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">New password</span>
          <input className="input-dark" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required disabled={!hasToken || Boolean(message)} />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Confirm password</span>
          <input className="input-dark" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required disabled={!hasToken || Boolean(message)} />
        </label>
        {message ? (
          <Link className="btn-primary h-11 w-full" to="/login">
            Back to login
            <ArrowRight size={17} />
          </Link>
        ) : (
          <button className="btn-primary h-11 w-full" disabled={loading || !hasToken}>
            {loading ? "Updating password" : "Reset password"}
            <ArrowRight size={17} />
          </button>
        )}
      </form>
    </div>
  );
}
