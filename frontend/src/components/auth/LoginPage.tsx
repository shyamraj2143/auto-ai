import { FormEvent, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowRight, Lock, Sparkles } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

export function LoginPage() {
  const { login, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/chat" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log in");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <Link className="brand-mark absolute left-5 top-5" to="/">
        <span className="brand-icon"><Sparkles size={18} /></span>
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
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Email</span>
          <input className="input-dark" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Password</span>
          <input className="input-dark" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
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
