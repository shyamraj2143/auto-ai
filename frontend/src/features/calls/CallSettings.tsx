import { BellRing, Eye, EyeOff, LoaderCircle, Mic, PhoneCall, ShieldAlert, ShieldBan, Smartphone, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { callApi } from "./services/callApi";
import type { BlockedCallUser, CallSettings as Settings } from "./types";

function SettingToggle({ label, description, checked, onChange, icon: Icon }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void; icon: typeof Eye }) {
  return <div className="call-setting-row"><span><Icon size={16} /><span><strong>{label}</strong><small>{description}</small></span></span><button type="button" className={`call-setting-toggle ${checked ? "active" : ""}`} onClick={() => onChange(!checked)} aria-pressed={checked}><i /></button></div>;
}

export function CallSettings() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [blocked, setBlocked] = useState<BlockedCallUser[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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

  useEffect(() => { void load(); }, [load]);

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
      <section>
        <SettingToggle icon={settings.is_discoverable ? Eye : EyeOff} label="Allow other users to find me" description="Show your public name and username in search" checked={settings.is_discoverable} onChange={(value) => void update({ is_discoverable: value })} />
        <SettingToggle icon={Eye} label="Show my online status" description="Let discoverable users see when you are active" checked={settings.show_online_status} onChange={(value) => void update({ show_online_status: value })} />
        <SettingToggle icon={Eye} label="Show last seen" description="Share your last active time" checked={settings.show_last_seen} onChange={(value) => void update({ show_last_seen: value })} />
      </section>
      <section>
        <SettingToggle icon={Video} label="Allow video calls" description="Receive person-to-person video calls" checked={settings.allow_video_calls} onChange={(value) => void update({ allow_video_calls: value })} />
        <SettingToggle icon={Mic} label="Allow audio calls" description="Receive person-to-person audio calls" checked={settings.allow_audio_calls} onChange={(value) => void update({ allow_audio_calls: value })} />
        <div className="call-setting-row"><span><PhoneCall size={16} /><span><strong>Allow calls from</strong><small>Choose who can start a call</small></span></span><select value={settings.call_permission} onChange={(event) => void update({ call_permission: event.target.value as Settings["call_permission"] })} aria-label="Allow calls from"><option value="everyone">Everyone</option><option value="followers">Followers</option><option value="mutual_followers">Mutual followers</option><option value="approved_contacts">Approved contacts</option><option value="previous_contacts">Previous calls</option><option value="nobody">Nobody</option></select></div>
        <SettingToggle icon={ShieldBan} label="Silence unknown callers" description="Unknown calls arrive without sound or vibration" checked={settings.silence_unknown_callers} onChange={(value) => void update({ silence_unknown_callers: value })} />
      </section>
      <section>
        <SettingToggle icon={BellRing} label="Call notification sound" description="Play a ringtone for allowed calls" checked={settings.call_notification_sound} onChange={(value) => void update({ call_notification_sound: value })} />
        <SettingToggle icon={Smartphone} label="Vibration" description="Vibrate for incoming calls on supported devices" checked={settings.vibration} onChange={(value) => void update({ vibration: value })} />
        <SettingToggle icon={Smartphone} label="Data-saving mode" description="Start calls with reduced video bandwidth" checked={settings.data_saving_mode} onChange={(value) => void update({ data_saving_mode: value })} />
      </section>
      <section>
        <div className="call-settings-heading"><ShieldBan size={16} /><strong>Blocked users</strong></div>
        {blocked.map((item) => {
          const avatarUrl = resolveApiAssetUrl(item.avatar_url);
          return <div className="blocked-call-user" key={item.id}><span>{avatarUrl ? <img src={avatarUrl} alt="" /> : item.display_name.slice(0, 1)}</span><span><strong>{item.display_name}</strong><small>@{item.username}</small></span><button type="button" onClick={async () => { if (!token) return; await callApi.unblock(token, item.id); setBlocked((users) => users.filter((user) => user.id !== item.id)); }}>Unblock</button></div>;
        })}
        {!blocked.length && <p className="call-settings-empty">No blocked users</p>}
      </section>
    </div>
  );
}
