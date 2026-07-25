import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Archive, Check, Copy, Edit3, Plus, RefreshCw, Search, Tag, X } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { PaidPricingPlanName, PromoCode, PromoCodePayload } from "../../types";

const paidPlans: PaidPricingPlanName[] = ["pro", "premium", "ultra"];

const emptyForm: PromoCodePayload = {
  code: "",
  description: "",
  discount_type: "percentage",
  discount_value: 10,
  currency: null,
  eligible_plans: [...paidPlans],
  minimum_amount: null,
  maximum_discount: null,
  starts_at: null,
  expires_at: null,
  total_usage_limit: null,
  per_user_limit: 1,
  is_active: true,
  new_users_only: false
};

function dateTimeInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function nullableNumber(value: string) {
  return value.trim() === "" ? null : Number(value);
}

function promoToForm(promo: PromoCode): PromoCodePayload {
  return {
    code: promo.code,
    description: promo.description,
    discount_type: promo.discount_type,
    discount_value: Number(promo.discount_value),
    currency: promo.currency,
    eligible_plans: promo.eligible_plans,
    minimum_amount: promo.minimum_amount == null ? null : Number(promo.minimum_amount),
    maximum_discount: promo.maximum_discount == null ? null : Number(promo.maximum_discount),
    starts_at: dateTimeInput(promo.starts_at),
    expires_at: dateTimeInput(promo.expires_at),
    total_usage_limit: promo.total_usage_limit,
    per_user_limit: promo.per_user_limit,
    is_active: promo.is_active,
    new_users_only: promo.new_users_only
  };
}

function normalizePayload(form: PromoCodePayload): PromoCodePayload {
  return {
    ...form,
    code: form.code.trim().toUpperCase(),
    description: form.description.trim(),
    currency: form.discount_type === "fixed" ? (form.currency || "INR").toUpperCase() : null,
    maximum_discount: form.discount_type === "percentage" ? form.maximum_discount : null,
    starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : null,
    expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null
  };
}

export function AdminPromoCodes() {
  const { token } = useAuth();
  const [items, setItems] = useState<PromoCode[]>([]);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState<PromoCode | null>(null);
  const [form, setForm] = useState<PromoCodePayload>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [copiedId, setCopiedId] = useState("");

  const load = useCallback(async (next: { query?: string; status?: string; page?: number } = {}) => {
    if (!token) return;
    const nextQuery = next.query ?? query;
    const nextStatus = next.status ?? status;
    const nextPage = next.page ?? page;
    setLoading(true);
    setError("");
    try {
      const result = await api.adminPromoCodes(token, { query: nextQuery, status: nextStatus, page: nextPage, pageSize: 20 });
      setItems(result.items);
      setPage(result.page);
      setTotalPages(result.total_pages);
      setTotal(result.total);
      setQuery(nextQuery);
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load promo codes.");
    } finally {
      setLoading(false);
    }
  }, [page, query, status, token]);

  useEffect(() => {
    void load({ query: "", status: "all", page: 1 });
  }, [token]);

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm, eligible_plans: [...paidPlans] });
    setShowForm(true);
    setError("");
  }

  function openEdit(promo: PromoCode) {
    setEditing(promo);
    setForm(promoToForm(promo));
    setShowForm(true);
    setError("");
  }

  function togglePlan(plan: PaidPricingPlanName) {
    setForm((current) => ({
      ...current,
      eligible_plans: current.eligible_plans.includes(plan)
        ? current.eligible_plans.filter((item) => item !== plan)
        : [...current.eligible_plans, plan]
    }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy("save");
    setError("");
    setSuccess("");
    try {
      const payload = normalizePayload(form);
      if (editing) {
        const changes = { ...payload } as Partial<PromoCodePayload>;
        delete changes.code;
        await api.adminUpdatePromoCode(token, editing.id, changes);
        setSuccess(`${editing.code} updated.`);
      } else {
        await api.adminCreatePromoCode(token, payload);
        setSuccess(`${payload.code} created.`);
      }
      setShowForm(false);
      setEditing(null);
      await load({ page: 1 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save promo code.");
    } finally {
      setBusy("");
    }
  }

  async function toggleActive(promo: PromoCode) {
    if (!token) return;
    setBusy(promo.id);
    setError("");
    try {
      await api.adminUpdatePromoCode(token, promo.id, { is_active: !promo.is_active });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update promo status.");
    } finally {
      setBusy("");
    }
  }

  async function archive(promo: PromoCode) {
    if (!token || !window.confirm(`Archive ${promo.code}? Existing redemption history will remain available.`)) return;
    setBusy(promo.id);
    setError("");
    try {
      await api.adminArchivePromoCode(token, promo.id, true);
      setSuccess(`${promo.code} archived.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to archive promo code.");
    } finally {
      setBusy("");
    }
  }

  async function copyCode(promo: PromoCode) {
    await navigator.clipboard.writeText(promo.code);
    setCopiedId(promo.id);
    window.setTimeout(() => setCopiedId(""), 1200);
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.045]">
      <div className="border-b border-white/10 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-lg font-semibold text-white">Promo Codes</h2><p className="text-sm text-slate-400">Create, restrict, monitor, deactivate, and archive checkout discounts.</p></div>
          <button className="btn-primary h-10" onClick={openCreate} type="button"><Plus size={15} /> New promo</button>
        </div>
        <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void load({ query: queryDraft, page: 1 }); }}>
          <label className="relative min-w-[240px] flex-1"><Search className="absolute left-3 top-3 text-slate-500" size={15} /><input className="input-dark h-10 w-full pl-9" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="Search code or note" /></label>
          <select className="model-select-dark h-10" value={status} onChange={(event) => void load({ status: event.target.value, page: 1 })}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="scheduled">Scheduled</option><option value="expired">Expired</option><option value="archived">Archived</option></select>
          <button className="chip-dark" type="submit">Search</button>
          {(query || status !== "all") && <button className="chip-dark" onClick={() => { setQueryDraft(""); void load({ query: "", status: "all", page: 1 }); }} type="button"><X size={14} /> Clear</button>}
          <button className="chip-dark" disabled={loading} onClick={() => void load()} type="button"><RefreshCw size={14} /> Refresh</button>
        </form>
      </div>

      {(error || success) && <div className={`m-4 rounded-md border p-3 text-sm ${error ? "border-red-400/25 bg-red-400/10 text-red-200" : "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"}`}>{error || success}</div>}

      {showForm && (
        <form className="m-4 grid gap-3 rounded-lg border border-cyan-300/20 bg-slate-950/45 p-4 md:grid-cols-2 xl:grid-cols-3" onSubmit={save}>
          <div className="md:col-span-2 xl:col-span-3 flex items-center justify-between"><strong className="text-white">{editing ? `Edit ${editing.code}` : "Create promo code"}</strong><button className="chip-dark" onClick={() => setShowForm(false)} type="button"><X size={14} /> Close</button></div>
          <label className="cms-field"><span>Code</span><input required minLength={3} maxLength={40} disabled={Boolean(editing)} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })} /></label>
          <label className="cms-field"><span>Discount type</span><select value={form.discount_type} onChange={(event) => setForm({ ...form, discount_type: event.target.value as PromoCodePayload["discount_type"] })}><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option></select></label>
          <label className="cms-field"><span>Discount value</span><input required min="0.01" max={form.discount_type === "percentage" ? 100 : undefined} step="0.01" type="number" value={form.discount_value} onChange={(event) => setForm({ ...form, discount_value: Number(event.target.value) })} /></label>
          {form.discount_type === "fixed" && <label className="cms-field"><span>Currency</span><input required maxLength={3} value={form.currency || "INR"} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></label>}
          <label className="cms-field"><span>Minimum purchase</span><input min="0" step="0.01" type="number" value={form.minimum_amount ?? ""} onChange={(event) => setForm({ ...form, minimum_amount: nullableNumber(event.target.value) })} /></label>
          {form.discount_type === "percentage" && <label className="cms-field"><span>Maximum discount</span><input min="0.01" step="0.01" type="number" value={form.maximum_discount ?? ""} onChange={(event) => setForm({ ...form, maximum_discount: nullableNumber(event.target.value) })} /></label>}
          <label className="cms-field"><span>Valid from</span><input type="datetime-local" value={form.starts_at || ""} onChange={(event) => setForm({ ...form, starts_at: event.target.value || null })} /></label>
          <label className="cms-field"><span>Valid until</span><input type="datetime-local" value={form.expires_at || ""} onChange={(event) => setForm({ ...form, expires_at: event.target.value || null })} /></label>
          <label className="cms-field"><span>Total usage limit</span><input min="1" type="number" value={form.total_usage_limit ?? ""} onChange={(event) => setForm({ ...form, total_usage_limit: nullableNumber(event.target.value) })} /></label>
          <label className="cms-field"><span>Per-user limit</span><input required min="1" type="number" value={form.per_user_limit} onChange={(event) => setForm({ ...form, per_user_limit: Number(event.target.value) })} /></label>
          <label className="cms-field md:col-span-2 xl:col-span-3"><span>Internal note</span><textarea maxLength={1000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
          <fieldset className="md:col-span-2"><legend className="mb-2 text-xs font-semibold uppercase text-slate-400">Eligible plans</legend><div className="flex flex-wrap gap-2">{paidPlans.map((plan) => <label className="chip-dark cursor-pointer" key={plan}><input checked={form.eligible_plans.includes(plan)} onChange={() => togglePlan(plan)} type="checkbox" /> {plan}</label>)}</div></fieldset>
          <div className="flex flex-wrap items-end gap-3"><label className="chip-dark cursor-pointer"><input checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} type="checkbox" /> Active</label><label className="chip-dark cursor-pointer"><input checked={form.new_users_only} onChange={(event) => setForm({ ...form, new_users_only: event.target.checked })} type="checkbox" /> New users only</label></div>
          <div className="md:col-span-2 xl:col-span-3"><button className="btn-primary" disabled={busy === "save" || form.eligible_plans.length === 0} type="submit"><Tag size={15} /> {busy === "save" ? "Saving..." : editing ? "Save changes" : "Create promo"}</button></div>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-left text-sm">
          <thead className="bg-white/[0.035] text-xs uppercase text-slate-400"><tr><th className="px-4 py-3">Code</th><th className="px-4 py-3">Discount</th><th className="px-4 py-3">Plans</th><th className="px-4 py-3">Validity</th><th className="px-4 py-3">Usage</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th></tr></thead>
          <tbody className="divide-y divide-white/10">
            {items.map((promo) => <tr className="text-slate-200" key={promo.id}><td className="px-4 py-3"><strong className="text-white">{promo.code}</strong><p className="max-w-[240px] truncate text-xs text-slate-400" title={promo.description}>{promo.description || "No internal note"}</p></td><td className="px-4 py-3">{promo.discount_type === "percentage" ? `${promo.discount_value}%` : `${promo.currency} ${promo.discount_value}`}</td><td className="px-4 py-3 capitalize">{promo.eligible_plans.join(", ")}</td><td className="px-4 py-3 text-xs"><div>{promo.starts_at ? new Date(promo.starts_at).toLocaleString() : "Immediately"}</div><div>{promo.expires_at ? new Date(promo.expires_at).toLocaleString() : "No expiry"}</div></td><td className="px-4 py-3">{promo.usage_count}{promo.total_usage_limit ? ` / ${promo.total_usage_limit}` : ""}<div className="text-xs text-slate-400">{promo.per_user_limit} per user</div></td><td className="px-4 py-3 capitalize"><span className={promo.status === "active" ? "text-emerald-300" : promo.status === "archived" ? "text-slate-500" : "text-amber-300"}>{promo.status}</span></td><td className="px-4 py-3"><div className="flex flex-wrap gap-2"><button className="chip-dark" onClick={() => void copyCode(promo)} title="Copy code" type="button">{copiedId === promo.id ? <Check size={14} /> : <Copy size={14} />}</button><button className="chip-dark" disabled={promo.is_archived} onClick={() => openEdit(promo)} title="Edit promo" type="button"><Edit3 size={14} /></button><button className="chip-dark" disabled={busy === promo.id || promo.is_archived} onClick={() => void toggleActive(promo)} type="button">{promo.is_active ? "Deactivate" : "Activate"}</button><button className="chip-dark" disabled={busy === promo.id || promo.is_archived} onClick={() => void archive(promo)} type="button"><Archive size={14} /> Archive</button></div></td></tr>)}
            {!loading && items.length === 0 && <tr><td className="px-4 py-8 text-center text-slate-400" colSpan={7}>No promo codes found.</td></tr>}
            {loading && <tr><td className="px-4 py-8 text-center text-slate-400" colSpan={7}>Loading promo codes...</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 p-4 text-xs text-slate-400"><span>{total} promo codes</span><div className="flex items-center gap-2"><button className="chip-dark" disabled={loading || page <= 1} onClick={() => void load({ page: page - 1 })} type="button">Previous</button><span>Page {page} of {totalPages}</span><button className="chip-dark" disabled={loading || page >= totalPages} onClick={() => void load({ page: page + 1 })} type="button">Next</button></div></div>
    </section>
  );
}
