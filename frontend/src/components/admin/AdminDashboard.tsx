import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  Ban,
  BarChart3,
  Coins,
  CreditCard,
  Database,
  Download,
  KeyRound,
  MessageSquare,
  RefreshCw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Trash2,
  Upload,
  UserCheck,
  Users,
  Wallet
} from "lucide-react";
import { API_BASE_URL, api, resolveApkDownloadUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type {
  AdminAnalytics,
  AdminFeaturesResponse,
  AdminPaymentRecord,
  AdminPlanLimit,
  AdminPlanName,
  AdminQuota,
  AdminStats,
  AdminSubscription,
  AdminUsageResponse,
  AdminUser,
  ApkRelease,
  ApkStats,
  UserRole
} from "../../types";

type AdminSection = "dashboard" | "users" | "tokens" | "subscriptions" | "usage" | "features" | "mobile" | "payments" | "settings";

const sections: Array<{ id: AdminSection; label: string; icon: ReactNode }> = [
  { id: "dashboard", label: "Dashboard", icon: <BarChart3 size={15} /> },
  { id: "users", label: "Users", icon: <Users size={15} /> },
  { id: "tokens", label: "Token Management", icon: <Coins size={15} /> },
  { id: "subscriptions", label: "Subscriptions", icon: <CreditCard size={15} /> },
  { id: "usage", label: "Usage Analytics", icon: <Activity size={15} /> },
  { id: "features", label: "Feature Controls", icon: <SlidersHorizontal size={15} /> },
  { id: "mobile", label: "Mobile App", icon: <Smartphone size={15} /> },
  { id: "payments", label: "Payments", icon: <Wallet size={15} /> },
  { id: "settings", label: "Settings", icon: <Settings size={15} /> }
];

const plans: AdminPlanName[] = ["free", "pro", "premium", "ultra", "admin", "pro-plus"];

type QuotaForm = {
  plan_name: string;
  token_limit_monthly: string;
  daily_message_limit: string;
  bonus_tokens: string;
  addAmount: string;
  addReason: string;
  deductAmount: string;
  deductReason: string;
};

type ApkUploadForm = {
  version_name: string;
  version_code: string;
  changelog: string;
  release_notes: string;
  force_update: boolean;
};

type ConfirmAction = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
};

type PlanLimitEditableField =
  | "daily_prompt_limit"
  | "monthly_prompt_limit"
  | "daily_token_limit"
  | "monthly_token_limit"
  | "max_models"
  | "allow_deep_research"
  | "allow_multi_model"
  | "allow_web_search";

const planLimitEditableFields: PlanLimitEditableField[] = [
  "daily_prompt_limit",
  "monthly_prompt_limit",
  "daily_token_limit",
  "monthly_token_limit",
  "max_models",
  "allow_deep_research",
  "allow_multi_model",
  "allow_web_search"
];

function StatTile({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) {
  return (
    <div className="admin-stat-tile rounded-lg border border-white/10 bg-white/[0.055] p-4 shadow-[0_18px_45px_rgba(0,0,0,0.22)] backdrop-blur">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-cyan-200 text-slate-950">{icon}</div>
      <p className="text-xs font-semibold uppercase text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "No expiry";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value));
}

function formatDateTime(value?: string | null) {
  if (!value) return "Pending";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function dateInputValue(value?: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function money(cents = 0, currency = "INR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
}

function formatBytes(bytes?: number | null) {
  if (!bytes) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function quotaToForm(quota?: AdminQuota | null): QuotaForm {
  return {
    plan_name: quota?.plan_name ?? "Free",
    token_limit_monthly: String(quota?.token_limit_monthly ?? 10000),
    daily_message_limit: String(quota?.daily_message_limit ?? 25),
    bonus_tokens: String(quota?.bonus_tokens ?? 0),
    addAmount: "",
    addReason: "",
    deductAmount: "",
    deductReason: ""
  };
}

function quotaProgress(quota?: AdminQuota | null) {
  if (!quota || quota.token_limit_monthly <= 0) return 0;
  const total = quota.token_limit_monthly + quota.bonus_tokens;
  return total > 0 ? Math.min(100, Math.round((quota.tokens_used_monthly / total) * 100)) : 0;
}

function planLimitPatch(original: AdminPlanLimit, draft: AdminPlanLimit): Partial<AdminPlanLimit> {
  const payload: Partial<AdminPlanLimit> = {};
  for (const field of planLimitEditableFields) {
    if (draft[field] !== original[field]) {
      payload[field] = draft[field] as never;
    }
  }
  return payload;
}

function hasPlanLimitPatch(original: AdminPlanLimit, draft: AdminPlanLimit) {
  return planLimitEditableFields.some((field) => draft[field] !== original[field]);
}

function mapPlanLimitsByPlan(limits: AdminPlanLimit[] = []) {
  return Object.fromEntries(limits.map((limit) => [limit.plan, limit])) as Record<string, AdminPlanLimit>;
}

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={active ? "text-emerald-300" : "text-red-300"}>
      {label}
    </span>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="text-sm text-slate-400">{subtitle}</p>
    </div>
  );
}

export function AdminDashboard() {
  const { token, user } = useAuth();
  const [activeSection, setActiveSection] = useState<AdminSection>("dashboard");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([]);
  const [usage, setUsage] = useState<AdminUsageResponse | null>(null);
  const [features, setFeatures] = useState<AdminFeaturesResponse | null>(null);
  const [planLimitDrafts, setPlanLimitDrafts] = useState<Record<string, AdminPlanLimit>>({});
  const [payments, setPayments] = useState<AdminPaymentRecord[]>([]);
  const [apkVersions, setApkVersions] = useState<ApkRelease[]>([]);
  const [apkStats, setApkStats] = useState<ApkStats | null>(null);
  const [apkFile, setApkFile] = useState<File | null>(null);
  const [apkUploadForm, setApkUploadForm] = useState<ApkUploadForm>({
    version_name: "",
    version_code: "",
    changelog: "",
    release_notes: "",
    force_update: false
  });
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [featureUserId, setFeatureUserId] = useState("");
  const [query, setQuery] = useState("");
  const [quotaQuery, setQuotaQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [createAdminForm, setCreateAdminForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    role: "admin" as Extract<UserRole, "admin" | "super_admin">
  });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [quotaForms, setQuotaForms] = useState<Record<string, QuotaForm>>({});
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const isSuperAdmin = user?.role === "super_admin";

  const loadAdminData = useCallback(async () => {
    if (!token || !isAdmin) {
      setLoading(false);
      return;
    }
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const [nextStats, nextUsers, nextSubscriptions, nextUsage, nextFeatures, nextAnalytics, nextPayments, nextApkVersions, nextApkStats] =
        await Promise.all([
          api.adminStats(token),
          api.adminUsers(token),
          api.adminSubscriptions(token),
          api.adminUsage(token),
          api.adminFeatures(token),
          api.adminAnalytics(token),
          api.adminPayments(token),
          api.apkVersions(),
          api.apkStats()
        ]);
      setStats(nextStats);
      setUsers(nextUsers);
      setSubscriptions(nextSubscriptions);
      setUsage(nextUsage);
      setFeatures(nextFeatures);
      setAnalytics(nextAnalytics);
      setPayments(nextPayments);
      setApkVersions(nextApkVersions);
      setApkStats(nextApkStats);
      setSelectedUser((current) => nextUsers.find((item) => item.id === current?.id) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load admin panel");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, token]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    setPlanLimitDrafts(mapPlanLimitsByPlan(features?.plan_limits ?? []));
  }, [features?.plan_limits]);

  const planLimitRows = useMemo(
    () => (features?.plan_limits ?? []).map((plan) => planLimitDrafts[plan.plan] ?? plan),
    [features?.plan_limits, planLimitDrafts]
  );

  const changedPlanLimits = useMemo(() => {
    const originals = mapPlanLimitsByPlan(features?.plan_limits ?? []);
    return planLimitRows.filter((draft) => {
      const original = originals[draft.plan];
      return original ? hasPlanLimitPatch(original, draft) : false;
    });
  }, [features?.plan_limits, planLimitRows]);

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();
    return users.filter((account) => {
      const matchesSearch =
        !term ||
        account.name.toLowerCase().includes(term) ||
        account.email.toLowerCase().includes(term) ||
        (account.mobile ?? "").toLowerCase().includes(term);
      const matchesRole = !roleFilter || account.role === roleFilter;
      const matchesStatus = !statusFilter || account.status === statusFilter;
      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [query, roleFilter, statusFilter, users]);

  const filteredQuotaUsers = useMemo(() => {
    const term = quotaQuery.trim().toLowerCase();
    return users.filter((account) => {
      if (!term) return true;
      return account.name.toLowerCase().includes(term) || account.email.toLowerCase().includes(term);
    });
  }, [quotaQuery, users]);

  function upsertUser(account: AdminUser) {
    setUsers((current) => current.map((item) => (item.id === account.id ? account : item)));
    setSelectedUser((current) => (current?.id === account.id ? account : current));
  }

  function updateQuotaForm(userId: string, patch: Partial<QuotaForm>) {
    setQuotaForms((current) => ({
      ...current,
      [userId]: { ...(current[userId] ?? quotaToForm(users.find((item) => item.id === userId)?.quota)), ...patch }
    }));
  }

  function upsertQuota(quota: AdminQuota) {
    setUsers((current) =>
      current.map((account) =>
        account.id === quota.user_id
          ? {
              ...account,
              status: quota.status,
              quota
            }
          : account
      )
    );
    setSelectedUser((current) => (current?.id === quota.user_id ? { ...current, quota } : current));
    setQuotaForms((current) => ({ ...current, [quota.user_id]: { ...(current[quota.user_id] ?? quotaToForm(quota)), ...quotaToForm(quota) } }));
  }

  async function saveQuota(account: AdminUser, force = false) {
    if (!token || !account.quota) return;
    const form = quotaForms[account.id] ?? quotaToForm(account.quota);
    const payload = {
      plan_name: form.plan_name.trim() || "Free",
      token_limit_monthly: numberValue(form.token_limit_monthly),
      daily_message_limit: numberValue(form.daily_message_limit),
      bonus_tokens: numberValue(form.bonus_tokens),
      force
    };
    if (!force && payload.token_limit_monthly > 0 && payload.token_limit_monthly + payload.bonus_tokens < account.quota.tokens_used_monthly) {
      setConfirmAction({
        title: "Force quota change",
        message: `${account.email} has already used ${account.quota.tokens_used_monthly.toLocaleString()} tokens. Save anyway?`,
        confirmLabel: "Save anyway",
        onConfirm: () => saveQuota(account, true)
      });
      return;
    }
    setBusyId(`quota-${account.id}`);
    setError("");
    setSuccess("");
    try {
      const updated = await api.updateAdminUserQuota(token, account.id, payload);
      upsertQuota(updated);
      setSuccess(`Quota updated for ${account.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update quota");
    } finally {
      setBusyId(null);
    }
  }

  async function addTokens(account: AdminUser) {
    if (!token || !account.quota) return;
    const form = quotaForms[account.id] ?? quotaToForm(account.quota);
    const amount = numberValue(form.addAmount);
    setBusyId(`quota-add-${account.id}`);
    setError("");
    setSuccess("");
    try {
      const updated = await api.addAdminUserTokens(token, account.id, { amount, reason: form.addReason.trim() });
      upsertQuota(updated);
      updateQuotaForm(account.id, { addAmount: "", addReason: "" });
      setSuccess(`${amount.toLocaleString()} tokens added to ${account.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add tokens");
    } finally {
      setBusyId(null);
    }
  }

  async function deductTokens(account: AdminUser) {
    if (!token || !account.quota) return;
    const form = quotaForms[account.id] ?? quotaToForm(account.quota);
    const amount = numberValue(form.deductAmount);
    setConfirmAction({
      title: "Deduct tokens",
      message: `Deduct ${amount.toLocaleString()} tokens from ${account.email}?`,
      confirmLabel: "Deduct",
      onConfirm: async () => {
        setBusyId(`quota-deduct-${account.id}`);
        setError("");
        setSuccess("");
        try {
          const updated = await api.deductAdminUserTokens(token, account.id, { amount, reason: form.deductReason.trim() });
          upsertQuota(updated);
          updateQuotaForm(account.id, { deductAmount: "", deductReason: "" });
          setSuccess(`${amount.toLocaleString()} tokens deducted from ${account.email}.`);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Unable to deduct tokens");
        } finally {
          setBusyId(null);
        }
      }
    });
  }

  async function resetTokens(account: AdminUser) {
    if (!token || !account.quota) return;
    setConfirmAction({
      title: "Reset monthly usage",
      message: `Reset monthly token and daily message usage for ${account.email}?`,
      confirmLabel: "Reset",
      onConfirm: async () => {
        setBusyId(`quota-reset-${account.id}`);
        setError("");
        setSuccess("");
        try {
          const updated = await api.resetAdminUserTokens(token, account.id);
          upsertQuota(updated);
          setSuccess(`Usage reset for ${account.email}.`);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Unable to reset usage");
        } finally {
          setBusyId(null);
        }
      }
    });
  }

  async function setUserStatus(account: AdminUser, isActive: boolean) {
    if (!token || account.id === user?.id) return;
    if (!window.confirm(`${isActive ? "Unblock" : "Block"} ${account.email}?`)) return;
    setBusyId(account.id);
    setError("");
    try {
      const updated = await api.updateAdminUserStatus(token, account.id, isActive);
      upsertUser(updated);
      setStats(await api.adminStats(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update user status");
    } finally {
      setBusyId(null);
    }
  }

  async function createAdmin(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError("");
    setSuccess("");
    if (createAdminForm.password !== createAdminForm.confirmPassword) {
      setError("Password and confirm password do not match.");
      return;
    }
    setBusyId("create-admin");
    try {
      const created = await api.createAdminUser(token, {
        name: createAdminForm.name.trim(),
        email: createAdminForm.email.trim().toLowerCase(),
        password: createAdminForm.password,
        role: createAdminForm.role
      });
      setUsers((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setSelectedUser(created);
      setCreateAdminForm({ name: "", email: "", password: "", confirmPassword: "", role: "admin" });
      setSuccess(`${created.email} created as ${created.role}.`);
      const [nextStats, nextSubscriptions] = await Promise.all([api.adminStats(token), api.adminSubscriptions(token)]);
      setStats(nextStats);
      setSubscriptions(nextSubscriptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create admin");
    } finally {
      setBusyId(null);
    }
  }

  async function setUserRole(account: AdminUser, role: UserRole) {
    if (!token || account.role === role) return;
    if (account.id === user?.id && role !== "admin") return;
    setBusyId(account.id);
    setError("");
    try {
      const updated = await api.updateAdminUserRole(token, account.id, role);
      upsertUser(updated);
      setSubscriptions(await api.adminSubscriptions(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update role");
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(account: AdminUser) {
    if (!token) return;
    if (!window.confirm(`Reset password for ${account.email}?`)) return;
    const nextPassword = window.prompt(`New password for ${account.email}`);
    if (!nextPassword) return;
    setBusyId(account.id);
    setError("");
    try {
      const updated = await api.resetAdminUserPassword(token, account.id, nextPassword);
      upsertUser(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset password");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteUser(account: AdminUser) {
    if (!token || account.id === user?.id) return;
    if (!window.confirm(`Delete ${account.email}? This cannot be undone.`)) return;
    setBusyId(account.id);
    setError("");
    try {
      await api.deleteAdminUser(token, account.id);
      setUsers((current) => current.filter((item) => item.id !== account.id));
      setSelectedUser((current) => (current?.id === account.id ? null : current));
      const [nextStats, nextSubscriptions, nextUsage] = await Promise.all([
        api.adminStats(token),
        api.adminSubscriptions(token),
        api.adminUsage(token)
      ]);
      setStats(nextStats);
      setSubscriptions(nextSubscriptions);
      setUsage(nextUsage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete user");
    } finally {
      setBusyId(null);
    }
  }

  async function updateSubscription(account: AdminSubscription, payload: Partial<AdminSubscription>) {
    if (!token) return;
    if (payload.is_active === false && !window.confirm(`Deactivate subscription for ${account.user_email}?`)) return;
    setBusyId(account.user_id);
    setError("");
    try {
      const updated = await api.updateAdminSubscription(token, account.user_id, payload);
      setSubscriptions((current) => current.map((item) => (item.user_id === updated.user_id ? updated : item)));
      const [nextStats, nextUsers] = await Promise.all([api.adminStats(token), api.adminUsers(token)]);
      setStats(nextStats);
      setUsers(nextUsers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update subscription");
    } finally {
      setBusyId(null);
    }
  }

  async function activateLifetime(account: AdminSubscription) {
    if (!token) return;
    if (!window.confirm(`Activate lifetime ${account.plan} for ${account.user_email}?`)) return;
    setBusyId(`lifetime-${account.user_id}`);
    setError("");
    try {
      const updated = await api.activateLifetimeSubscription(token, account.user_id);
      setSubscriptions((current) => current.map((item) => (item.user_id === updated.user_id ? updated : item)));
      setUsers(await api.adminUsers(token));
      setSuccess(`Lifetime plan activated for ${account.user_email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to activate lifetime plan");
    } finally {
      setBusyId(null);
    }
  }

  async function suspendSubscription(account: AdminSubscription) {
    if (!token) return;
    if (!window.confirm(`Suspend subscription for ${account.user_email}?`)) return;
    setBusyId(`suspend-${account.user_id}`);
    setError("");
    try {
      const updated = await api.suspendAdminSubscription(token, account.user_id);
      setSubscriptions((current) => current.map((item) => (item.user_id === updated.user_id ? updated : item)));
      setUsers(await api.adminUsers(token));
      setSuccess(`Subscription suspended for ${account.user_email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to suspend subscription");
    } finally {
      setBusyId(null);
    }
  }

  async function refundPayment(payment: AdminPaymentRecord) {
    if (!token) return;
    if (!window.confirm(`Refund ${money(payment.amount_cents, payment.currency)} for ${payment.user_email ?? payment.user_id ?? "this payment"}?`)) return;
    setBusyId(`refund-${payment.id}`);
    setError("");
    try {
      const updated = await api.refundAdminPayment(token, payment.id);
      setPayments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setStats(await api.adminStats(token));
      setSuccess(`Payment ${payment.id} refunded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to refund payment");
    } finally {
      setBusyId(null);
    }
  }

  async function downloadAdminInvoice(payment: AdminPaymentRecord) {
    if (!token || !payment.invoice_url) return;
    setBusyId(`invoice-${payment.id}`);
    setError("");
    try {
      const apiOrigin = API_BASE_URL.replace(/\/api\/v1\/?$/, "");
      const response = await fetch(`${apiOrigin}${payment.invoice_url}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error("Unable to download invoice");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `auto-ai-invoice-${payment.id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to download invoice");
    } finally {
      setBusyId(null);
    }
  }

  async function reloadFeaturesForUser(userId: string) {
    if (!token) return;
    setFeatureUserId(userId);
    setError("");
    try {
      setFeatures(await api.adminFeatures(token, userId || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load feature overrides");
    }
  }

  async function toggleFeature(key: string, enabled: boolean, userId?: string | null) {
    if (!token) return;
    const busyKey = `${userId ?? "global"}-${key}`;
    setBusyId(busyKey);
    setError("");
    try {
      const updated = await api.updateAdminFeature(token, key, enabled, userId);
      setFeatures((current) =>
        current
          ? {
              ...current,
              flags: current.flags.some((flag) => flag.id === updated.id)
                ? current.flags.map((flag) => (flag.id === updated.id ? updated : flag))
                : [...current.flags, updated]
            }
          : current
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update feature");
    } finally {
      setBusyId(null);
    }
  }

  function updatePlanLimitDraft(plan: AdminPlanLimit, field: PlanLimitEditableField, value: AdminPlanLimit[PlanLimitEditableField]) {
    setPlanLimitDrafts((current) => ({
      ...current,
      [plan.plan]: {
        ...(current[plan.plan] ?? plan),
        [field]: value
      }
    }));
  }

  function resetPlanLimitDrafts() {
    setPlanLimitDrafts(mapPlanLimitsByPlan(features?.plan_limits ?? []));
  }

  async function savePlanLimits() {
    if (!token || !features || changedPlanLimits.length === 0) return;
    const originals = mapPlanLimitsByPlan(features.plan_limits);
    setBusyId("plan-limits-save");
    setError("");
    setSuccess("");
    try {
      const updatedLimits = await Promise.all(
        changedPlanLimits.map((draft) => {
          const original = originals[draft.plan];
          return api.updateAdminPlanLimit(token, draft.plan, planLimitPatch(original, draft));
        })
      );
      const updatedByPlan = mapPlanLimitsByPlan(updatedLimits);
      setFeatures({
        ...features,
        plan_limits: features.plan_limits.map((item) => updatedByPlan[item.plan] ?? item)
      });
      const [nextUsers, nextSubscriptions, nextUsage] = await Promise.all([
        api.adminUsers(token),
        api.adminSubscriptions(token),
        api.adminUsage(token)
      ]);
      setUsers(nextUsers);
      setSubscriptions(nextSubscriptions);
      setUsage(nextUsage);
      setSelectedUser((current) => nextUsers.find((item) => item.id === current?.id) ?? null);
      setSuccess("Plan limits saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save plan limits");
    } finally {
      setBusyId(null);
    }
  }

  async function refreshApkData() {
    const [nextVersions, nextStats] = await Promise.all([api.apkVersions(), api.apkStats()]);
    setApkVersions(nextVersions);
    setApkStats(nextStats);
  }

  async function uploadApk(event: FormEvent) {
    event.preventDefault();
    if (!token || !apkFile) {
      setError("Select an APK file to upload.");
      return;
    }
    const formData = new FormData();
    formData.append("file", apkFile);
    if (apkUploadForm.version_name.trim()) formData.append("version_name", apkUploadForm.version_name.trim());
    if (apkUploadForm.version_code.trim()) formData.append("version_code", String(numberValue(apkUploadForm.version_code)));
    if (apkUploadForm.changelog.trim()) formData.append("changelog", apkUploadForm.changelog.trim());
    if (apkUploadForm.release_notes.trim()) formData.append("release_notes", apkUploadForm.release_notes.trim());
    formData.append("force_update", String(apkUploadForm.force_update));
    setBusyId("apk-upload");
    setError("");
    setSuccess("");
    try {
      const release = await api.uploadApkRelease(token, formData);
      setApkVersions((current) => [release, ...current.filter((item) => item.id !== release.id)]);
      setApkUploadForm({ version_name: "", version_code: "", changelog: "", release_notes: "", force_update: false });
      setApkFile(null);
      await refreshApkData();
      setSuccess(`APK ${release.version_name} uploaded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload APK");
    } finally {
      setBusyId(null);
    }
  }

  async function updateApk(release: ApkRelease, payload: Partial<Pick<ApkRelease, "changelog" | "force_update" | "release_notes" | "is_active">>) {
    if (!token) return;
    setBusyId(`apk-${release.id}`);
    setError("");
    setSuccess("");
    try {
      const updated = await api.updateApkRelease(token, release.id, payload);
      setApkVersions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      await refreshApkData();
      setSuccess(`APK ${updated.version_name} updated.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update APK release");
    } finally {
      setBusyId(null);
    }
  }

  async function downloadApkRelease(release: ApkRelease) {
    setBusyId(`apk-download-${release.id}`);
    setError("");
    try {
      const counted = await api.countApkDownload({ id: release.id });
      setApkVersions((current) => current.map((item) => (item.id === counted.id ? counted : item)));
      setApkStats((current) =>
        current
          ? {
              ...current,
              latest: current.latest?.id === counted.id ? counted : current.latest,
              total_downloads: current.total_downloads + 1,
              downloads_by_version: {
                ...current.downloads_by_version,
                [counted.version_name]: counted.download_count
              }
            }
          : current
      );
      window.location.href = resolveApkDownloadUrl(counted, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to record APK download");
      window.location.href = resolveApkDownloadUrl(release);
    } finally {
      setBusyId(null);
    }
  }

  if (!isAdmin) {
    return <div className="admin-dashboard-page min-h-0 flex-1 overflow-y-auto p-6 text-sm text-slate-300">Admin access required.</div>;
  }

  return (
    <div className="admin-dashboard-page min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Admin Control Center</h1>
          <p className="mt-1 text-sm text-slate-400">Users, plans, usage, features, payments, and system settings</p>
        </div>
        <button className="btn-secondary" onClick={loadAdminData} type="button">
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {sections.map((section) => (
          <button
            key={section.id}
            className={activeSection === section.id ? "chip-dark chip-dark-active" : "chip-dark"}
            onClick={() => setActiveSection(section.id)}
            type="button"
          >
            {section.icon}
            {section.label}
          </button>
        ))}
      </div>

      {error && <p className="mb-4 rounded-md border border-red-300/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</p>}
      {success && <p className="mb-4 rounded-md border border-emerald-300/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">{success}</p>}

      {loading ? (
        <p className="text-sm text-slate-400">Loading admin panel...</p>
      ) : (
        <>
          {activeSection === "dashboard" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
                <StatTile icon={<Users size={18} />} label="Total users" value={stats?.total_users ?? 0} />
                <StatTile icon={<UserCheck size={18} />} label="Active users" value={stats?.active_users ?? 0} />
                <StatTile icon={<Ban size={18} />} label="Blocked users" value={stats?.blocked_users ?? 0} />
                <StatTile icon={<MessageSquare size={18} />} label="Chats" value={stats?.total_chats ?? 0} />
                <StatTile icon={<Activity size={18} />} label="API calls" value={stats?.total_api_usage ?? 0} />
                <StatTile icon={<CreditCard size={18} />} label="Paid plans" value={stats?.paid_subscriptions ?? 0} />
              </div>

              <div className="mt-6 grid gap-4 xl:grid-cols-2">
                <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
                  <SectionTitle title="Usage by provider" subtitle="Groq, Bedrock, OpenAI, Gemini totals" />
                  <div className="space-y-3">
                    {(analytics?.usage_by_provider ?? usage?.providers ?? []).map((item) => (
                      <div key={item.provider} className="flex items-center justify-between border-b border-white/10 pb-2 text-sm">
                        <span className="font-semibold text-white">{item.provider}</span>
                        <span className="text-slate-300">{item.requests} calls / {item.total_tokens.toLocaleString()} tokens</span>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
                  <SectionTitle title="System" subtitle="Runtime and storage status" />
                  <div className="grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                    <div>Environment: <span className="text-white">{stats?.system.environment}</span></div>
                    <div>Database: <span className="text-white">{stats?.system.database_backend}</span></div>
                    <div>Python: <span className="text-white">{stats?.system.python_version}</span></div>
                    <div>Free storage: <span className="text-white">{stats?.system.storage_free_gb} GB</span></div>
                    <div>Total revenue: <span className="text-white">{money(stats?.total_revenue_cents ?? 0)}</span></div>
                    <div>Total tokens: <span className="text-white">{(stats?.token_usage.total_tokens ?? 0).toLocaleString()}</span></div>
                  </div>
                </section>
              </div>
            </>
          )}

          {activeSection === "users" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045]">
              <div className="border-b border-white/10 p-4">
                <SectionTitle title="Users" subtitle="Search, block, delete, reset passwords, and create admins" />
                <form onSubmit={createAdmin} className="mb-4 rounded-lg border border-cyan-200/15 bg-slate-950/35 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Create Admin</h3>
                      <p className="text-xs text-slate-400">Only existing admins can create admin or super admin accounts.</p>
                    </div>
                    <button className="btn-secondary h-9" disabled={busyId === "create-admin"} type="submit">
                      {busyId === "create-admin" ? "Creating" : "Create Admin"}
                    </button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-5">
                    <input
                      className="input-dark"
                      minLength={2}
                      placeholder="Name"
                      required
                      value={createAdminForm.name}
                      onChange={(event) => setCreateAdminForm((current) => ({ ...current, name: event.target.value }))}
                    />
                    <input
                      className="input-dark"
                      placeholder="Email"
                      required
                      type="email"
                      value={createAdminForm.email}
                      onChange={(event) => setCreateAdminForm((current) => ({ ...current, email: event.target.value }))}
                    />
                    <input
                      className="input-dark"
                      minLength={8}
                      placeholder="Password"
                      required
                      type="password"
                      value={createAdminForm.password}
                      onChange={(event) => setCreateAdminForm((current) => ({ ...current, password: event.target.value }))}
                    />
                    <input
                      className="input-dark"
                      minLength={8}
                      placeholder="Confirm password"
                      required
                      type="password"
                      value={createAdminForm.confirmPassword}
                      onChange={(event) => setCreateAdminForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                    />
                    <select
                      className="model-select-dark h-11"
                      value={createAdminForm.role}
                      onChange={(event) =>
                        setCreateAdminForm((current) => ({
                          ...current,
                          role: event.target.value as Extract<UserRole, "admin" | "super_admin">
                        }))
                      }
                    >
                      <option value="admin">Admin</option>
                      {isSuperAdmin && <option value="super_admin">Super Admin</option>}
                    </select>
                  </div>
                </form>
                <div className="grid gap-3 md:grid-cols-[1fr_160px_160px]">
                  <label className="relative">
                    <Search className="pointer-events-none absolute left-3 top-3 text-slate-500" size={16} />
                    <input className="input-dark pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, mobile" />
                  </label>
                  <select className="model-select-dark h-11" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                    <option value="">All roles</option>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                    <option value="super_admin">Super Admin</option>
                  </select>
                  <select className="model-select-dark h-11" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                    <option value="">All status</option>
                    <option value="active">Active</option>
                    <option value="blocked">Blocked</option>
                  </select>
                </div>
              </div>

              {selectedUser && (
                <div className="grid gap-3 border-b border-white/10 p-4 text-sm text-slate-300 md:grid-cols-4">
                  <div><span className="text-slate-500">Profile</span><br /><span className="font-semibold text-white">{selectedUser.name}</span></div>
                  <div><span className="text-slate-500">Account</span><br /><StatusPill active={selectedUser.is_active} label={selectedUser.status} /></div>
                  <div><span className="text-slate-500">Plan</span><br /><span className="text-white">{selectedUser.subscription?.plan ?? "free"}</span></div>
                  <div><span className="text-slate-500">Usage</span><br /><span className="text-white">{selectedUser.usage?.total_prompts ?? 0} prompts</span></div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Email / Mobile</th>
                      <th className="px-4 py-3">Role</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Usage</th>
                      <th className="px-4 py-3">Created</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {filteredUsers.map((account) => {
                      const isSelf = account.id === user?.id;
                      const busy = busyId === account.id;
                      return (
                        <tr key={account.id} className="text-slate-200">
                          <td className="px-4 py-3">
                            <button className="text-left font-semibold text-white hover:text-cyan-200" onClick={() => setSelectedUser(account)} type="button">
                              {account.name}
                            </button>
                            {isSelf && <div className="text-xs text-cyan-200">Current admin</div>}
                          </td>
                          <td className="px-4 py-3">
                            <div>{account.email}</div>
                            <div className="text-xs text-slate-400">{account.mobile || "No mobile"}</div>
                          </td>
                          <td className="px-4 py-3">
                            <select
                              className="model-select-dark"
                              value={account.role}
                              disabled={busy || isSelf || (!isSuperAdmin && account.role === "super_admin")}
                              onChange={(event) => setUserRole(account, event.target.value as UserRole)}
                            >
                              <option value="user">User</option>
                              <option value="admin">Admin</option>
                              {(isSuperAdmin || account.role === "super_admin") && <option value="super_admin">Super Admin</option>}
                            </select>
                          </td>
                          <td className="px-4 py-3"><StatusPill active={account.is_active} label={account.status} /></td>
                          <td className="px-4 py-3 capitalize">{account.subscription?.plan ?? "free"}</td>
                          <td className="px-4 py-3">{account.usage?.total_prompts ?? 0} prompts</td>
                          <td className="px-4 py-3 text-slate-300">{formatDate(account.created_at)}</td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-2">
                              <button className="chip-dark" disabled={busy || isSelf} onClick={() => setUserStatus(account, !account.is_active)} type="button">
                                {account.is_active ? "Block" : "Unblock"}
                              </button>
                              <button className="icon-button-dark" disabled={busy} onClick={() => resetPassword(account)} title="Reset password" type="button">
                                <KeyRound size={16} />
                              </button>
                              <button className="icon-button-danger" disabled={busy || isSelf} onClick={() => deleteUser(account)} title="Delete user" type="button">
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeSection === "tokens" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045]">
              <div className="border-b border-white/10 p-4">
                <SectionTitle title="User Token Management" subtitle="Adjust monthly quota, bonus tokens, daily messages, and usage resets" />
                <div className="relative max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                  <input
                    className="input-dark h-10 pl-9"
                    placeholder="Search users by name or email"
                    value={quotaQuery}
                    onChange={(event) => setQuotaQuery(event.target.value)}
                  />
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1440px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Monthly limit</th>
                      <th className="px-4 py-3">Used / Balance</th>
                      <th className="px-4 py-3">Bonus</th>
                      <th className="px-4 py-3">Daily messages</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Add tokens</th>
                      <th className="px-4 py-3">Deduct tokens</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {filteredQuotaUsers.map((account) => {
                      const quota = account.quota;
                      const form = quotaForms[account.id] ?? quotaToForm(quota);
                      const busy = busyId?.includes(account.id);
                      const progress = quotaProgress(quota);
                      return (
                        <tr key={account.id} className="align-top text-slate-200">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-white">{account.name}</div>
                            <div className="text-xs text-slate-400">{account.email}</div>
                          </td>
                          <td className="px-4 py-3">
                            <input
                              className="input-dark h-9 min-w-[120px]"
                              value={form.plan_name}
                              onChange={(event) => updateQuotaForm(account.id, { plan_name: event.target.value })}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input
                              className="input-dark h-9 min-w-[130px]"
                              min={0}
                              type="number"
                              value={form.token_limit_monthly}
                              onChange={(event) => updateQuotaForm(account.id, { token_limit_monthly: event.target.value })}
                            />
                          </td>
                          <td className="px-4 py-3 min-w-[220px]">
                            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                              <span>{(quota?.tokens_used_monthly ?? 0).toLocaleString()} used</span>
                              <span>{quota?.token_limit_monthly === 0 ? "Unlimited" : `${(quota?.token_balance ?? 0).toLocaleString()} left`}</span>
                            </div>
                            <div className="h-2 rounded-full bg-slate-800">
                              <div className="h-2 rounded-full bg-cyan-300" style={{ width: `${progress}%` }} />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <input
                              className="input-dark h-9 min-w-[110px]"
                              min={0}
                              type="number"
                              value={form.bonus_tokens}
                              onChange={(event) => updateQuotaForm(account.id, { bonus_tokens: event.target.value })}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <input
                                className="input-dark h-9 w-24"
                                min={0}
                                type="number"
                                value={form.daily_message_limit}
                                onChange={(event) => updateQuotaForm(account.id, { daily_message_limit: event.target.value })}
                              />
                              <span className="text-xs text-slate-400">{quota?.messages_used_today ?? 0} used</span>
                            </div>
                          </td>
                          <td className="px-4 py-3"><StatusPill active={account.is_active} label={account.status} /></td>
                          <td className="px-4 py-3">
                            <div className="grid min-w-[190px] gap-2">
                              <input
                                className="input-dark h-9"
                                min={0}
                                placeholder="Amount"
                                type="number"
                                value={form.addAmount}
                                onChange={(event) => updateQuotaForm(account.id, { addAmount: event.target.value })}
                              />
                              <input
                                className="input-dark h-9"
                                placeholder="Reason"
                                value={form.addReason}
                                onChange={(event) => updateQuotaForm(account.id, { addReason: event.target.value })}
                              />
                              <button className="chip-dark" disabled={busy} onClick={() => addTokens(account)} type="button">Add</button>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="grid min-w-[190px] gap-2">
                              <input
                                className="input-dark h-9"
                                min={0}
                                placeholder="Amount"
                                type="number"
                                value={form.deductAmount}
                                onChange={(event) => updateQuotaForm(account.id, { deductAmount: event.target.value })}
                              />
                              <input
                                className="input-dark h-9"
                                placeholder="Reason"
                                value={form.deductReason}
                                onChange={(event) => updateQuotaForm(account.id, { deductReason: event.target.value })}
                              />
                              <button className="chip-dark" disabled={busy} onClick={() => deductTokens(account)} type="button">Deduct</button>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex min-w-[170px] flex-wrap gap-2">
                              <button className="btn-secondary h-9" disabled={busy || !quota} onClick={() => saveQuota(account)} type="button">Save</button>
                              <button className="chip-dark" disabled={busy || !quota} onClick={() => resetTokens(account)} type="button">Reset</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredQuotaUsers.length === 0 && (
                      <tr><td className="px-4 py-6 text-sm text-slate-400" colSpan={10}>No users found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeSection === "subscriptions" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045]">
              <div className="border-b border-white/10 p-4">
                <SectionTitle title="Subscriptions" subtitle="Plans, activation, expiry, payment status, Razorpay and Stripe IDs" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1500px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Active</th>
                      <th className="px-4 py-3">Expiry</th>
                      <th className="px-4 py-3">Payment</th>
                      <th className="px-4 py-3">Quota</th>
                      <th className="px-4 py-3">Renewal</th>
                      <th className="px-4 py-3">Razorpay</th>
                      <th className="px-4 py-3">Stripe</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {subscriptions.map((subscription) => (
                      <tr key={subscription.id} className="text-slate-200">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white">{subscription.user_name}</div>
                          <div className="text-xs text-slate-400">{subscription.user_email}</div>
                        </td>
                        <td className="px-4 py-3">
                          <select className="model-select-dark" value={subscription.plan} disabled={busyId === subscription.user_id} onChange={(event) => updateSubscription(subscription, { plan: event.target.value as AdminPlanName })}>
                            {plans.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
                          </select>
                        </td>
                        <td className="px-4 py-3">
                          <button className={subscription.is_active ? "chip-dark chip-dark-active" : "chip-dark"} disabled={busyId === subscription.user_id} onClick={() => updateSubscription(subscription, { is_active: !subscription.is_active })} type="button">
                            {subscription.is_active ? "Active" : "Inactive"}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <input className="input-dark h-9" type="date" defaultValue={dateInputValue(subscription.expires_at)} onBlur={(event) => updateSubscription(subscription, { expires_at: event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : null })} />
                        </td>
                        <td className="px-4 py-3">
                          <input className="input-dark h-9" defaultValue={subscription.payment_status} onBlur={(event) => updateSubscription(subscription, { payment_status: event.currentTarget.value })} />
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <div>{subscription.tokens_used_monthly.toLocaleString()} used</div>
                          <div>{subscription.token_balance.toLocaleString()} left</div>
                          <div>{subscription.token_limit_monthly === 0 ? "Unlimited" : subscription.token_limit_monthly.toLocaleString()} monthly</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button className={subscription.auto_renewal ? "chip-dark chip-dark-active" : "chip-dark"} disabled={busyId === subscription.user_id} onClick={() => updateSubscription(subscription, { auto_renewal: !subscription.auto_renewal })} type="button">
                              Auto {subscription.auto_renewal ? "On" : "Off"}
                            </button>
                            <button className={subscription.is_lifetime ? "chip-dark chip-dark-active" : "chip-dark"} disabled={busyId === subscription.user_id} onClick={() => updateSubscription(subscription, { is_lifetime: !subscription.is_lifetime })} type="button">
                              {subscription.is_lifetime ? "Lifetime" : "Timed"}
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <input className="input-dark mb-2 h-9" placeholder="Customer ID" defaultValue={subscription.razorpay_customer_id ?? ""} onBlur={(event) => updateSubscription(subscription, { razorpay_customer_id: event.currentTarget.value || null })} />
                          <input className="input-dark h-9" placeholder="Payment ID" defaultValue={subscription.razorpay_payment_id ?? ""} onBlur={(event) => updateSubscription(subscription, { razorpay_payment_id: event.currentTarget.value || null })} />
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <input className="input-dark mb-2 h-9" placeholder="Customer ID" defaultValue={subscription.stripe_customer_id ?? ""} onBlur={(event) => updateSubscription(subscription, { stripe_customer_id: event.currentTarget.value || null })} />
                          <input className="input-dark h-9" placeholder="Payment ID" defaultValue={subscription.stripe_payment_id ?? ""} onBlur={(event) => updateSubscription(subscription, { stripe_payment_id: event.currentTarget.value || null })} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex min-w-[180px] flex-wrap gap-2">
                            <button className="chip-dark" disabled={busyId === `lifetime-${subscription.user_id}`} onClick={() => activateLifetime(subscription)} type="button">
                              Lifetime
                            </button>
                            <button className="chip-dark" disabled={busyId === `suspend-${subscription.user_id}`} onClick={() => suspendSubscription(subscription)} type="button">
                              Suspend
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeSection === "usage" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
              <SectionTitle title="Usage Analytics" subtitle="Per-user prompts, tokens, provider usage, daily and monthly totals" />
              <div className="mb-5 grid gap-4 md:grid-cols-4">
                {(usage?.providers ?? []).map((item) => (
                  <StatTile key={item.provider} icon={<Database size={18} />} label={item.provider} value={`${item.requests} calls`} />
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Prompts</th>
                      <th className="px-4 py-3">Prompt tokens</th>
                      <th className="px-4 py-3">Completion tokens</th>
                      <th className="px-4 py-3">Total tokens</th>
                      <th className="px-4 py-3">Providers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {(usage?.users ?? []).map((item) => (
                      <tr key={item.user_id} className="text-slate-200">
                        <td className="px-4 py-3"><div className="font-semibold text-white">{item.user_name}</div><div className="text-xs text-slate-400">{item.user_email}</div></td>
                        <td className="px-4 py-3">{item.plan}</td>
                        <td className="px-4 py-3">{item.total_prompts.toLocaleString()}</td>
                        <td className="px-4 py-3">{item.prompt_tokens.toLocaleString()}</td>
                        <td className="px-4 py-3">{item.completion_tokens.toLocaleString()}</td>
                        <td className="px-4 py-3">{item.total_tokens.toLocaleString()}</td>
                        <td className="px-4 py-3">{item.providers.map((provider) => `${provider.provider}: ${provider.requests}`).join(", ") || "None"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeSection === "features" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
              <SectionTitle title="Feature Controls" subtitle="Enable or disable global and per-user capabilities" />
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {(features?.flags ?? []).filter((flag) => flag.scope === "global").map((flag) => (
                    <div key={flag.id} className="rounded-lg border border-white/10 bg-slate-950/35 p-4">
                      <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-white">{flag.key.replace(/_/g, " ")}</p>
                        <p className="mt-1 text-xs text-slate-400">{flag.description}</p>
                      </div>
                      <button className={flag.enabled ? "chip-dark chip-dark-active" : "chip-dark"} disabled={busyId === `global-${flag.key}`} onClick={() => toggleFeature(flag.key, !flag.enabled)} type="button">
                        {flag.enabled ? "On" : "Off"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 border-t border-white/10 pt-4">
                <div className="mb-3 grid gap-3 md:grid-cols-[260px_1fr]">
                  <select className="model-select-dark h-11" value={featureUserId} onChange={(event) => reloadFeaturesForUser(event.target.value)}>
                    <option value="">Global only</option>
                    {users.map((account) => (
                      <option key={account.id} value={account.id}>{account.email}</option>
                    ))}
                  </select>
                  <p className="text-sm text-slate-400">Select a user to create or update per-user feature overrides.</p>
                </div>
                {featureUserId && (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {(features?.flags ?? []).filter((flag) => flag.scope === "global").map((globalFlag) => {
                      const override = features?.flags.find((flag) => flag.scope === "user" && flag.user_id === featureUserId && flag.key === globalFlag.key);
                      const enabled = override?.enabled ?? globalFlag.enabled;
                      return (
                        <div key={`user-${globalFlag.key}`} className="rounded-lg border border-white/10 bg-slate-950/35 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold text-white">{globalFlag.key.replace(/_/g, " ")}</p>
                              <p className="mt-1 text-xs text-slate-400">{override ? "User override active" : "Using global default"}</p>
                            </div>
                            <button
                              className={enabled ? "chip-dark chip-dark-active" : "chip-dark"}
                              disabled={busyId === `${featureUserId}-${globalFlag.key}`}
                              onClick={() => toggleFeature(globalFlag.key, !enabled, featureUserId)}
                              type="button"
                            >
                              {enabled ? "On" : "Off"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {activeSection === "mobile" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
              <SectionTitle title="Mobile Application" subtitle="Upload APK releases, edit changelog, force updates, and track downloads" />
              <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <StatTile icon={<Smartphone size={18} />} label="Latest version" value={apkStats?.latest?.version_name ?? "None"} />
                <StatTile icon={<Upload size={18} />} label="Version code" value={apkStats?.latest?.version_code ?? 0} />
                <StatTile icon={<Download size={18} />} label="Downloads" value={apkStats?.total_downloads ?? 0} />
                <StatTile icon={<Activity size={18} />} label="Released" value={formatDateTime(apkStats?.latest?.released_at ?? apkStats?.latest?.release_date)} />
                <StatTile icon={<RefreshCw size={18} />} label="Updated" value={formatDateTime(apkStats?.latest?.updated_at)} />
              </div>
              <div className="mb-5 rounded-lg border border-white/10 bg-slate-950/35 p-4">
                <p className="text-xs font-semibold uppercase text-slate-400">Latest changelog</p>
                <p className="mt-2 text-sm text-slate-200">{apkStats?.latest?.changelog || "No changelog available."}</p>
              </div>

              <form className="mb-6 grid gap-3 rounded-lg border border-white/10 bg-slate-950/35 p-4 xl:grid-cols-[1fr_120px_1fr_1fr_auto]" onSubmit={uploadApk}>
                <input
                  accept=".apk,application/vnd.android.package-archive"
                  className="input-dark h-11"
                  onChange={(event) => setApkFile(event.currentTarget.files?.[0] ?? null)}
                  type="file"
                />
                <input
                  className="input-dark h-11"
                  placeholder="Version code"
                  type="number"
                  value={apkUploadForm.version_code}
                  onChange={(event) => setApkUploadForm((current) => ({ ...current, version_code: event.target.value }))}
                />
                <input
                  className="input-dark h-11"
                  placeholder="Version name"
                  value={apkUploadForm.version_name}
                  onChange={(event) => setApkUploadForm((current) => ({ ...current, version_name: event.target.value }))}
                />
                <input
                  className="input-dark h-11"
                  placeholder="Changelog"
                  value={apkUploadForm.changelog}
                  onChange={(event) => setApkUploadForm((current) => ({ ...current, changelog: event.target.value }))}
                />
                <button className="btn-primary h-11" disabled={busyId === "apk-upload"} type="submit">
                  <Upload size={16} />
                  Upload
                </button>
                <textarea
                  className="input-dark min-h-20 xl:col-span-4"
                  placeholder="Release notes, one per line"
                  value={apkUploadForm.release_notes}
                  onChange={(event) => setApkUploadForm((current) => ({ ...current, release_notes: event.target.value }))}
                />
                <label className="flex h-11 items-center gap-2 text-sm text-slate-200">
                  <input
                    checked={apkUploadForm.force_update}
                    onChange={(event) => setApkUploadForm((current) => ({ ...current, force_update: event.target.checked }))}
                    type="checkbox"
                  />
                  Force update
                </label>
              </form>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Version</th>
                      <th className="px-4 py-3">Released</th>
                      <th className="px-4 py-3">Updated</th>
                      <th className="px-4 py-3">Size</th>
                      <th className="px-4 py-3">Downloads</th>
                      <th className="px-4 py-3">Changelog</th>
                      <th className="px-4 py-3">Force</th>
                      <th className="px-4 py-3">Latest</th>
                      <th className="px-4 py-3">Download</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {apkVersions.map((release) => {
                      const busy = busyId === `apk-${release.id}`;
                      return (
                        <tr key={release.id} className="text-slate-200">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-white">{release.version_name}</div>
                            <div className="text-xs text-slate-400">Code {release.version_code}</div>
                          </td>
                          <td className="px-4 py-3">{formatDateTime(release.released_at ?? release.release_date)}</td>
                          <td className="px-4 py-3">{formatDateTime(release.updated_at)}</td>
                          <td className="px-4 py-3">{formatBytes(release.file_size)}</td>
                          <td className="px-4 py-3">{release.download_count.toLocaleString()}</td>
                          <td className="px-4 py-3">
                            <textarea
                              className="input-dark min-h-20 min-w-[280px]"
                              defaultValue={release.changelog}
                              onBlur={(event) => {
                                const next = event.currentTarget.value.trim();
                                if (next !== release.changelog) void updateApk(release, { changelog: next });
                              }}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <button
                              className={release.force_update ? "chip-dark chip-dark-active" : "chip-dark"}
                              disabled={busy}
                              onClick={() => updateApk(release, { force_update: !release.force_update })}
                              type="button"
                            >
                              {release.force_update ? "On" : "Off"}
                            </button>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              className={release.is_active ? "chip-dark chip-dark-active" : "chip-dark"}
                              disabled={busy || release.is_active}
                              onClick={() => updateApk(release, { is_active: true })}
                              type="button"
                            >
                              {release.is_active ? "Latest" : "Set latest"}
                            </button>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              className="chip-dark"
                              disabled={busy || busyId === `apk-download-${release.id}`}
                              onClick={() => downloadApkRelease(release)}
                              type="button"
                            >
                              <Download size={15} />
                              APK
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {apkVersions.length === 0 && (
                      <tr><td className="px-4 py-6 text-sm text-slate-400" colSpan={9}>No APK versions uploaded yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeSection === "payments" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045]">
              <div className="border-b border-white/10 p-4">
                <SectionTitle title="Payments" subtitle="Recorded Razorpay/Stripe/manual payment records" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1280px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Subscription</th>
                      <th className="px-4 py-3">Customer / Payment</th>
                      <th className="px-4 py-3">Paid</th>
                      <th className="px-4 py-3">Created</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {payments.map((payment) => (
                      <tr key={payment.id} className="text-slate-200">
                        <td className="px-4 py-3"><div className="font-semibold text-white">{payment.user_name ?? "Unknown"}</div><div className="text-xs text-slate-400">{payment.user_email ?? payment.user_id ?? "No user"}</div></td>
                        <td className="px-4 py-3">{payment.provider}</td>
                        <td className="px-4 py-3">{payment.plan}</td>
                        <td className="px-4 py-3">{money(payment.amount_cents, payment.currency)}</td>
                        <td className="px-4 py-3">{payment.status}</td>
                        <td className="px-4 py-3">{payment.subscription_status ?? "No subscription"}</td>
                        <td className="px-4 py-3 text-xs"><div>{payment.customer_id ?? "No customer ID"}</div><div>{payment.razorpay_payment_id ?? payment.payment_id ?? "No payment ID"}</div><div>{payment.razorpay_order_id ?? payment.subscription_id ?? "No order ID"}</div></td>
                        <td className="px-4 py-3">{payment.paid_at ? formatDate(payment.paid_at) : "Not paid"}</td>
                        <td className="px-4 py-3">{formatDate(payment.created_at)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            {payment.invoice_url && (
                              <button className="chip-dark" disabled={busyId === `invoice-${payment.id}`} onClick={() => downloadAdminInvoice(payment)} type="button">
                                <Download size={14} />
                                Invoice
                              </button>
                            )}
                            <button className="chip-dark" disabled={busyId === `refund-${payment.id}` || payment.status === "refunded"} onClick={() => refundPayment(payment)} type="button">
                              <RefreshCw size={14} />
                              Refund
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {payments.length === 0 && (
                      <tr><td className="px-4 py-6 text-sm text-slate-400" colSpan={10}>No payment records yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeSection === "settings" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-white">Settings</h2>
                  <p className="text-sm text-slate-400">Plan limits used for usage enforcement</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="chip-dark"
                    disabled={busyId === "plan-limits-save" || changedPlanLimits.length === 0}
                    onClick={resetPlanLimitDrafts}
                    type="button"
                  >
                    Reset
                  </button>
                  <button
                    className="btn-primary h-10"
                    disabled={busyId === "plan-limits-save" || changedPlanLimits.length === 0}
                    onClick={savePlanLimits}
                    type="button"
                  >
                    <Save size={15} />
                    {busyId === "plan-limits-save" ? "Saving" : "Save"}
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Daily prompts</th>
                      <th className="px-4 py-3">Monthly prompts</th>
                      <th className="px-4 py-3">Daily tokens</th>
                      <th className="px-4 py-3">Monthly tokens</th>
                      <th className="px-4 py-3">Max models</th>
                      <th className="px-4 py-3">Feature access</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {planLimitRows.map((plan) => {
                      const original = features?.plan_limits.find((item) => item.plan === plan.plan);
                      const changed = original ? hasPlanLimitPatch(original, plan) : false;
                      return (
                        <tr key={plan.id} className={changed ? "bg-cyan-300/[0.045] text-slate-200" : "text-slate-200"}>
                          <td className="px-4 py-3 font-semibold text-white">{plan.plan}</td>
                          <td className="px-4 py-3"><LimitButton value={plan.daily_prompt_limit} onSave={(value) => updatePlanLimitDraft(plan, "daily_prompt_limit", value)} /></td>
                          <td className="px-4 py-3"><LimitButton value={plan.monthly_prompt_limit} onSave={(value) => updatePlanLimitDraft(plan, "monthly_prompt_limit", value)} /></td>
                          <td className="px-4 py-3"><LimitButton value={plan.daily_token_limit} onSave={(value) => updatePlanLimitDraft(plan, "daily_token_limit", value)} /></td>
                          <td className="px-4 py-3"><LimitButton value={plan.monthly_token_limit} onSave={(value) => updatePlanLimitDraft(plan, "monthly_token_limit", value)} /></td>
                          <td className="px-4 py-3"><LimitButton value={plan.max_models} onSave={(value) => updatePlanLimitDraft(plan, "max_models", value)} /></td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              <button className={plan.allow_deep_research ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => updatePlanLimitDraft(plan, "allow_deep_research", !plan.allow_deep_research)} type="button">Deep</button>
                              <button className={plan.allow_multi_model ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => updatePlanLimitDraft(plan, "allow_multi_model", !plan.allow_multi_model)} type="button">Multi</button>
                              <button className={plan.allow_web_search ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => updatePlanLimitDraft(plan, "allow_web_search", !plan.allow_web_search)} type="button">Web</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <div className="w-full max-w-sm rounded-lg border border-white/10 bg-slate-950 p-5 shadow-2xl">
            <h2 className="text-lg font-semibold text-white">{confirmAction.title}</h2>
            <p className="mt-2 text-sm text-slate-300">{confirmAction.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="chip-dark" onClick={() => setConfirmAction(null)} type="button">Cancel</button>
              <button
                className="btn-primary h-10"
                onClick={() => {
                  const action = confirmAction;
                  setConfirmAction(null);
                  void action.onConfirm();
                }}
                type="button"
              >
                {confirmAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LimitButton({ value, onSave }: { value: number; onSave: (value: number) => void }) {
  return (
    <button
      className="chip-dark"
      onClick={() => {
        const next = window.prompt("Set limit. Use 0 for unlimited.", String(value));
        if (next === null) return;
        const parsed = Number(next);
        if (Number.isFinite(parsed) && parsed >= 0) onSave(Math.floor(parsed));
      }}
      type="button"
    >
      {value === 0 ? "Unlimited" : value.toLocaleString()}
    </button>
  );
}
