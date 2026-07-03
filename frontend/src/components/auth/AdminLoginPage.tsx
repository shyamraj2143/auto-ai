import { FormEvent, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { authErrorMessage } from "../../utils/apiErrors";
import { LogoIcon } from "../brand/LogoIcon";

export function AdminLoginPage() {
  const { adminLogin, logout, user } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (user?.role === "admin" || user?.role === "super_admin") return <Navigate to="/admin" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await adminLogin(email, password);
    } catch (err) {
      setError(authErrorMessage(err, "Admin login failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <Link className="brand-mark absolute left-5 top-5" to="/">
        <span className="brand-icon"><LogoIcon /></span>
        Auto-AI
      </Link>
      <section className="auth-visual">
        <p className="hero-kicker"><ShieldCheck size={14} /> Admin only</p>
        <h1>Admin Control Center.</h1>
        <p>Only accounts with role admin can enter the dashboard.</p>
      </section>
      <form onSubmit={onSubmit} className="auth-card">
        <div className="mb-6">
          <p className="text-xs uppercase text-cyan-200">Admin Login</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Enter dashboard</h2>
        </div>
        {user && (
          <div className="mb-4 rounded-md border border-amber-300/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            Normal user session active. Login below with an admin account or logout first.
            <button className="ml-2 font-semibold text-white underline" type="button" onClick={logout}>
              Logout
            </button>
          </div>
        )}
        {error && <p className="mb-4 rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</p>}
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Admin email</span>
          <input className="input-dark" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Password</span>
          <input className="input-dark" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        <button className="btn-primary h-11 w-full" disabled={loading}>
          {loading ? "Checking admin" : "Login as admin"}
          <ArrowRight size={17} />
        </button>
        <p className="mt-4 text-center text-sm text-slate-400">
          User login? <Link className="font-medium text-cyan-200" to="/login">Go to normal login</Link>
        </p>
      </form>
    </div>
  );
}
