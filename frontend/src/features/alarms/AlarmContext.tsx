import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { alarmNative } from "./alarmNative";
import { alarmsApi } from "./alarmsApi";
import type { AlarmDraft, AlarmNativeStatus, UserAlarm } from "./types";

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

export function AlarmProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
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
      const result = await alarmsApi.list(token);
      const items = sortAlarms(result.items);
      setAlarms(items);
      setError("");
      await alarmNative.sync(items).catch(() => undefined);
    } catch (requestError) {
      setError(readableError(requestError));
    } finally {
      refreshRunning.current = false;
      setLoading(false);
    }
  }, [token]);

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
    document.addEventListener("visibilitychange", onVisible);
    let actionListener: { remove: () => Promise<void> } | null = null;
    void alarmNative.onAction(() => void refresh()).then((handle) => { actionListener = handle; });
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      void actionListener?.remove();
    };
  }, [refresh, refreshStatus, token]);

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

  const createAlarm = useCallback(async (payload: AlarmDraft) => {
    if (!token) throw new Error("Sign in to create an alarm.");
    setSaving(true);
    setError("");
    try {
      const created = upsert(await alarmsApi.create(token, payload));
      await alarmNative.schedule(created).catch(() => undefined);
      return created;
    } catch (requestError) {
      setError(readableError(requestError));
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [token, upsert]);

  const updateAlarm = useCallback(async (alarmId: string, payload: Partial<AlarmDraft> & { enabled?: boolean }) => {
    if (!token) throw new Error("Sign in to update an alarm.");
    setSaving(true);
    setError("");
    try {
      const updated = upsert(await alarmsApi.update(token, alarmId, payload));
      if (updated.enabled) await alarmNative.schedule(updated).catch(() => undefined);
      else await alarmNative.cancel(updated.id).catch(() => undefined);
      return updated;
    } catch (requestError) {
      setError(readableError(requestError));
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [token, upsert]);

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
    if (!token) return;
    setError("");
    try {
      const updated = await alarmsApi.action(token, alarmId, "dismiss");
      setActiveAlarm(null);
      setAlarms((items) => items.filter((item) => item.id !== updated.id));
      await alarmNative.cancel(alarmId).catch(() => undefined);
    } catch (requestError) {
      setError(readableError(requestError));
    }
  }, [token]);

  const snoozeAlarm = useCallback(async (alarmId: string, minutes = 10) => {
    if (!token) return;
    setError("");
    try {
      const updated = upsert(await alarmsApi.action(token, alarmId, "snooze", minutes));
      setActiveAlarm(null);
      await alarmNative.schedule(updated).catch(() => undefined);
    } catch (requestError) {
      setError(readableError(requestError));
    }
  }, [token, upsert]);

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
    snoozeAlarm,
    previewAlarm,
    requestAlarmAccess,
  }), [activeAlarm, alarms, createAlarm, deleteAlarm, dismissAlarm, error, loading, nativeStatus, nextAlarm, previewAlarm, refresh, requestAlarmAccess, saving, snoozeAlarm, updateAlarm]);

  return <AlarmContext.Provider value={value}>{children}</AlarmContext.Provider>;
}

export function useAlarms() {
  const context = useContext(AlarmContext);
  if (!context) throw new Error("useAlarms must be used inside AlarmProvider.");
  return context;
}
