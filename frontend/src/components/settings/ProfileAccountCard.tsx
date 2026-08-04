import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, ChevronRight, LoaderCircle, Phone, ShieldCheck, Trash2, UserCircle2, XCircle } from "lucide-react";
import clsx from "clsx";
import { api, apiFetch, resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { User } from "../../types";
import { CrystalBadge, CrystalCard } from "../crystal/Crystal";
import { AppSelect } from "../common/AppSelect";

const USERNAME_PATTERN = /^[a-z0-9._]{3,30}$/;
const RESERVED_USERNAMES = new Set(["admin", "administrator", "support", "autoai", "system", "api", "null"]);
const COUNTRY_CODES = ["+91", "+1", "+44", "+61", "+971", "+65"];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

type AvatarAction = "keep" | "replace" | "remove";
type PhoneVerificationResponse = {
  message: string;
  destination: string;
  expires_in_seconds: number;
  resend_after_seconds: number;
  verified: boolean;
  user?: User | null;
};

function initials(name?: string | null, email?: string | null) {
  const source = (name || email || "A").trim();
  return source.slice(0, 1).toUpperCase();
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function usernameLocalError(value: string) {
  const normalized = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(normalized)) return "Invalid username";
  if (RESERVED_USERNAMES.has(normalized)) return "Invalid username";
  return "";
}

function splitPhone(user: User | null) {
  const stored = user?.phone_number || user?.mobile || "";
  const country = user?.phone_country_code || COUNTRY_CODES.find((code) => stored.startsWith(code)) || "+91";
  return { country, number: stored.startsWith(country) ? stored.slice(country.length) : stored.replace(/^\+?\d{1,4}/, "") };
}

function normalizedPhone(country: string, number: string) {
  const digits = number.replace(/\D/g, "");
  return digits ? `${country}${digits}` : "";
}

async function compressAvatar(file: File) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Only JPG, PNG and WebP images are allowed.");
  if (file.size > MAX_AVATAR_BYTES) throw new Error("Profile photo must be 5 MB or smaller.");
  const bitmap = await createImageBitmap(file);
  const size = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to process this image.");
  context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 512, 512);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
  if (!blob) throw new Error("Unable to prepare this image.");
  if (blob.size > MAX_AVATAR_BYTES) throw new Error("Compressed profile photo is still larger than 5 MB.");
  return new File([blob], "profile-avatar.webp", { type: "image/webp" });
}

export function ProfileAccountCard() {
  const { token, user, updateUser } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState(user?.name || "");
  const [username, setUsername] = useState(user?.username || "");
  const [{ country, number }, setPhone] = useState(() => splitPhone(user));
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState("");
  const [avatarAction, setAvatarAction] = useState<AvatarAction>("keep");
  const [usernameStatus, setUsernameStatus] = useState("");
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [otpOpen, setOtpOpen] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpDestination, setOtpDestination] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);

  const currentAvatar = resolveApiAssetUrl(user?.avatar || user?.picture);
  const shownAvatar = avatarAction === "remove" ? "" : avatarPreview || currentAvatar;
  const initialPhone = splitPhone(user);
  const phoneMatchesSaved = normalizedPhone(country, number) === normalizedPhone(initialPhone.country, initialPhone.number);
  const mobileVerified = Boolean(user?.phone_verified && phoneMatchesSaved);

  const dirty = useMemo(() => {
    if (!editing) return false;
    return name.trim() !== (user?.name || "") ||
      normalizeUsername(username) !== (user?.username || "") ||
      country !== initialPhone.country ||
      number.trim() !== initialPhone.number ||
      avatarAction !== "keep";
  }, [avatarAction, country, editing, initialPhone.country, initialPhone.number, name, number, user?.name, user?.username, username]);

  const resetForm = useCallback(() => {
    const nextPhone = splitPhone(user);
    setName(user?.name || "");
    setUsername(user?.username || "");
    setPhone(nextPhone);
    setAvatarFile(null);
    setAvatarPreview("");
    setAvatarAction("keep");
    setUsernameStatus("");
    setOtpOpen(false);
    setOtpCode("");
    setOtpDestination("");
    setResendSeconds(0);
    setError("");
  }, [user]);

  useEffect(() => {
    if (!editing) resetForm();
  }, [editing, resetForm]);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => setResendSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!editing || !token) return;
    const normalized = normalizeUsername(username);
    const localError = usernameLocalError(normalized);
    if (!normalized || normalized === user?.username) {
      setUsernameStatus("");
      return;
    }
    if (localError) {
      setUsernameStatus(localError);
      return;
    }
    setCheckingUsername(true);
    const timeout = window.setTimeout(() => {
      void api.usernameAvailable(token, normalized)
        .then((result) => setUsernameStatus(result.message))
        .catch((checkError: unknown) => setUsernameStatus(checkError instanceof Error ? checkError.message : "Unable to check username"))
        .finally(() => setCheckingUsername(false));
    }, 450);
    return () => {
      window.clearTimeout(timeout);
      setCheckingUsername(false);
    };
  }, [editing, token, user?.username, username]);

  async function chooseAvatar(file?: File) {
    setError("");
    if (!file) return;
    try {
      const compressed = await compressAvatar(file);
      setAvatarFile(compressed);
      setAvatarPreview(URL.createObjectURL(compressed));
      setAvatarAction("replace");
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : "Unable to prepare profile photo.");
    }
  }

  function cancelEdit() {
    if (dirty && !window.confirm("Discard unsaved profile changes?")) return;
    setEditing(false);
    resetForm();
  }

  async function save() {
    if (!token || saving) return;
    const normalized = normalizeUsername(username);
    const localError = usernameLocalError(normalized);
    if (localError) {
      setError(localError);
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      let nextUser = await api.updateProfile(token, {
        name: name.trim(),
        username: normalized,
        phone_country_code: country,
        phone_number: number.trim()
      });
      if (avatarAction === "replace" && avatarFile) nextUser = await api.uploadAvatar(token, avatarFile);
      if (avatarAction === "remove") {
        await api.deleteAvatar(token);
        nextUser = await api.profile(token);
      }
      updateUser(nextUser);
      window.dispatchEvent(new CustomEvent("auto-ai-profile-updated", { detail: nextUser }));
      setEditing(false);
      setMessage("Profile updated.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save profile.");
    } finally {
      setSaving(false);
    }
  }

  async function sendOtp() {
    if (!token || otpBusy || resendSeconds > 0) return;
    if (number.replace(/\D/g, "").length < 8) {
      setError("Enter a valid mobile number.");
      return;
    }
    setOtpBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiFetch<PhoneVerificationResponse>("/users/me/phone/send-otp", {
        method: "POST",
        token,
        operation: "users.phone.sendOtp",
        timeoutMs: 30000,
        body: JSON.stringify({ phone_country_code: country, phone_number: number.trim() })
      });
      const nextUser = await api.profile(token);
      updateUser(nextUser);
      setOtpDestination(result.destination);
      setOtpCode("");
      setOtpOpen(true);
      setResendSeconds(result.resend_after_seconds || 30);
      setMessage(result.message);
    } catch (otpError) {
      setError(otpError instanceof Error ? otpError.message : "Unable to send verification code.");
    } finally {
      setOtpBusy(false);
    }
  }

  async function verifyOtp() {
    if (!token || otpBusy || otpCode.length < 4) return;
    setOtpBusy(true);
    setError("");
    try {
      const result = await apiFetch<PhoneVerificationResponse>("/users/me/phone/verify-otp", {
        method: "POST",
        token,
        operation: "users.phone.verifyOtp",
        timeoutMs: 30000,
        body: JSON.stringify({ code: otpCode })
      });
      const nextUser = result.user || await api.profile(token);
      updateUser(nextUser);
      window.dispatchEvent(new CustomEvent("auto-ai-profile-updated", { detail: nextUser }));
      setOtpOpen(false);
      setOtpCode("");
      setMessage(result.message);
    } catch (otpError) {
      setError(otpError instanceof Error ? otpError.message : "Verification failed.");
    } finally {
      setOtpBusy(false);
    }
  }

  return (
    <CrystalCard className="settings-card overflow-hidden">
      <button className="profile-account-summary" type="button" onClick={() => setEditing(true)} aria-expanded={editing} aria-controls="profile-account-editor" disabled={editing}>
        <div className="profile-account-avatar">{shownAvatar ? <img className="h-full w-full object-cover" src={shownAvatar} alt="" /> : initials(user?.name, user?.email)}</div>
        <div className="profile-account-copy">
          <div className="profile-account-title">
            <h2>{user?.name || "Profile & Account"}</h2>
            {user?.phone_verified && <CrystalBadge tone="verified">Phone verified</CrystalBadge>}
            {(user?.role === "admin" || user?.role === "super_admin") && <CrystalBadge tone="admin">Admin</CrystalBadge>}
            {user?.subscription_status && !["free", "inactive", "expired"].includes(user.subscription_status.toLowerCase()) && <CrystalBadge tone="premium">Premium</CrystalBadge>}
          </div>
          <p>{user?.email || `@${user?.username || "create_username"}`}</p>
          <small>@{user?.username || "create_username"}</small>
        </div>
        <ChevronRight className="profile-account-chevron" size={21} aria-hidden="true" />
      </button>
      {message && <p className="profile-account-message" role="status">{message}</p>}

      {editing && (
        <div id="profile-account-editor" className="border-t border-white/10 p-3 md:p-4">
          <div className="grid gap-3 md:grid-cols-[auto_1fr]">
            <div className="grid justify-items-center gap-2">
              <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-full border border-white/15 bg-slate-900 text-2xl font-bold text-slate-100">{shownAvatar ? <img className="h-full w-full object-cover" src={shownAvatar} alt="" /> : initials(name, user?.email)}</div>
              <input ref={fileInputRef} className="hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void chooseAvatar(event.target.files?.[0])} />
              <div className="flex flex-wrap justify-center gap-1.5">
                <button className="btn-secondary min-h-8 px-2 text-[11px]" type="button" onClick={() => fileInputRef.current?.click()}><Camera size={13} /> Upload</button>
                <button className="btn-secondary min-h-8 px-2 text-[11px]" type="button" onClick={() => { setAvatarAction("remove"); setAvatarFile(null); setAvatarPreview(""); }}><Trash2 size={13} /> Remove</button>
              </div>
            </div>

            <div className="grid gap-2">
              <label className="grid gap-1 text-[11px] font-semibold text-slate-300">Full name<input className="input-dark" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
              <label className="grid gap-1 text-[11px] font-semibold text-slate-300">Username<div className="relative"><input className="input-dark pr-8" value={username} maxLength={30} onChange={(event) => setUsername(event.target.value.toLowerCase())} /><span className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500">{checkingUsername ? <LoaderCircle className="animate-spin" size={14} /> : usernameStatus === "Username available" ? <CheckCircle2 size={14} /> : usernameStatus ? <XCircle size={14} /> : null}</span></div>{usernameStatus && <span className={clsx("text-[10px]", usernameStatus === "Username available" ? "text-emerald-300" : "text-amber-300")}>{usernameStatus}</span>}</label>

              <div className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
                <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-[11px] font-semibold text-slate-300"><Phone size={14} /> Mobile number</span>{mobileVerified ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/25 bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-200"><ShieldCheck size={12} /> Verified</span> : <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200">Not verified</span>}</div>
                <div className="grid grid-cols-[92px_1fr] gap-2"><AppSelect label="Country code" value={country} onChange={(value) => { setPhone((current) => ({ ...current, country: value })); setOtpOpen(false); }} options={COUNTRY_CODES.map((code) => ({ value: code, label: code }))} /><input aria-label="Mobile number" className="input-dark" value={number} inputMode="tel" autoComplete="tel-national" onChange={(event) => { setPhone((current) => ({ ...current, number: event.target.value.replace(/[^\d\s-]/g, "") })); setOtpOpen(false); }} /></div>
                {!mobileVerified && <button className="btn-secondary min-h-9 justify-center px-3 text-[11px]" type="button" disabled={otpBusy || resendSeconds > 0 || !number.trim()} onClick={() => void sendOtp()}>{otpBusy && !otpOpen ? <LoaderCircle className="animate-spin" size={14} /> : <ShieldCheck size={14} />}{resendSeconds > 0 ? `Resend in ${resendSeconds}s` : otpOpen ? "Resend OTP" : "Send verification OTP"}</button>}
                {otpOpen && !mobileVerified && <div className="grid gap-2 rounded-lg border border-cyan-300/15 bg-cyan-400/[0.04] p-3"><p className="text-[11px] leading-5 text-slate-300">Enter the OTP sent to <strong className="text-white">{otpDestination}</strong>.</p><input aria-label="Verification OTP" className="input-dark text-center tracking-[0.35em]" value={otpCode} inputMode="numeric" autoComplete="one-time-code" maxLength={10} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ""))} /><button className="btn-primary min-h-9 justify-center px-3 text-[11px]" type="button" disabled={otpBusy || otpCode.length < 4} onClick={() => void verifyOtp()}>{otpBusy ? <LoaderCircle className="animate-spin" size={14} /> : <CheckCircle2 size={14} />} Verify mobile</button></div>}
              </div>

              <label className="grid gap-1 text-[11px] font-semibold text-slate-300">Email address<input className="input-dark opacity-70" value={user?.email || ""} readOnly /></label>
              {error && <p className="rounded-md border border-red-300/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-100" role="alert">{error}</p>}
              <div className="flex flex-wrap justify-end gap-2"><button className="btn-secondary min-h-9 px-3 text-[11px]" type="button" onClick={cancelEdit} disabled={saving || otpBusy}>Cancel</button><button className="btn-primary min-h-9 px-3 text-[11px]" type="button" onClick={() => void save()} disabled={saving || otpBusy || !dirty}>{saving ? <LoaderCircle className="animate-spin" size={14} /> : <UserCircle2 size={14} />} Save Changes</button></div>
            </div>
          </div>
        </div>
      )}
    </CrystalCard>
  );
}
