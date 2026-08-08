import { FormEvent, useState } from "react";
import { ArrowRight, BriefcaseBusiness } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { authErrorMessage } from "../../utils/apiErrors";
import { LogoIcon } from "../brand/LogoIcon";

export function AgentLoginPage() {
  const { agentLogin, logout, user } = useAuth();
  const [agentId, setAgentId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  if (user?.role === "seva_agent") return <Navigate to="/agent/work" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setLoading(true);
    try { await agentLogin(agentId, password); }
    catch (reason) { setError(authErrorMessage(reason, "Agent login failed")); }
    finally { setLoading(false); }
  }

  return <div className="auth-page">
    <Link className="brand-mark absolute left-5 top-5" to="/"><span className="brand-icon"><LogoIcon /></span>Auto-AI</Link>
    <section className="auth-visual"><p className="hero-kicker"><BriefcaseBusiness size={14} /> Seva operations</p><h1>Agent Workspace.</h1><p>Work only on applications automatically assigned within your approved capacity.</p></section>
    <form onSubmit={submit} className="auth-card">
      <div className="mb-6"><p className="text-xs uppercase text-cyan-200">Agent Login</p><h2 className="mt-2 text-2xl font-semibold text-white">Open assigned work</h2></div>
      {user && <div className="mb-4 rounded-md border border-amber-300/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Another session is active. <button className="underline" type="button" onClick={logout}>Logout</button></div>}
      {error && <p className="mb-4 rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100" role="alert">{error}</p>}
      <label className="mb-3 block"><span className="mb-1 block text-sm text-slate-200">Agent ID</span><input className="input-dark" value={agentId} onChange={(event) => setAgentId(event.target.value)} autoComplete="username" required /></label>
      <label className="mb-5 block"><span className="mb-1 block text-sm text-slate-200">Password</span><input className="input-dark" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
      <button className="btn-primary h-11 w-full" disabled={loading}>{loading ? "Checking agent" : "Login as agent"}<ArrowRight size={17} /></button>
      <p className="mt-4 text-center text-sm text-slate-400">User login? <Link className="text-cyan-200" to="/login">Go to normal login</Link></p>
    </form>
  </div>;
}
