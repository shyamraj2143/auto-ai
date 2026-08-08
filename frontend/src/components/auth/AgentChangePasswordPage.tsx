import { FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { sevaApi } from "../../features/autoaiSeva/sevaApi";

export function AgentChangePasswordPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  if (!token || user?.role !== "seva_agent") return <Navigate to="/agent/login" replace />;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (newPassword !== confirmPassword) { setError("New passwords do not match."); return; }
    setLoading(true);
    try { await sevaApi.changeAgentPassword(token!, currentPassword, newPassword); navigate("/agent/work", { replace: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Password could not be changed."); }
    finally { setLoading(false); }
  }
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}><p className="text-xs uppercase text-cyan-200">Seva Agent Portal</p><h1 className="mb-2 mt-2 text-2xl font-semibold text-white">Create your private password</h1><p className="mb-6 text-sm text-slate-400">Your temporary password must be changed before case access is enabled.</p>{error && <p className="mb-4 rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100" role="alert">{error}</p>}<label className="mb-3 block"><span className="mb-1 block text-sm text-slate-200">Temporary password</span><input className="input-dark" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label className="mb-3 block"><span className="mb-1 block text-sm text-slate-200">New password</span><input className="input-dark" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} autoComplete="new-password" required /></label><label className="mb-5 block"><span className="mb-1 block text-sm text-slate-200">Confirm new password</span><input className="input-dark" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} autoComplete="new-password" required /></label><button className="btn-primary h-11 w-full" disabled={loading}>{loading ? "Saving" : "Change password and continue"}</button></form></main>;
}
