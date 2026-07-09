import { AnimatePresence, motion } from "framer-motion";
import {
  Brain,
  FileText,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
  Search,
  ChevronDown,
  ChevronUp,
  Shield,
  ThumbsUp,
  Activity,
  Flame,
  Zap,
  Frown,
  Lightbulb,
  Heart,
  Briefcase,
  User,
  BookOpen
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { DocumentItem, HumanState, UserMemory } from "../../types";

function formatBytes(bytes: number) {
  if (!bytes) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function memoryKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "memory";
}

interface SignalBarProps {
  label: string;
  value: number;
  colorClass: string;
  icon: React.ReactNode;
}

function SignalBar({ label, value, colorClass, icon }: SignalBarProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] font-medium text-slate-300">
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        <span className="font-semibold text-slate-100">{value}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-900 border border-white/5 overflow-hidden">
        <motion.div
          className={clsx("h-full rounded-full transition-all duration-500", colorClass)}
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      </div>
    </div>
  );
}

export function ContextPanel({
  documents,
  selectedIds,
  setSelectedIds,
  onDeleteDocument,
  loadingDocuments,
  onRefreshDocuments,
  isOpen = false,
  onClose
}: {
  documents: DocumentItem[];
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  onDeleteDocument: (id: string) => Promise<void>;
  loadingDocuments: boolean;
  onRefreshDocuments: () => Promise<void>;
  isOpen?: boolean;
  onClose?: () => void;
}) {
  const { token } = useAuth();
  const [tab, setTab] = useState<"documents" | "memory">("documents");
  const [humanState, setHumanState] = useState<HumanState | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [category, setCategory] = useState("preference");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [panelError, setPanelError] = useState("");

  // Search & filter states for memory
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [showAllSignals, setShowAllSignals] = useState(false);

  const selectedDocuments = useMemo(
    () => documents.filter((document) => selectedIds.includes(document.id)),
    [documents, selectedIds]
  );

  async function refreshMemory() {
    if (!token) return;
    setMemoryLoading(true);
    try {
      setHumanState(await api.humanState(token));
    } finally {
      setMemoryLoading(false);
    }
  }

  useEffect(() => {
    refreshMemory();
  }, [token]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail?.tab === "memory" || detail?.tab === "documents") {
        setTab(detail.tab);
      }
    };
    window.addEventListener("open-context-panel", handleOpen);
    return () => window.removeEventListener("open-context-panel", handleOpen);
  }, []);

  async function createMemory(event: FormEvent) {
    event.preventDefault();
    if (!token || !memoryDraft.trim()) return;
    setPanelError("");
    try {
      const value = memoryDraft.trim();
      const created = await api.createMemory(token, {
        category: category.trim() || "preference",
        key: memoryKey(value),
        value,
        confidence: 0.92,
        source: "user"
      });
      setHumanState((current) =>
        current ? { ...current, memories: [created, ...current.memories] } : current
      );
      setMemoryDraft("");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to save memory";
      setPanelError(detail);
    }
  }

  async function deleteMemory(memory: UserMemory) {
    if (!token) return;
    setPanelError("");
    try {
      await api.deleteMemory(token, memory.id);
      setHumanState((current) =>
        current ? { ...current, memories: current.memories.filter((item) => item.id !== memory.id) } : current
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to delete memory";
      setPanelError(detail);
    }
  }

  // Filter memories list
  const filteredMemories = useMemo(() => {
    if (!humanState?.memories) return [];
    return humanState.memories.filter((memory) => {
      const matchesFilter = activeFilter === "all" || memory.category.toLowerCase() === activeFilter.toLowerCase();
      const matchesSearch =
        memory.value.toLowerCase().includes(searchQuery.toLowerCase()) ||
        memory.category.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesFilter && matchesSearch;
    });
  }, [humanState?.memories, activeFilter, searchQuery]);

  // Memory stats
  const memoryStats = useMemo(() => {
    const memories = humanState?.memories ?? [];
    return {
      total: memories.length,
      preference: memories.filter((m) => m.category.toLowerCase() === "preference").length,
      project: memories.filter((m) => m.category.toLowerCase() === "project").length,
      identity: memories.filter((m) => m.category.toLowerCase() === "identity").length,
      learning: memories.filter((m) => m.category.toLowerCase() === "learning_goal" || m.category.toLowerCase() === "learning").length
    };
  }, [humanState?.memories]);

  // Helper to render category icon
  const getCategoryIcon = (cat: string) => {
    const name = cat.toLowerCase();
    if (name === "preference") return <Heart size={14} className="text-rose-400" />;
    if (name === "project") return <Briefcase size={14} className="text-cyan-400" />;
    if (name === "identity") return <User size={14} className="text-violet-400" />;
    return <BookOpen size={14} className="text-amber-400" />;
  };

  return (
    <>
      {/* Drawer Overlay for Mobile & Tablet */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm xl:hidden"
          onClick={onClose}
        />
      )}

      {/* Main Panel Container */}
      <aside
        className={clsx(
          "context-panel compact-panel shrink-0 border-white/10 bg-slate-950/60 backdrop-blur-2xl transition-all duration-300 flex flex-col overflow-hidden",
          // Desktop positioning
          "xl:static xl:block xl:w-[21.5rem] xl:h-full xl:border-l xl:p-3 xl:translate-x-0 xl:z-0",
          // Mobile drawer positioning
          "fixed top-0 right-0 h-full w-[21.5rem] max-w-[90vw] border-l p-3 z-50 transform",
          isOpen ? "translate-x-0" : "translate-x-full xl:translate-x-0",
          !isOpen && "hidden xl:flex"
        )}
      >
        <div className="context-panel-card glass-panel compact-card flex h-full flex-col overflow-hidden">
          {/* Header */}
          <div className="border-b border-white/10 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-[10px] tracking-wider uppercase font-semibold text-cyan-400/80">Context</p>
                <h2 className="text-sm font-bold text-white flex items-center gap-1.5">
                  <Brain size={15} className="text-cyan-300 animate-pulse" />
                  Knowledge & Memory
                </h2>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  className="icon-button-dark"
                  onClick={tab === "documents" ? onRefreshDocuments : refreshMemory}
                  title="Refresh context"
                  type="button"
                >
                  <RefreshCw size={14} className={loadingDocuments || memoryLoading ? "animate-spin text-cyan-300" : ""} />
                </button>
                {onClose && (
                  <button
                    className="icon-button-dark xl:hidden"
                    onClick={onClose}
                    title="Close sidebar"
                    type="button"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            </div>

            {/* Segmented Tab Controls */}
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
              <button
                className={clsx("segmented-button py-1.5 text-xs font-semibold", tab === "documents" && "segmented-button-active bg-cyan-300/10 text-cyan-200 border-cyan-300/20")}
                onClick={() => setTab("documents")}
                type="button"
              >
                <FileText size={13} />
                Docs
              </button>
              <button
                className={clsx("segmented-button py-1.5 text-xs font-semibold", tab === "memory" && "segmented-button-active bg-fuchsia-300/10 text-fuchsia-200 border-fuchsia-300/20")}
                onClick={() => setTab("memory")}
                type="button"
              >
                <Brain size={13} />
                Memory
              </button>
            </div>
            {panelError && (
              <div className="mt-3 rounded-md border border-red-300/25 bg-red-500/10 px-3 py-2 text-xs text-red-100">
                {panelError}
              </div>
            )}
          </div>

          {/* Body Content */}
          <div className="context-panel-body min-h-0 flex-1 overflow-y-auto p-3 custom-scrollbar">
            <AnimatePresence mode="wait">
              {tab === "documents" ? (
                <motion.div
                  key="documents"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="space-y-2.5"
                >
                  {selectedDocuments.length > 0 && (
                    <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3 text-xs text-cyan-200 font-medium">
                      🚀 {selectedDocuments.length} document{selectedDocuments.length > 1 ? "s" : ""} active in chat context.
                    </div>
                  )}
                  {documents.map((document) => {
                    const pageCount = Number(document.document_metadata?.page_count || 0);
                    const wordCount = Number(document.document_metadata?.word_count || 0);
                    return (
                      <div
                        key={document.id}
                        className="group rounded-lg border border-white/10 bg-white/[0.03] p-3 transition hover:border-cyan-400/30 hover:bg-white/[0.06]"
                      >
                        <div className="flex items-start gap-2.5">
                          <input
                            className="mt-1.5 h-3.5 w-3.5 rounded border-white/10 bg-slate-950 text-cyan-400 focus:ring-cyan-400/20"
                            type="checkbox"
                            checked={selectedIds.includes(document.id)}
                            onChange={(event) => {
                              setSelectedIds(
                                event.target.checked
                                  ? [...selectedIds, document.id]
                                  : selectedIds.filter((id) => id !== document.id)
                              );
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-xs font-semibold text-white">
                              <FileText size={13} className="text-cyan-300 shrink-0" />
                              <span className="truncate">{document.filename}</span>
                            </span>
                            <span className="mt-0.5 block text-[10px] text-slate-400 font-medium">
                              {formatBytes(document.file_size)}
                              {pageCount ? ` • ${pageCount} pgs` : ""}
                              {wordCount ? ` • ${wordCount.toLocaleString()} words` : ""}
                            </span>
                            {document.summary && (
                              <span className="mt-2 line-clamp-3 block text-[11px] leading-relaxed text-slate-300/80 bg-slate-950/30 p-1.5 rounded border border-white/5">
                                {document.summary}
                              </span>
                            )}
                          </span>
                          <button
                            className="icon-button-dark h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                            onClick={async () => {
                              await onDeleteDocument(document.id);
                            }}
                            title="Delete document"
                            type="button"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {!documents.length && (
                    <div className="rounded-lg border border-dashed border-white/10 p-5 text-center text-xs text-slate-500 font-medium">
                      Uploaded files will show up here. Add them in the chat box!
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="memory"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="space-y-3.5"
                >
                  {/* Advanced Signals Dashboard */}
                  <div className="rounded-lg border border-fuchsia-300/20 bg-gradient-to-br from-fuchsia-950/20 to-slate-950/40 p-3 shadow-inner">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                        <Sparkles size={14} className="text-fuchsia-300" />
                        Adaptive Cognitive State
                      </div>
                      <button
                        className="text-[10px] font-bold text-fuchsia-300 hover:text-fuchsia-100 flex items-center gap-0.5"
                        onClick={() => setShowAllSignals(!showAllSignals)}
                        type="button"
                      >
                        {showAllSignals ? "Less" : "Advanced"}
                        {showAllSignals ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                      </button>
                    </div>

                    <div className="space-y-2">
                      <SignalBar
                        label="Trust Signal"
                        value={humanState?.profile.trust_score ?? 50}
                        colorClass="bg-gradient-to-r from-emerald-500 to-teal-400"
                        icon={<Shield size={11} className="text-emerald-300" />}
                      />
                      <SignalBar
                        label="Rapport / Flow"
                        value={humanState?.profile.rapport_score ?? 40}
                        colorClass="bg-gradient-to-r from-cyan-500 to-blue-400"
                        icon={<Activity size={11} className="text-cyan-300" />}
                      />
                      <SignalBar
                        label="Humor Tolerance"
                        value={humanState?.profile.humor_score ?? 30}
                        colorClass="bg-gradient-to-r from-amber-500 to-yellow-400"
                        icon={<Flame size={11} className="text-amber-300" />}
                      />

                      {showAllSignals && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          className="space-y-2 pt-2 border-t border-white/5"
                        >
                          <SignalBar
                            label="Cognitive Respect"
                            value={humanState?.profile.respect_score ?? 70}
                            colorClass="bg-gradient-to-r from-indigo-500 to-purple-400"
                            icon={<ThumbsUp size={11} className="text-indigo-300" />}
                          />
                          <SignalBar
                            label="Knowledge Curiosity"
                            value={humanState?.profile.curiosity_score ?? 50}
                            colorClass="bg-gradient-to-r from-fuchsia-500 to-pink-400"
                            icon={<Lightbulb size={11} className="text-fuchsia-300" />}
                          />
                          <SignalBar
                            label="Task Confidence"
                            value={humanState?.profile.confidence_score ?? 60}
                            colorClass="bg-gradient-to-r from-violet-500 to-purple-400"
                            icon={<Zap size={11} className="text-violet-300" />}
                          />
                          <SignalBar
                            label="User Frustration"
                            value={humanState?.profile.frustration_score ?? 10}
                            colorClass="bg-gradient-to-r from-rose-500 to-orange-400"
                            icon={<Frown size={11} className="text-rose-300" />}
                          />
                        </motion.div>
                      )}
                    </div>
                  </div>

                  {/* Add memory form */}
                  <form className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2.5" onSubmit={createMemory}>
                    <div className="flex gap-2">
                      <select
                        className="model-select-dark w-full text-xs"
                        value={category}
                        onChange={(event) => setCategory(event.target.value)}
                        aria-label="Memory category"
                      >
                        <option value="preference">Preference</option>
                        <option value="project">Project Detail</option>
                        <option value="identity">User Identity</option>
                        <option value="learning_goal">Learning Objective</option>
                      </select>
                    </div>
                    <textarea
                      className="min-h-16 w-full resize-none rounded-md border border-white/15 bg-slate-950/60 p-2 text-xs text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                      value={memoryDraft}
                      onChange={(event) => setMemoryDraft(event.target.value)}
                      placeholder="Save user preferences, custom configurations or project goals..."
                      rows={2}
                    />
                    <button className="btn-primary py-1.5 text-xs font-semibold w-full" disabled={!memoryDraft.trim()}>
                      Save Memory Block
                    </button>
                  </form>

                  {/* Search and Filters */}
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search memory graph..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-slate-900 border border-white/10 rounded-md py-1.5 pl-8 pr-3 text-xs text-white outline-none focus:border-cyan-300/40 transition placeholder:text-slate-500"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="absolute right-2.5 top-2.5 text-slate-400 hover:text-white"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>

                    {/* Filter Pills */}
                    <div className="flex flex-wrap gap-1 pb-1">
                      <button
                        type="button"
                        onClick={() => setActiveFilter("all")}
                        className={clsx(
                          "px-2 py-1 rounded text-[10px] font-semibold border transition",
                          activeFilter === "all"
                            ? "bg-cyan-300/10 border-cyan-300/30 text-cyan-200"
                            : "bg-transparent border-white/5 text-slate-400 hover:border-white/10 hover:text-white"
                        )}
                      >
                        All ({memoryStats.total})
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveFilter("preference")}
                        className={clsx(
                          "px-2 py-1 rounded text-[10px] font-semibold border transition",
                          activeFilter === "preference"
                            ? "bg-rose-500/10 border-rose-500/30 text-rose-300"
                            : "bg-transparent border-white/5 text-slate-400 hover:border-white/10 hover:text-white"
                        )}
                      >
                        Prefs ({memoryStats.preference})
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveFilter("project")}
                        className={clsx(
                          "px-2 py-1 rounded text-[10px] font-semibold border transition",
                          activeFilter === "project"
                            ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-300"
                            : "bg-transparent border-white/5 text-slate-400 hover:border-white/10 hover:text-white"
                        )}
                      >
                        Projects ({memoryStats.project})
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveFilter("identity")}
                        className={clsx(
                          "px-2 py-1 rounded text-[10px] font-semibold border transition",
                          activeFilter === "identity"
                            ? "bg-violet-500/10 border-violet-500/30 text-violet-300"
                            : "bg-transparent border-white/5 text-slate-400 hover:border-white/10 hover:text-white"
                        )}
                      >
                        Identity ({memoryStats.identity})
                      </button>
                    </div>
                  </div>

                  {/* Memories List */}
                  <div className="space-y-2">
                    {filteredMemories.map((memory) => (
                      <div
                        key={memory.id}
                        className="group rounded-lg border border-white/10 bg-white/[0.02] p-3 transition hover:border-fuchsia-400/20"
                      >
                        <div className="mb-1.5 flex items-start justify-between gap-2">
                          <div className="min-w-0 flex items-center gap-1.5">
                            {getCategoryIcon(memory.category)}
                            <p className="text-[10px] uppercase font-bold tracking-wide text-slate-400">
                              {memory.category}
                            </p>
                          </div>
                          <button
                            className="icon-button-dark h-6 w-6 opacity-0 group-hover:opacity-100 hover:text-red-400 transition"
                            onClick={() => deleteMemory(memory)}
                            title="Delete memory block"
                            type="button"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <p className="text-xs leading-relaxed text-slate-200 bg-slate-950/25 p-2 rounded border border-white/5">
                          {memory.value}
                        </p>
                        <div className="mt-1.5 flex items-center justify-between text-[9px] text-slate-500 font-medium">
                          <span>{Math.round(memory.confidence * 100)}% reliability</span>
                          <span>Source: {memory.source}</span>
                        </div>
                      </div>
                    ))}
                    {!filteredMemories.length && (
                      <div className="rounded-lg border border-dashed border-white/10 p-5 text-center text-xs text-slate-500 font-medium">
                        {searchQuery ? "No matches found for search query." : "No saved memory nodes available."}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </aside>
    </>
  );
}
