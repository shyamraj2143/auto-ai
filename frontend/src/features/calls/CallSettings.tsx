import { BellRing, Eye, EyeOff, LoaderCircle, PhoneCall, ShieldAlert, ShieldBan, Smartphone, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { AppSelect } from "../../components/common/AppSelect";
import { CallAvatar } from "./CallAvatar";
import { callApi } from "./services/callApi";
import { callNative, type NativeCallReadiness } from "./services/callNative";
import type { BlockedCallUser, CallSettings as Settings } from "./types";

export const CALLING_PERMISSION_ROWS = [
  ["notifications", "Notifications"],
  ["incomingChannel", "Incoming-call alerts"],
  ["microphone", "Microphone"],
  ["camera", "Camera"],
  ["bluetooth", "Bluetooth audio"],
  ["fullScreen", "Full-screen calls"],
  ["backgroundActivity", "Background activity"],
] as const;

type PermissionKey = (typeof CALLING_PERMISSION_ROWS)[number][0];

export function callingPermissionDisplay(key: PermissionKey, state: NativeCallReadiness["items"][PermissionKey]["state"]) {
  if (state === "GRANTED") return { label: key === "backgroundActivity" ? "Unrestricted" : "Allowed", tone: "ready" };
  if (state === "NOT_REQUIRED") return { label: "Not required", tone: "neutral" };
  if (key === "backgroundActivity" && state === "LIMITED") return { label: "Battery optimized", tone: "limited" };
  if (key === "backgroundActivity" && state === "DENIED") return { label: "Restricted", tone: "blocked" };
  if (state === "LIMITED" || state === "SPECIAL_ACCESS_REQUIRED") return { label: "Limited", tone: "limited" };
  return { label: "Action needed", tone: "blocked" };
}

function SettingToggle({ label, description, checked, onChange, icon: Icon, callType }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void; icon: typeof Eye; callType?: "audio" | "video" }) {
  return <div className={`call-setting-row${callType ? ` call-type-row call-type-${callType}` : ""}`}><span><Icon size={18} /><span><strong>{label}</strong><small>{description}</small></span></span><button type="button" className={`call-setting-toggle ${checked ? "active" : ""}`} onClick={() => onChange(!checked)} aria-pressed={checked} aria-label={`${checked ? "Disable" : "Enable"} ${label}`}><i /></button></div>;
}

export function CallSettings() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [blocked, setBlocked] = useState<BlockedCallUser[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [readiness, setReadiness] = useState<NativeCallReadiness | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const readinessRequest = useRef<Promise<void> | null>(null);

  const refreshReadiness = useCallback(async () => {
    if (!callNative.isAndroid() || readinessRequest.current) return readinessRequest.current;
    setCheckingReadiness(true);
    const request = callNative.refreshCallingSetupState().then((state) => { if (state) setReadiness(state); }).finally(() => {
      readinessRequest.current = null;
      setCheckingReadiness(false);
    });
    readinessRequest.current = request;
    return request;
  }, []);

  useEffect(() => {
    const refresh = () => void refreshReadiness();
    window.addEventListener("auto-ai-calling-setup-changed", refresh);
    window.addEventListener("focus", refresh);
    const visibility = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("auto-ai-calling-setup-changed", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refreshReadiness]);

  const load = useCallback(async () => {
    if (!token) return;
    setError("");
    try {
      const [nextSettings, blockedUsers] = await Promise.all([callApi.settings(token), callApi.blocked(token)]);
      setSettings(nextSettings);
      setBlocked(blockedUsers);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load call settings.");
    }
  }, [token]);

  useEffect(() => { void load(); void refreshReadiness(); }, [load, refreshReadiness]);

  const update = useCallback(async (patch: Partial<Settings>) => {
    if (!token || !settings || saving) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setSaving(true);
    setError("");
    try { setSettings(await callApi.updateSettings(token, patch)); }
    catch (updateError) { setSettings(previous); setError(updateError instanceof Error ? updateError.message : "Unable to save call settings."); }
    finally { setSaving(false); }
  }, [saving, settings, token]);

  if (!settings) return error
    ? <div className="call-settings-loading"><ShieldAlert size={18} /> {error}<button type="button" onClick={() => void load()}>Retry</button></div>
    : <div className="call-settings-loading"><LoaderCircle className="animate-spin" size={18} /> Loading call settings…</div>;
  return (
    <div className="call-settings-page">
      {saving && <span className="call-settings-saving"><LoaderCircle className="animate-spin" size={13} /> Saving</span>}
      {error && <p className="calls-inline-alert">{error}</p>}
      {callNative.isAndroid() && <section className={`call-readiness call-readiness-${readiness?.status?.toLowerCase() || "loading"}`}>
        <div className="call-settings-heading"><Smartphone size={16} /><strong>Calling permissions: {checkingReadiness ? "Checking…" : readiness?.status === "READY" ? "Ready" : readiness?.status === "LIMITED" ? "Limited" : readiness?.status === "BLOCKED" ? "Action needed" : "Checking…"}</strong></div>
        {readiness && readiness.status !== "READY" && <ul>{CALLING_PERMISSION_ROWS.filter(([key]) => !["GRANTED", "NOT_REQUIRED"].includes(readiness.items[key].state)).map(([key, label]) => {
          const display = callingPermissionDisplay(key, readiness.items[key].state);
          return <li key={key} className={`calling-permission-${display.tone}`}>{label}: {display.label}</li>;
        })}</ul>}
        <div className="call-readiness-actions">
          {readiness?.status !== "READY" && <button type="button" onClick={() => void callNative.startCallingSetup()}>{readiness?.onboardingCompleted ? "Fix missing permissions" : "Complete setup"}</button>}
          {readiness?.items.backgroundActivity.state === "LIMITED" && <button type="button" onClick={() => void callNative.openBackgroundActivitySettings()}>Open background settings</button>}
          <button type="button" disabled={checkingReadiness} onClick={() => void refreshReadiness()}>{checkingReadiness ? "Checking…" : "Check again"}</button>
        </div>
      </section>}
      <section>
        <SettingToggle icon={settings.is_discoverable ? Eye : EyeOff} label="Allow other users to find me" description="Show your public name and username in search" checked={settings.is_discoverable} onChange={(value) => void update({ is_discoverable: value })} />
        <SettingToggle icon={Eye} label="Show my online status" description="Let discoverable users see when you are active" checked={settings.show_online_status} onChange={(value) => void update({ show_online_status: value })} />
        <SettingToggle icon={Eye} label="Show last seen" description="Share your last active time" checked={settings.show_last_seen} onChange={(value) => void update({ show_last_seen: value })} />
      </section>
      <section className="call-type-settings">
        <div className="call-type-heading"><PhoneCall size={18} /><span><strong>Call types</strong><small>Choose which incoming calls AutoAI can receive</small></span></div>
        <SettingToggle callType="audio" icon={PhoneCall} label="Audio calls" description="Voice-only calls with a clear phone indicator" checked={settings.allow_audio_calls} onChange={(value) => void update({ allow_audio_calls: value })} />
        <SettingToggle callType="video" icon={Video} label="Video calls" description="Camera calls with a dedicated video indicator" checked={settings.allow_video_calls} onChange={(value) => void update({ allow_video_calls: value })} />
        <div className="call-setting-row"><span><PhoneCall size={16} /><span><strong>Allow calls from</strong><small>Choose who can start a call</small></span></span><AppSelect value={settings.call_permission} onChange={(value) => void update({ call_permission: value as Settings["call_permission"] })} label="Allow calls from" options={[{value:"everyone",label:"Everyone"},{value:"followers",label:"Followers"},{value:"mutual_followers",label:"Mutual followers"},{value:"approved_contacts",label:"Approved contacts"},{value:"previous_contacts",label:"Previous calls"},{value:"nobody",label:"Nobody"}]} /></div>
        <SettingToggle icon={ShieldBan} label="Silence unknown callers" description="Unknown calls arrive without sound or vibration" checked={settings.silence_unknown_callers} onChange={(value) => void update({ silence_unknown_callers: value })} />
      </section>
      <section>
        <SettingToggle icon={BellRing} label="Call notification sound" description="Play a ringtone for allowed calls" checked={settings.call_notification_sound} onChange={(value) => void update({ call_notification_sound: value })} />
        <SettingToggle icon={Smartphone} label="Vibration" description="Vibrate for incoming calls on supported devices" checked={settings.vibration} onChange={(value) => void update({ vibration: value })} />
        <SettingToggle icon={Smartphone} label="Data-saving mode" description="Start calls with reduced video bandwidth" checked={settings.data_saving_mode} onChange={(value) => void update({ data_saving_mode: value })} />
      </section>
      <section>
        <div className="call-settings-heading"><ShieldBan size={16} /><strong>Blocked users</strong></div>
        {blocked.map((item) => <div className="blocked-call-user" key={item.id}><CallAvatar name={item.display_name} avatarUrl={item.avatar_url} /><span><strong>{item.display_name}</strong><small>@{item.username}</small></span><button type="button" onClick={async () => { if (!token) return; await callApi.unblock(token, item.id); setBlocked((users) => users.filter((user) => user.id !== item.id)); }}>Unblock</button></div>)}
        {!blocked.length && <p className="call-settings-empty">No blocked users</p>}
      </section>
    </div>
  );
}
