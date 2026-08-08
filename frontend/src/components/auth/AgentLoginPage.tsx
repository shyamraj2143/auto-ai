import { FormEvent, useState } from "react";
import { ArrowRight, BriefcaseBusiness, Eye, EyeOff } from "lucide-react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { authErrorMessage } from "../../utils/apiErrors";
import { LogoIcon } from "../brand/LogoIcon";

export function AgentLoginPage() {
  const { agentLogin, logout, user } = useAuth();
  const [agentId, setAgentId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  if (user?.role === "seva_agent") return <Navigate to="/agent/work" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setLoading(true);
    try { navigate(await agentLogin(agentId, password) ? "/agent/change-password" : "/agent/work", { replace: true }); }
    catch (reason) { setError(authErrorMessage(reason, "Agent login failed")); }
    finally { setLoading(false); }
  }

  return <div className="auth-page">
    <Link className="brand-mark absolute left-5 top-5" to="/"><span className="brand-icon"><LogoIcon /></span>Auto-AI</Link>
    <section className="auth-visual"><p className="hero-kicker"><BriefcaseBusiness size={14} /> Seva Agent Portal</p><h1>Agent Workspace.</h1><p>Sign in to work on applications assigned to you.</p></section>
    <form onSubmit={submit} className="auth-card">
      <div className="mb-6"><p className="text-xs uppercase text-cyan-200">Agent Login</p><h2 className="mt-2 text-2xl font-semibold text-white">Open assigned work</h2></div>
      {user && <div className="mb-4 rounded-md border border-amber-300/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Another session is active. <button className="underline" type="button" onClick={logout}>Logout</button></div>}
      {error && <p className="mb-4 rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100" role="alert">{error}</p>}
      <label className="mb-3 block"><span className="mb-1 block text-sm text-slate-200">Agent ID</span><input className="input-dark" value={agentId} onChange={(event) => setAgentId(event.target.value)} autoComplete="username" required /></label>
      <label className="mb-5 block"><span className="mb-1 block text-sm text-slate-200">Password</span><span className="relative block"><input className="input-dark pr-11" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
      <button className="btn-primary h-11 w-full" disabled={loading}>{loading ? "Checking agent" : "Login as agent"}<ArrowRight size={17} /></button>
      <p className="mt-4 text-center text-sm text-slate-400">User login? <Link className="text-cyan-200" to="/login">Go to normal login</Link></p>
    </form>
  </div>;
}
