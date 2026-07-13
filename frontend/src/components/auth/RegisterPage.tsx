import { FormEvent, useCallback, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowRight, Brain } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { authErrorMessage, registerErrorMessage } from "../../utils/apiErrors";
import { LogoIcon } from "../brand/LogoIcon";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { NeuralCore } from "../../motion/NeuralCore";
import { AnimatedPage } from "../../motion/primitives";

export function RegisterPage() {
  const { googleLogin, register, user } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    setError("");
    if (!trimmedName || !normalizedEmail || !password) {
      setError("Please check the registration details.");
      return;
    }
    setLoading(true);
    try {
      await register(trimmedName, normalizedEmail, password);
    } catch (err) {
      setError(registerErrorMessage(err));
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

  if (user) return <Navigate to="/chat" replace />;

  return (
    <AnimatedPage className="auth-page">
      <Link className="brand-mark absolute left-5 top-5" to="/">
        <span className="brand-icon"><LogoIcon /></span>
        Auto-AI
      </Link>
      <div className="auth-neural-core" aria-hidden="true">
        <NeuralCore state={loading ? "thinking" : "idle"} size="lg" />
      </div>
      <section className="auth-visual">
        <p className="hero-kicker"><Brain size={14} /> Personal AI layer</p>
        <h1>Create your workspace.</h1>
        <p>Start with streaming chat, memory management, document context, image analysis, and voice input ready on day one.</p>
      </section>
      <form onSubmit={onSubmit} className="auth-card">
        <div className="mb-6">
          <p className="text-xs uppercase text-cyan-200">Register</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Launch Auto-AI</h2>
        </div>
        {error && <p className="mb-4 rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</p>}
        <GoogleSignInButton disabled={loading} intent="signup" onCredential={handleGoogleCredential} onError={handleGoogleError} />
        <div className="auth-divider"><span>or use email</span></div>
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Name</span>
          <input className="input-dark" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required minLength={2} />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Email</span>
          <input className="input-dark" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-sm font-medium text-slate-200">Password</span>
          <input className="input-dark" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required minLength={8} />
        </label>
        <button className="btn-primary h-11 w-full" disabled={loading}>
          {loading ? "Creating" : "Create account"}
          <ArrowRight size={17} />
        </button>
        <p className="mt-4 text-center text-sm text-slate-400">
          Already registered? <Link className="font-medium text-cyan-200" to="/login">Log in</Link>
        </p>
      </form>
    </AnimatedPage>
  );
}
