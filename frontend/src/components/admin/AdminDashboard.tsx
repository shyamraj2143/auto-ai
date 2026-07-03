import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Ban,
  BarChart3,
  CreditCard,
  Database,
  KeyRound,
  MessageSquare,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  Users,
  Wallet
} from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type {
  AdminAnalytics,
  AdminFeaturesResponse,
  AdminPaymentRecord,
  AdminPlanLimit,
  AdminPlanName,
  AdminStats,
  AdminSubscription,
  AdminUsageResponse,
  AdminUser
} from "../../types";

type AdminSection = "dashboard" | "users" | "subscriptions" | "usage" | "features" | "payments" | "settings";

const sections: Array<{ id: AdminSection; label: string; icon: ReactNode }> = [
  { id: "dashboard", label: "Dashboard", icon: <BarChart3 size={15} /> },
  { id: "users", label: "Users", icon: <Users size={15} /> },
  { id: "subscriptions", label: "Subscriptions", icon: <CreditCard size={15} /> },
  { id: "usage", label: "Usage Analytics", icon: <Activity size={15} /> },
  { id: "features", label: "Feature Controls", icon: <SlidersHorizontal size={15} /> },
  { id: "payments", label: "Payments", icon: <Wallet size={15} /> },
  { id: "settings", label: "Settings", icon: <Settings size={15} /> }
];

const plans: AdminPlanName[] = ["free", "pro", "pro-plus", "admin"];

function StatTile({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.055] p-4 shadow-[0_18px_45px_rgba(0,0,0,0.22)] backdrop-blur">
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

function dateInputValue(value?: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function money(cents = 0, currency = "INR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
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
  const [payments, setPayments] = useState<AdminPaymentRecord[]>([]);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [featureUserId, setFeatureUserId] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const isAdmin = user?.role === "admin";

  const loadAdminData = useCallback(async () => {
    if (!token || !isAdmin) {
      setLoading(false);
      return;
    }
    setError("");
    setLoading(true);
    try {
      const [nextStats, nextUsers, nextSubscriptions, nextUsage, nextFeatures, nextAnalytics, nextPayments] =
        await Promise.all([
          api.adminStats(token),
          api.adminUsers(token),
          api.adminSubscriptions(token),
          api.adminUsage(token),
          api.adminFeatures(token),
          api.adminAnalytics(token),
          api.adminPayments(token)
        ]);
      setStats(nextStats);
      setUsers(nextUsers);
      setSubscriptions(nextSubscriptions);
      setUsage(nextUsage);
      setFeatures(nextFeatures);
      setAnalytics(nextAnalytics);
      setPayments(nextPayments);
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

  function upsertUser(account: AdminUser) {
    setUsers((current) => current.map((item) => (item.id === account.id ? account : item)));
    setSelectedUser((current) => (current?.id === account.id ? account : current));
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

  async function setUserRole(account: AdminUser, role: "user" | "admin") {
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

  async function updatePlanLimit(plan: AdminPlanLimit, field: keyof AdminPlanLimit, value: unknown) {
    if (!token) return;
    setBusyId(`${plan.plan}-${String(field)}`);
    setError("");
    try {
      const updated = await api.updateAdminPlanLimit(token, plan.plan, { [field]: value });
      setFeatures((current) =>
        current
          ? { ...current, plan_limits: current.plan_limits.map((item) => (item.plan === updated.plan ? updated : item)) }
          : current
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update plan limit");
    } finally {
      setBusyId(null);
    }
  }

  if (!isAdmin) {
    return <div className="min-h-0 flex-1 overflow-y-auto p-6 text-sm text-slate-300">Admin access required.</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
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
                <SectionTitle title="Users" subtitle="Search, block, delete, reset passwords, and change roles" />
                <div className="grid gap-3 md:grid-cols-[1fr_160px_160px]">
                  <label className="relative">
                    <Search className="pointer-events-none absolute left-3 top-3 text-slate-500" size={16} />
                    <input className="input-dark pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, mobile" />
                  </label>
                  <select className="model-select-dark h-11" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                    <option value="">All roles</option>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
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
                            <select className="model-select-dark" value={account.role} disabled={busy || isSelf} onChange={(event) => setUserRole(account, event.target.value as "user" | "admin")}>
                              <option value="user">User</option>
                              <option value="admin">Admin</option>
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

          {activeSection === "subscriptions" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045]">
              <div className="border-b border-white/10 p-4">
                <SectionTitle title="Subscriptions" subtitle="Plans, activation, expiry, payment status, Razorpay and Stripe IDs" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Active</th>
                      <th className="px-4 py-3">Expiry</th>
                      <th className="px-4 py-3">Payment</th>
                      <th className="px-4 py-3">Razorpay</th>
                      <th className="px-4 py-3">Stripe</th>
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
                          <input className="input-dark mb-2 h-9" placeholder="Customer ID" defaultValue={subscription.razorpay_customer_id ?? ""} onBlur={(event) => updateSubscription(subscription, { razorpay_customer_id: event.currentTarget.value || null })} />
                          <input className="input-dark h-9" placeholder="Payment ID" defaultValue={subscription.razorpay_payment_id ?? ""} onBlur={(event) => updateSubscription(subscription, { razorpay_payment_id: event.currentTarget.value || null })} />
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <input className="input-dark mb-2 h-9" placeholder="Customer ID" defaultValue={subscription.stripe_customer_id ?? ""} onBlur={(event) => updateSubscription(subscription, { stripe_customer_id: event.currentTarget.value || null })} />
                          <input className="input-dark h-9" placeholder="Payment ID" defaultValue={subscription.stripe_payment_id ?? ""} onBlur={(event) => updateSubscription(subscription, { stripe_payment_id: event.currentTarget.value || null })} />
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

          {activeSection === "payments" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045]">
              <div className="border-b border-white/10 p-4">
                <SectionTitle title="Payments" subtitle="Recorded Razorpay/Stripe/manual payment records" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                  <thead className="bg-white/[0.035] text-xs uppercase text-slate-400">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Plan</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Customer / Payment</th>
                      <th className="px-4 py-3">Created</th>
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
                        <td className="px-4 py-3 text-xs"><div>{payment.customer_id ?? "No customer ID"}</div><div>{payment.payment_id ?? "No payment ID"}</div></td>
                        <td className="px-4 py-3">{formatDate(payment.created_at)}</td>
                      </tr>
                    ))}
                    {payments.length === 0 && (
                      <tr><td className="px-4 py-6 text-sm text-slate-400" colSpan={7}>No payment records yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeSection === "settings" && (
            <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
              <SectionTitle title="Settings" subtitle="Plan limits used for usage enforcement" />
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
                    {(features?.plan_limits ?? []).map((plan) => (
                      <tr key={plan.id} className="text-slate-200">
                        <td className="px-4 py-3 font-semibold text-white">{plan.plan}</td>
                        <td className="px-4 py-3"><LimitButton value={plan.daily_prompt_limit} onSave={(value) => updatePlanLimit(plan, "daily_prompt_limit", value)} /></td>
                        <td className="px-4 py-3"><LimitButton value={plan.monthly_prompt_limit} onSave={(value) => updatePlanLimit(plan, "monthly_prompt_limit", value)} /></td>
                        <td className="px-4 py-3"><LimitButton value={plan.daily_token_limit} onSave={(value) => updatePlanLimit(plan, "daily_token_limit", value)} /></td>
                        <td className="px-4 py-3"><LimitButton value={plan.monthly_token_limit} onSave={(value) => updatePlanLimit(plan, "monthly_token_limit", value)} /></td>
                        <td className="px-4 py-3"><LimitButton value={plan.max_models} onSave={(value) => updatePlanLimit(plan, "max_models", value)} /></td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button className={plan.allow_deep_research ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => updatePlanLimit(plan, "allow_deep_research", !plan.allow_deep_research)} type="button">Deep</button>
                            <button className={plan.allow_multi_model ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => updatePlanLimit(plan, "allow_multi_model", !plan.allow_multi_model)} type="button">Multi</button>
                            <button className={plan.allow_web_search ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => updatePlanLimit(plan, "allow_web_search", !plan.allow_web_search)} type="button">Web</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
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
