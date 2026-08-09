import { AlertTriangle, Bell, CheckCircle2, ClipboardCheck, Download, FileCheck2, FileText, Gauge, LoaderCircle, RefreshCw, Search, Send, ShieldCheck, Upload, UserCheck, UserPlus, UsersRound } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { sevaApi, type SevaAgent, type SevaWorkOrder } from "./sevaApi";
import { sevaScopeApi, type SevaApprovedScope } from "./sevaScopeApi";
import "./autoaiSeva.css";
import "./sevaAdvanced.css";
import "./autoaiSevaScrollFix.css";
import "./rtpsForm.css";

const STATUS_OPTIONS: Array<SevaWorkOrder["status"]> = [
  "IN_PROGRESS", "WAITING_USER", "DOCUMENT_VERIFICATION", "PROTECTED_ACTION_REQUIRED",
  "READY_TO_SUBMIT", "SUBMITTED_TO_AUTHORITY", "UNDER_AUTHORITY_PROCESSING", "APPROVED",
  "REJECTED", "ISSUED", "DELIVERED",
];

const STATUS_FILTER_OPTIONS = [
  "QUEUED", ...STATUS_OPTIONS, "QUALITY_REVIEW", "ESCALATED", "COMPLETED", "CANCELLED",
] as const;

function readable(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

function printableValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SevaOperationsPage() {
  const { token, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<SevaWorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState(searchParams.get("case") || "");
  const [selected, setSelected] = useState<SevaWorkOrder | null>(null);
  const [scope, setScope] = useState<SevaApprovedScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"TEXT" | "DOCUMENT" | "PROTECTED_ACTION">("TEXT");
  const [label, setLabel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [progressPercent, setProgressPercent] = useState(30);
  const [referenceNumber, setReferenceNumber] = useState("");
  const [deliverableLabel, setDeliverableLabel] = useState("Application receipt PDF");
  const [deliverableNote, setDeliverableNote] = useState("");
  const [deliverableFile, setDeliverableFile] = useState<File | null>(null);
  const [agents, setAgents] = useState<SevaAgent[]>([]);
  const [agentSummary, setAgentSummary] = useState({ active: 0, inactive: 0, suspended: 0, at_capacity: 0 });
  const [agentEdits, setAgentEdits] = useState<Record<string, { capacity: number; password: string; specializations: string }>>({});
  const [agentForm, setAgentForm] = useState({ agent_id: "", display_name: "", password: "", capacity: 5, work_email: "", contact_phone: "", specializations: "", languages: "" });
  const [dashboard, setDashboard] = useState<{ counts: Record<string, number>; active_workload: number; completed_today: number; attention_required: number; agent: SevaAgent } | null>(null);
  const [notifications, setNotifications] = useState<Awaited<ReturnType<typeof sevaApi.listNotifications>> | null>(null);
  const [stateFilter, setStateFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [slaFilter, setSlaFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [queueMeta, setQueueMeta] = useState({ total: 0, has_more: false });
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof sevaApi.getOperationsOverview>> | null>(null);
  const [qualityReason, setQualityReason] = useState("");
  const [escalationReason, setEscalationReason] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const result = await sevaApi.listWorkOrders(token, { state: stateFilter || undefined, q: appliedSearch || undefined, agentId: agentFilter || undefined, priority: priorityFilter || undefined, sla: slaFilter || undefined, department: departmentFilter || undefined, page, pageSize: 25 });
      setItems(result.items);
      setQueueMeta({ total: result.total, has_more: result.has_more });
      if (user?.is_admin) { const [team, operations] = await Promise.all([sevaApi.listAgents(token), sevaApi.getOperationsOverview(token)]); setAgents(team.items); setAgentSummary(team.summary); setOverview(operations); setAgentEdits((current) => Object.fromEntries(team.items.map((agent) => [agent.id, current[agent.id] || { capacity: agent.capacity, password: "", specializations: agent.specializations.join(", ") }]))); }
      if (user?.role === "seva_agent") setDashboard(await sevaApi.getAgentDashboard(token));
      setNotifications(await sevaApi.listNotifications(token));
      setSelectedId((current) => current || result.items[0]?.id || "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Seva work orders could not be loaded.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [agentFilter, appliedSearch, departmentFilter, page, priorityFilter, slaFilter, stateFilter, token, user?.is_admin, user?.role]);

  const loadSelected = useCallback(async () => {
    if (!token || !selectedId) {
      setSelected(null);
      setScope(null);
      return;
    }
    try {
      const next = await sevaApi.getWorkOrder(token, selectedId);
      setSelected(next);
      setProgressPercent(next.work_progress);
      setReferenceNumber(next.reference_number || "");
      if (next.assigned_employee?.id === user?.id && next.status !== "CANCELLED") {
        setScope(await sevaScopeApi.get(token, next.id));
      } else {
        setScope(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Work order could not be opened.");
    }
  }, [selectedId, token, user?.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSelected(); }, [loadSelected]);
  useEffect(() => {
    if (selectedId) setSearchParams((current) => { current.set("case", selectedId); return current; }, { replace: true });
  }, [selectedId, setSearchParams]);
  useEffect(() => {
    const timer = window.setInterval(() => { void load(true); void loadSelected(); }, 12_000);
    return () => window.clearInterval(timer);
  }, [load, loadSelected]);

  const pendingRequirements = useMemo(
    () => selected?.requirements.filter((item) => item.status === "FULFILLED").length ?? 0,
    [selected],
  );

  async function run(key: string, action: () => Promise<SevaWorkOrder>) {
    if (working) return;
    setWorking(key);
    setError("");
    try {
      const next = await action();
      setSelected(next);
      setItems((current) => current.map((item) => item.id === next.id ? next : item));
      if (token && next.assigned_employee?.id === user?.id && next.status !== "CANCELLED") {
        setScope(await sevaScopeApi.get(token, next.id));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation failed.");
    } finally {
      setWorking("");
    }
  }

  async function createRequirement(event: FormEvent) {
    event.preventDefault();
    if (!token || !selected || !label.trim()) return;
    await run("requirement", () => sevaApi.createRequirement(token, selected.id, {
      kind,
      label: label.trim(),
      instructions: instructions.trim(),
      required: true,
    }));
    setLabel("");
    setInstructions("");
  }

  async function uploadDeliverable(event: FormEvent) {
    event.preventDefault();
    if (!token || !selected || !deliverableFile) return;
    await run("deliverable", () => sevaApi.uploadDeliverable(token, selected.id, deliverableFile, deliverableLabel, deliverableNote, true));
    setDeliverableFile(null);
    setDeliverableNote("");
  }

  async function createAgent(event: FormEvent) {
    event.preventDefault();
    if (!token || working) return;
    setWorking("create-agent"); setError("");
    try {
      const created = await sevaApi.createAgent(token, { ...agentForm, specializations: agentForm.specializations.split(",").map((item) => item.trim()).filter(Boolean), languages: agentForm.languages.split(",").map((item) => item.trim()).filter(Boolean) });
      setAgents((current) => [created, ...current]);
      setAgentForm({ agent_id: "", display_name: "", password: "", capacity: 5, work_email: "", contact_phone: "", specializations: "", languages: "" });
      await load(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Agent could not be created."); }
    finally { setWorking(""); }
  }

  async function manageAgent(agent: SevaAgent, status?: SevaAgent["status"]) {
    if (!token || working) return;
    const edit = agentEdits[agent.id] || { capacity: agent.capacity, password: "", specializations: agent.specializations.join(", ") };
    setWorking(`agent-manage-${agent.id}`); setError("");
    try {
      const updated = await sevaApi.updateAgent(token, agent.id, {
        status, capacity: edit.capacity,
        specializations: edit.specializations.split(",").map((item) => item.trim()).filter(Boolean),
        password: edit.password || undefined,
      });
      setAgents((current) => current.map((item) => item.id === updated.id ? updated : item));
      setAgentEdits((current) => ({ ...current, [agent.id]: { ...edit, password: "" } }));
      await load(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Agent could not be updated."); }
    finally { setWorking(""); }
  }

  async function reassign(agentProfileId: string) {
    if (!token || !selected || working) return;
    await run("reassign", () => sevaApi.reassignWorkOrder(token, selected.id, agentProfileId || null, "Administrator reassigned the case from Operations"));
    await load(true);
  }

  async function openNotification(notification: NonNullable<typeof notifications>["items"][number]) {
    if (!token) return;
    setSelectedId(notification.work_order_id);
    if (!notification.read_at) await sevaApi.markNotificationRead(token, notification.id);
    setNotifications((current) => current ? { ...current, unread: Math.max(0, current.unread - (notification.read_at ? 0 : 1)), items: current.items.map((item) => item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item) } : current);
  }

  async function downloadApprovedDocument(assetId: string, filename: string) {
    if (!token || !selected || working) return;
    setWorking(`scope-${assetId}`);
    setError("");
    try {
      const blob = await sevaScopeApi.downloadDocument(token, selected.id, assetId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approved document could not be downloaded.");
    } finally {
      setWorking("");
    }
  }

  async function downloadRequirementDocument(requirementId: string, filename: string) {
    if (!token || !selected || working) return;
    setWorking(`requirement-file-${requirementId}`); setError("");
    try {
      const blob = await sevaApi.downloadRequirementDocument(token, selected.id, requirementId);
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Requirement document could not be downloaded."); }
    finally { setWorking(""); }
  }

  return (
    <div className={`seva-page ${user?.role === "seva_agent" ? "seva-agent-portal" : "seva-admin-portal"}`}>
      <header className="seva-topbar">
        <div><span className="seva-mark"><UsersRound size={21} /></span><span><strong>AutoAI Seva Operations</strong><small>Agent application queue</small></span></div>
        <button type="button" className="seva-history-button" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={17} /> Refresh</button>
      </header>
      <main className="seva-employee-page">
        <section className="seva-list-heading"><div><span>Operations workspace</span><h1>Claim requests, ask requirements and deliver final PDFs.</h1></div></section>
        {error ? <p className="seva-error" role="alert">{error}</p> : null}
        {notifications?.items.length ? <section className="seva-notification-strip" aria-label="Case notifications"><header><Bell size={17} /><strong>Notifications</strong><span>{notifications.unread} unread</span></header><div>{notifications.items.slice(0, 4).map((notification) => <button type="button" key={notification.id} className={notification.read_at ? "" : "unread"} onClick={() => void openNotification(notification)}><strong>{notification.title}</strong><span>{notification.message}</span></button>)}</div></section> : null}
        {dashboard ? <section className="seva-agent-overview"><header><div><span>My work</span><h2>{dashboard.agent.display_name}</h2></div><strong>{dashboard.active_workload}/{dashboard.agent.capacity} active</strong></header><div><article><small>In progress</small><b>{dashboard.counts.IN_PROGRESS || 0}</b></article><article><small>Waiting for user</small><b>{dashboard.counts.WAITING_USER || 0}</b></article><article><small>Submitted</small><b>{dashboard.counts.SUBMITTED || 0}</b></article><article><small>Completed today</small><b>{dashboard.completed_today}</b></article><article><small>Attention required</small><b>{dashboard.attention_required}</b></article></div></section> : null}
        {overview ? <section className="seva-agent-overview seva-ops-overview" aria-label="Operations overview"><header><div><span>Control centre</span><h2>Live service operations</h2></div><strong>{overview.total} total cases</strong></header><div><article><small>Active</small><b>{Object.entries(overview.counts).filter(([state]) => !["COMPLETED", "CANCELLED", "DELIVERED", "REJECTED"].includes(state)).reduce((sum, [, count]) => sum + count, 0)}</b></article><article><small>Overdue SLA</small><b>{overview.overdue}</b></article><article><small>Quality review</small><b>{overview.pending_quality_review}</b></article><article><small>Protected actions</small><b>{overview.protected_actions}</b></article><article><small>Agents available</small><b>{overview.agents_available}</b></article><article><small>At capacity</small><b>{overview.agents_at_capacity}</b></article></div></section> : null}
        {user?.is_admin ? <section className="seva-agent-admin">
          <header><div><span>Agent access</span><h2>Team capacity and automatic assignment</h2></div><strong>{agents.reduce((sum, agent) => sum + agent.available_slots, 0)} slots available</strong></header>
          <div className="seva-agent-summary"><span>Total <b>{agents.length}</b></span><span>Active <b>{agentSummary.active}</b></span><span>Inactive <b>{agentSummary.inactive}</b></span><span>Suspended <b>{agentSummary.suspended}</b></span><span>At capacity <b>{agentSummary.at_capacity}</b></span></div>
          <form className="seva-agent-create-form" onSubmit={createAgent}>
            <label><span>Agent ID *</span><input value={agentForm.agent_id} onChange={(event) => setAgentForm({ ...agentForm, agent_id: event.target.value })} placeholder="e.g. agent-101" pattern="[A-Za-z0-9._-]+" minLength={3} required /></label>
            <label><span>Agent name *</span><input value={agentForm.display_name} onChange={(event) => setAgentForm({ ...agentForm, display_name: event.target.value })} placeholder="Full name" minLength={2} required /></label>
            <label><span>Temporary password *</span><input type="password" value={agentForm.password} onChange={(event) => setAgentForm({ ...agentForm, password: event.target.value })} placeholder="Minimum 8 characters" minLength={8} autoComplete="new-password" required /></label>
            <label><span>Case capacity *</span><input type="number" value={agentForm.capacity} onChange={(event) => setAgentForm({ ...agentForm, capacity: Number(event.target.value) })} min={1} max={50} required /></label>
            <label><span>Work email</span><input type="email" value={agentForm.work_email} onChange={(event) => setAgentForm({ ...agentForm, work_email: event.target.value })} placeholder="Optional" /></label>
            <label><span>Contact phone</span><input value={agentForm.contact_phone} onChange={(event) => setAgentForm({ ...agentForm, contact_phone: event.target.value })} placeholder="Optional" /></label>
            <label><span>Service categories</span><input value={agentForm.specializations} onChange={(event) => setAgentForm({ ...agentForm, specializations: event.target.value })} placeholder="Income, caste, admission" /></label>
            <label><span>Languages</span><input value={agentForm.languages} onChange={(event) => setAgentForm({ ...agentForm, languages: event.target.value })} placeholder="Hindi, English" /></label>
            <button className="seva-primary" disabled={working === "create-agent"}>{working === "create-agent" ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />} Create agent</button>
          </form>
          <div className="seva-agent-list">{agents.map((agent) => { const edit = agentEdits[agent.id] || { capacity: agent.capacity, password: "", specializations: agent.specializations.join(", ") }; return <article key={agent.id}><span><strong>{agent.display_name}</strong><small>{agent.agent_id} · {agent.active_load}/{agent.capacity} active · {agent.status.toLowerCase()}</small></span><b>{agent.is_active ? `${agent.available_slots} open` : "Disabled"}</b><div className="seva-agent-editor"><input type="number" min={1} max={50} value={edit.capacity} aria-label={`${agent.display_name} capacity`} onChange={(event) => setAgentEdits((current) => ({ ...current, [agent.id]: { ...edit, capacity: Number(event.target.value) } }))} /><input value={edit.specializations} placeholder="Specializations" aria-label={`${agent.display_name} specializations`} onChange={(event) => setAgentEdits((current) => ({ ...current, [agent.id]: { ...edit, specializations: event.target.value } }))} /><input type="password" minLength={8} value={edit.password} placeholder="New temporary password" aria-label={`${agent.display_name} password reset`} onChange={(event) => setAgentEdits((current) => ({ ...current, [agent.id]: { ...edit, password: event.target.value } }))} /><select value={agent.status} aria-label={`${agent.display_name} status`} onChange={(event) => void manageAgent(agent, event.target.value as SevaAgent["status"])}><option>ACTIVE</option><option>INACTIVE</option><option>SUSPENDED</option></select><button type="button" onClick={() => void manageAgent(agent)} disabled={Boolean(working)}>Save / reset</button></div></article>; })}</div>
        </section> : null}
        <form className="seva-queue-filters" onSubmit={(event) => { event.preventDefault(); setPage(1); setAppliedSearch(searchText.trim()); }}>
          <label><Search size={16} /><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Case ID, user or request" /></label>
          <select value={stateFilter} onChange={(event) => { setPage(1); setStateFilter(event.target.value); }} aria-label="Filter by status"><option value="">All statuses</option>{STATUS_FILTER_OPTIONS.map((status) => <option key={status} value={status}>{readable(status)}</option>)}</select>
          <select value={priorityFilter} onChange={(event) => { setPage(1); setPriorityFilter(event.target.value); }} aria-label="Filter by priority"><option value="">All priorities</option><option>LOW</option><option>NORMAL</option><option>HIGH</option><option>URGENT</option></select>
          <select value={slaFilter} onChange={(event) => { setPage(1); setSlaFilter(event.target.value); }} aria-label="Filter by SLA"><option value="">All SLA states</option><option>ON_TRACK</option><option>OVERDUE</option><option>ESCALATED</option></select>
          <input value={departmentFilter} onChange={(event) => { setPage(1); setDepartmentFilter(event.target.value); }} aria-label="Filter by department" placeholder="Department" />
          {user?.is_admin ? <select value={agentFilter} onChange={(event) => { setPage(1); setAgentFilter(event.target.value); }} aria-label="Filter by agent"><option value="">All agents</option>{agents.map((agent) => <option key={agent.user_id} value={agent.user_id}>{agent.display_name}</option>)}</select> : null}
          <button type="submit">Search</button><span>{queueMeta.total} cases</span>
        </form>
        <div className="seva-employee-layout">
          <aside className="seva-work-order-list">
            {loading ? <div className="seva-assistance-loading"><LoaderCircle className="spin" /> Loading queue…</div> : null}
            {!loading && !items.length ? <div className="seva-empty"><FileCheck2 /><p>No agent tasks are waiting.</p></div> : null}
            {items.map((item) => (
              <button key={item.id} type="button" className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                <strong>{item.service?.name || "AutoAI Seva request"}</strong>
                <small>{item.case_id} · {readable(item.status)}</small><small>{item.owner?.name || "User"}</small>
                {item.queue_position ? <small>Queue position {item.queue_position}</small> : null}
                <span>{item.request_summary}</span>
              </button>
            ))}
            <footer className="seva-pagination"><button type="button" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {page}</span><button type="button" disabled={!queueMeta.has_more} onClick={() => setPage((value) => value + 1)}>Next</button></footer>
          </aside>

          <section className="seva-work-order-detail">
            {!selected ? <div className="seva-empty"><UsersRound /><p>Select a work order.</p></div> : (
              <>
                <header className="seva-workspace-summary">
                  <div><span>{selected.owner?.name}{selected.owner?.email ? ` · ${selected.owner.email}` : ""}</span><h1>{selected.service?.name || "Assisted request"}</h1><p>{selected.current_activity} · work {selected.work_progress}%</p></div>
                  <div className="seva-workspace-progress"><span style={{ width: `${selected.work_progress}%` }} /></div>
                </header>
                <section className="seva-case-facts" aria-label="Case controls"><span><small>Case</small><strong>{selected.case_id}</strong></span><span><small>Department</small><strong>{selected.department || "Operations"}</strong></span><span><small>Queue</small><strong>{selected.queue_name || "General"}</strong></span><span className={`sla-${(selected.sla_status || "on_track").toLowerCase()}`}><small>SLA</small><strong>{readable(selected.sla_status || "ON_TRACK")}</strong></span><span><small>Quality</small><strong>{readable(selected.quality_status || (selected.quality_required ? "REQUIRED" : "NOT_REQUIRED"))}</strong></span><span><small>Official status</small><strong>{readable(selected.official_status || "NOT_SUBMITTED")}</strong></span></section>
                <p className="seva-employee-note"><ShieldCheck size={16} />Only user-approved fields and documents are available. Never request a raw OTP, CAPTCHA, password or payment secret.</p>
                <div className="seva-employee-toolbar">
                  {!selected.assigned_employee ? <button type="button" disabled={Boolean(working)} onClick={() => token && void run("claim", () => sevaApi.claimWorkOrder(token, selected.id))}><UserCheck size={16} /> Claim request</button> : <span>Assigned to <strong>{selected.assigned_employee.name}</strong></span>}
                  <label className="seva-status-control">Next status<select value="" aria-label="Update case status" disabled={Boolean(working)} onChange={(event) => { const next = event.target.value; if (next && token) void run(next, () => sevaApi.updateWorkOrderStatus(token, selected.id, next, statusNote, progressPercent, referenceNumber)); }}><option value="">Choose status</option>{STATUS_OPTIONS.map((item) => <option key={item} value={item}>{readable(item)}</option>)}</select></label>
                  {user?.is_admin ? <label className="seva-reassign-control">Reassign<select value={agents.find((agent) => agent.user_id === selected.assigned_employee?.id)?.id || ""} onChange={(event) => void reassign(event.target.value)} disabled={Boolean(working)}><option value="">Automatic assignment</option>{agents.filter((agent) => (agent.is_active && agent.available_slots > 0) || agent.user_id === selected.assigned_employee?.id).map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name} ({agent.available_slots} open)</option>)}</select></label> : null}
                </div>
                <textarea value={statusNote} onChange={(event) => setStatusNote(event.target.value)} placeholder="Status note visible to the user" rows={2} />
                <div className="seva-progress-controls"><label>Progress %<input type="number" min={selected.work_progress} max={99} value={progressPercent} onChange={(event) => setProgressPercent(Number(event.target.value))} /></label><label>Application/reference number<input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} maxLength={120} placeholder="Required when submitted" /></label></div>
                <section className="seva-governance-actions"><h3><Gauge size={17} /> Governance controls</h3><div>{!user?.is_admin && selected.quality_status !== "PENDING" && !["COMPLETED", "CANCELLED", "DELIVERED", "REJECTED"].includes(selected.status) ? <button type="button" disabled={Boolean(working)} onClick={() => token && void run("quality", () => sevaApi.requestQualityReview(token, selected.id))}><ClipboardCheck size={16} /> Request quality review</button> : null}{user?.is_admin && selected.quality_status === "PENDING" ? <><input value={qualityReason} onChange={(event) => setQualityReason(event.target.value)} placeholder="Review decision note" /><button type="button" disabled={Boolean(working)} onClick={() => token && void run("quality-approve", () => sevaApi.decideQualityReview(token, selected.id, true, qualityReason))}><CheckCircle2 size={16} /> Approve</button><button type="button" disabled={Boolean(working) || qualityReason.trim().length < 5} onClick={() => token && void run("quality-return", () => sevaApi.decideQualityReview(token, selected.id, false, qualityReason))}>Return for correction</button></> : null}<input value={escalationReason} onChange={(event) => setEscalationReason(event.target.value)} placeholder="Escalation reason" /><button type="button" disabled={Boolean(working) || escalationReason.trim().length < 5 || ["COMPLETED", "CANCELLED", "DELIVERED", "REJECTED"].includes(selected.status)} onClick={() => token && void run("escalate", () => sevaApi.escalateWorkOrder(token, selected.id, escalationReason))}><AlertTriangle size={16} /> Escalate</button></div>{selected.escalation_reason ? <p><AlertTriangle size={15} /> {selected.escalation_reason}</p> : null}</section>

                {scope ? (
                  <section className="seva-approved-scope">
                    <header><span><ShieldCheck size={18} /><strong>User-approved application data</strong></span><small>Authentication secrets shared: no</small></header>
                    <div className="seva-approved-fields">
                      {scope.fields.length ? scope.fields.map((field) => (
                        <article key={field.key}><small>{field.label}</small><strong>{printableValue(field.value)}</strong><span>{field.source}{field.verified ? " · verified" : ""}</span></article>
                      )) : <p>No completed field values were approved yet.</p>}
                    </div>
                    <div className="seva-approved-documents">
                      {scope.documents.map((document) => (
                        <article key={document.asset_id}><span><FileText size={17} /><span><strong>{document.filename}</strong><small>{document.content_type} · {document.validation_status.toLowerCase()}</small></span></span><button type="button" disabled={working === `scope-${document.asset_id}`} onClick={() => void downloadApprovedDocument(document.asset_id, document.filename)}>{working === `scope-${document.asset_id}` ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} Download</button></article>
                      ))}
                    </div>
                  </section>
                ) : selected.assigned_employee?.id === user?.id ? <div className="seva-assistance-loading"><LoaderCircle className="spin" /> Loading user-approved scope…</div> : null}

                <form className="seva-requirement-builder" onSubmit={createRequirement}>
                  <h3>Ask the user for a requirement</h3>
                  <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                    <option value="TEXT">Non-secret information</option>
                    <option value="DOCUMENT">Document upload</option>
                    <option value="PROTECTED_ACTION">Protected action (OTP/CAPTCHA/final submit)</option>
                  </select>
                  <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={kind === "PROTECTED_ACTION" ? "Complete OTP on the official portal" : "Requirement title"} maxLength={180} required />
                  <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Clear instructions for the user" rows={3} maxLength={1000} />
                  <button type="submit" className="seva-primary" disabled={working === "requirement" || selected.assigned_employee?.id !== user?.id}>{working === "requirement" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} Send requirement</button>
                </form>

                <div className="seva-requirements-list">
                  <h3>User requirements {pendingRequirements ? `· ${pendingRequirements} ready for review` : ""}</h3>
                  {selected.requirements.map((requirement) => (
                    <article key={requirement.id} className={`seva-employee-requirement status-${requirement.status.toLowerCase()}`}>
                      <header><span><FileText size={17} /><strong>{requirement.label}</strong></span><b>{readable(requirement.status)}</b></header>
                      <p>{requirement.instructions}</p>
                      {requirement.response_text ? <p><CheckCircle2 size={15} /> {requirement.response_text}</p> : null}
                      {requirement.response_document ? <p><FileText size={15} /> {requirement.response_document.filename} <button type="button" onClick={() => void downloadRequirementDocument(requirement.id, requirement.response_document!.filename)}><Download size={14} /> Download</button></p> : null}
                      {requirement.status === "FULFILLED" ? <div className="seva-employee-toolbar"><button type="button" onClick={() => token && void run(`accept-${requirement.id}`, () => sevaApi.reviewRequirement(token, selected.id, requirement.id, true))}>Accept</button><button type="button" onClick={() => token && void run(`reject-${requirement.id}`, () => sevaApi.reviewRequirement(token, selected.id, requirement.id, false, "Please provide a clearer or valid response."))}>Request again</button></div> : null}
                    </article>
                  ))}
                </div>

                <form className="seva-final-upload" onSubmit={uploadDeliverable}>
                  <h3>Attach final application or receipt</h3>
                  <input value={deliverableLabel} onChange={(event) => setDeliverableLabel(event.target.value)} maxLength={180} />
                  <textarea value={deliverableNote} onChange={(event) => setDeliverableNote(event.target.value)} placeholder="Application number, submission note or next step" rows={3} />
                  <label className="seva-employee-upload"><Upload size={17} />{deliverableFile?.name || "Select final PDF/image"}<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => setDeliverableFile(event.target.files?.[0] || null)} /></label>
                  <button type="submit" className="seva-primary" disabled={!deliverableFile || working === "deliverable" || selected.assigned_employee?.id !== user?.id}>{working === "deliverable" ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />} Upload and complete</button>
                </form>
                {selected.timeline.length ? <section className="seva-case-timeline"><h3>Case activity</h3>{selected.timeline.map((event) => <article key={event.id}><span /><div><strong>{event.title}</strong><small>{new Date(event.created_at).toLocaleString()}</small></div></article>)}</section> : null}
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
