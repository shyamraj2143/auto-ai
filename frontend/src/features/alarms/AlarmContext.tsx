import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { alarmNative } from "./alarmNative";
import { enqueueAlarmAction, flushAlarmActions } from "./alarmOfflineQueue";
import { alarmsApi } from "./alarmsApi";
import type { AlarmAwakeVerification, AlarmDraft, AlarmNativeStatus, UserAlarm } from "./types";

type AlarmContextValue = {
  alarms: UserAlarm[];
  nextAlarm: UserAlarm | null;
  activeAlarm: UserAlarm | null;
  loading: boolean;
  saving: boolean;
  error: string;
  nativeStatus: AlarmNativeStatus | null;
  refresh: () => Promise<void>;
  createAlarm: (payload: AlarmDraft) => Promise<UserAlarm>;
  updateAlarm: (alarmId: string, payload: Partial<AlarmDraft> & { enabled?: boolean }) => Promise<UserAlarm>;
  deleteAlarm: (alarmId: string) => Promise<void>;
  dismissAlarm: (alarmId: string) => Promise<void>;
  verifyAwake: (alarmId: string, photo: Blob) => Promise<AlarmAwakeVerification>;
  snoozeAlarm: (alarmId: string, minutes?: number) => Promise<void>;
  previewAlarm: (alarm: UserAlarm) => Promise<void>;
  requestAlarmAccess: () => Promise<void>;
};

const AlarmContext = createContext<AlarmContextValue | null>(null);

function sortAlarms(items: UserAlarm[]) {
  return [...items].sort((left, right) => Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at));
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "Alarm service is temporarily unavailable.";
}

function accessMessage(status: AlarmNativeStatus) {
  if (status.notificationsRequired && !status.notificationsGranted) return "Allow alarm notifications, then create the alarm again.";
  if (status.cameraRequired && !status.cameraGranted) return "Allow camera access for awake verification, then create the alarm again.";
  if (status.exactAlarmRequired && !status.exactAlarmGranted) return "Enable Alarms & reminders access, return to AutoAI, then create the alarm again.";
  return "Finish the required Android alarm access, then create the alarm again.";
}

export function AlarmProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const [alarms, setAlarms] = useState<UserAlarm[]>([]);
  const [activeAlarm, setActiveAlarm] = useState<UserAlarm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [nativeStatus, setNativeStatus] = useState<AlarmNativeStatus | null>(null);
  const refreshRunning = useRef(false);

  const refreshStatus = useCallback(async () => {
    const status = await alarmNative.status().catch(() => null);
    if (status) setNativeStatus(status);
  }, []);

  const refresh = useCallback(async () => {
    if (!token || refreshRunning.current) return;
    refreshRunning.current = true;
    try {
      if (user?.id && !alarmNative.isAndroid() && (typeof navigator === "undefined" || navigator.onLine)) {
        await flushAlarmActions(user.id, token);
      }
      const result = await alarmsApi.list(token);
      const items = sortAlarms(result.items);
      setAlarms(items);
      const sync = await alarmNative.sync(items);
      const scheduledCount = items.filter((item) => item.enabled && item.status === "scheduled").length;
      if (alarmNative.isAndroid() && scheduledCount > 0 && (!sync.exact || sync.failed > 0)) {
        setError("One or more alarms are saved but not armed. Enable exact alarm access before relying on them.");
      } else {
        setError("");
      }
    } catch (requestError) {
      setError(readableError(requestError));
    } finally {
      refreshRunning.current = false;
      setLoading(false);
    }
  }, [token, user?.id]);

  useEffect(() => {
    if (!token) {
      setAlarms([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void refresh();
    void refreshStatus();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        void refreshStatus();
      }
    };
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    let actionListener: { remove: () => Promise<void> } | null = null;
    void alarmNative.onAction(() => void refresh()).then((handle) => { actionListener = handle; });
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      void actionListener?.remove();
    };
  }, [refresh, refreshStatus, token]);

  useEffect(() => {
    if (alarmNative.isAndroid() || !alarms.some((alarm) => alarm.enabled && ["scheduled", "ringing"].includes(alarm.status))) return;
    void import("./webAwakeVerifier").then(({ prewarmWebAwakeVerifier }) => prewarmWebAwakeVerifier()).catch(() => undefined);
  }, [alarms]);

  useEffect(() => {
    if (!token || alarmNative.isAndroid()) return;
    const checkDue = () => {
      if (activeAlarm) return;
      const now = Date.now();
      const due = alarms.find((alarm) => alarm.enabled && ["scheduled", "ringing"].includes(alarm.status)
        && Date.parse(alarm.scheduled_at) <= now);
      if (!due) return;
      setActiveAlarm(due);
      void alarmsApi.action(token, due.id, "ringing").then((updated) => {
        setAlarms((items) => sortAlarms(items.map((item) => item.id === updated.id ? updated : item)));
        setActiveAlarm(updated);
      }).catch(() => undefined);
    };
    checkDue();
    const timer = window.setInterval(checkDue, 1_000);
    return () => window.clearInterval(timer);
  }, [activeAlarm, alarms, token]);

  const upsert = useCallback((updated: UserAlarm) => {
    setAlarms((items) => sortAlarms([...items.filter((item) => item.id !== updated.id), updated]));
    return updated;
  }, []);

  const ensureNativeAccess = useCallback(async () => {
    if (!alarmNative.isAndroid()) return;
    let status = await alarmNative.status();
    setNativeStatus(status);
    if (status.ready) return;
    await alarmNative.requestAccess();
    status = await alarmNative.status();
    setNativeStatus(status);
    if (!status.ready) throw new Error(accessMessage(status));
  }, []);

  const createAlarm = useCallback(async (payload: AlarmDraft) => {
    if (!token) throw new Error("Sign in to create an alarm.");
    setSaving(true);
    setError("");
    try {
      await ensureNativeAccess();
      const created = upsert(await alarmsApi.create(token, payload));
      const armed = await alarmNative.schedule(created);
      if (alarmNative.isAndroid() && (!armed.scheduled || !armed.exact)) {
        throw new Error("Alarm was saved to your account but Android did not arm it. Enable exact alarm access and re-enable this alarm.");
      }
      return created;
    } catch (requestError) {
      setError(readableError(requestError));
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [ensureNativeAccess, token, upsert]);

  const updateAlarm = useCallback(async (alarmId: string, payload: Partial<AlarmDraft> & { enabled?: boolean }) => {
    if (!token) throw new Error("Sign in to update an alarm.");
    setSaving(true);
    setError("");
    try {
      if (payload.enabled !== false) await ensureNativeAccess();
      const updated = upsert(await alarmsApi.update(token, alarmId, payload));
      if (updated.enabled) {
        const armed = await alarmNative.schedule(updated);
        if (alarmNative.isAndroid() && (!armed.scheduled || !armed.exact)) {
          throw new Error("Changes were saved, but Android did not arm this alarm. Enable exact alarm access and try again.");
        }
      }
      else await alarmNative.cancel(updated.id).catch(() => undefined);
      return updated;
    } catch (requestError) {
      setError(readableError(requestError));
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [ensureNativeAccess, token, upsert]);

  const deleteAlarm = useCallback(async (alarmId: string) => {
    if (!token) return;
    setSaving(true);
    setError("");
    try {
      await alarmsApi.remove(token, alarmId);
      setAlarms((items) => items.filter((item) => item.id !== alarmId));
      await alarmNative.cancel(alarmId).catch(() => undefined);
    } catch (requestError) {
      setError(readableError(requestError));
    } finally {
      setSaving(false);
    }
  }, [token]);

  const dismissAlarm = useCallback(async (alarmId: string) => {
    if (!token || !user) return;
    setError("");
    const current = alarms.find((alarm) => alarm.id === alarmId) ?? activeAlarm;
    const clientRevision = Math.max(1, (current?.revision ?? 0) + 1);
    setActiveAlarm(null);
    setAlarms((items) => items.filter((item) => item.id !== alarmId));
    try {
      await alarmsApi.action(token, alarmId, "dismiss", 10, { scheduledAt: current?.scheduled_at, clientRevision });
      await alarmNative.cancel(alarmId).catch(() => undefined);
    } catch (requestError) {
      enqueueAlarmAction({
        userId: user.id,
        alarmId,
        action: "dismiss",
        snoozeMinutes: 10,
        scheduledAt: current?.scheduled_at,
        clientRevision,
        queuedAt: new Date().toISOString(),
      });
      if (typeof navigator === "undefined" || navigator.onLine) setError(`${readableError(requestError)} The verified dismissal was saved offline and will sync automatically.`);
    }
  }, [activeAlarm, alarms, token, user]);

  const verifyAwake = useCallback(async (alarmId: string, photo: Blob) => {
    if (!token) throw new Error("Sign in to verify this alarm.");
    return alarmsApi.verifyAwake(token, alarmId, photo);
  }, [token]);

  const snoozeAlarm = useCallback(async (alarmId: string, minutes = 10) => {
    if (!token || !user) return;
    setError("");
    const current = alarms.find((alarm) => alarm.id === alarmId) ?? activeAlarm;
    const scheduledAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const clientRevision = Math.max(1, (current?.revision ?? 0) + 1);
    if (current) {
      upsert({
        ...current,
        scheduled_at: scheduledAt,
        enabled: true,
        status: "scheduled",
        snooze_count: current.snooze_count + 1,
        revision: clientRevision,
      });
    }
    setActiveAlarm(null);
    try {
      const updated = upsert(await alarmsApi.action(token, alarmId, "snooze", minutes, { scheduledAt, clientRevision }));
      await alarmNative.schedule(updated).catch(() => undefined);
    } catch (requestError) {
      enqueueAlarmAction({
        userId: user.id,
        alarmId,
        action: "snooze",
        snoozeMinutes: minutes,
        scheduledAt,
        clientRevision,
        queuedAt: new Date().toISOString(),
      });
      if (typeof navigator === "undefined" || navigator.onLine) setError(`${readableError(requestError)} Snooze was saved offline and will sync automatically.`);
    }
  }, [activeAlarm, alarms, token, upsert, user]);

  const previewAlarm = useCallback(async (alarm: UserAlarm) => {
    setError("");
    try {
      await alarmNative.preview(alarm);
    } catch (requestError) {
      setError(readableError(requestError));
    }
  }, []);

  const requestAlarmAccess = useCallback(async () => {
    setError("");
    try {
      const status = await alarmNative.requestAccess();
      setNativeStatus(status);
    } catch (requestError) {
      setError(readableError(requestError));
    }
  }, []);

  const nextAlarm = useMemo(() => alarms.find((alarm) => alarm.enabled && alarm.status === "scheduled" && Date.parse(alarm.scheduled_at) > Date.now()) ?? null, [alarms]);
  const value = useMemo<AlarmContextValue>(() => ({
    alarms,
    nextAlarm,
    activeAlarm,
    loading,
    saving,
    error,
    nativeStatus,
    refresh,
    createAlarm,
    updateAlarm,
    deleteAlarm,
    dismissAlarm,
    verifyAwake,
    snoozeAlarm,
    previewAlarm,
    requestAlarmAccess,
  }), [activeAlarm, alarms, createAlarm, deleteAlarm, dismissAlarm, error, loading, nativeStatus, nextAlarm, previewAlarm, refresh, requestAlarmAccess, saving, snoozeAlarm, updateAlarm, verifyAwake]);

  return <AlarmContext.Provider value={value}>{children}</AlarmContext.Provider>;
}

export function useAlarms() {
  const context = useContext(AlarmContext);
  if (!context) throw new Error("useAlarms must be used inside AlarmProvider.");
  return context;
}
