import { AnimatePresence, motion } from "framer-motion";
import { Brain, FileText, RefreshCw, Sparkles, Trash2 } from "lucide-react";
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

export function ContextPanel({
  documents,
  selectedIds,
  setSelectedIds,
  onDeleteDocument,
  loadingDocuments,
  onRefreshDocuments
}: {
  documents: DocumentItem[];
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  onDeleteDocument: (id: string) => Promise<void>;
  loadingDocuments: boolean;
  onRefreshDocuments: () => Promise<void>;
}) {
  const { token } = useAuth();
  const [tab, setTab] = useState<"documents" | "memory">("documents");
  const [humanState, setHumanState] = useState<HumanState | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [category, setCategory] = useState("preference");
  const [memoryLoading, setMemoryLoading] = useState(false);

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

  async function createMemory(event: FormEvent) {
    event.preventDefault();
    if (!token || !memoryDraft.trim()) return;
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
      window.alert(detail);
    }
  }

  async function deleteMemory(memory: UserMemory) {
    if (!token) return;
    try {
      await api.deleteMemory(token, memory.id);
      setHumanState((current) =>
        current ? { ...current, memories: current.memories.filter((item) => item.id !== memory.id) } : current
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to delete memory";
      window.alert(detail);
    }
  }

  return (
    <aside className="hidden w-[21.5rem] shrink-0 border-l border-white/10 bg-slate-950/60 p-3 backdrop-blur-xl xl:block">
      <div className="glass-panel flex h-full flex-col overflow-hidden">
        <div className="border-b border-white/10 p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase text-cyan-200/70">Context</p>
              <h2 className="text-sm font-semibold text-white">Knowledge & memory</h2>
            </div>
            <button
              className="icon-button-dark"
              onClick={tab === "documents" ? onRefreshDocuments : refreshMemory}
              title="Refresh context"
              type="button"
            >
              <RefreshCw size={16} className={loadingDocuments || memoryLoading ? "animate-spin" : ""} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
            <button
              className={clsx("segmented-button", tab === "documents" && "segmented-button-active")}
              onClick={() => setTab("documents")}
              type="button"
            >
              <FileText size={14} />
              Docs
            </button>
            <button
              className={clsx("segmented-button", tab === "memory" && "segmented-button-active")}
              onClick={() => setTab("memory")}
              type="button"
            >
              <Brain size={14} />
              Memory
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <AnimatePresence mode="wait">
            {tab === "documents" ? (
              <motion.div
                key="documents"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="space-y-2"
              >
                {selectedDocuments.length > 0 && (
                  <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3 text-xs text-cyan-50">
                    {selectedDocuments.length} document{selectedDocuments.length > 1 ? "s" : ""} active in chat context.
                  </div>
                )}
                {documents.map((document) => {
                  const pageCount = Number(document.document_metadata?.page_count || 0);
                  const wordCount = Number(document.document_metadata?.word_count || 0);
                  return (
                    <div
                      key={document.id}
                      className="group rounded-lg border border-white/10 bg-white/[0.04] p-3 transition hover:border-cyan-200/30 hover:bg-white/[0.07]"
                    >
                      <div className="flex items-start gap-3">
                        <input
                          className="mt-1 accent-cyan-300"
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
                          <span className="flex items-center gap-2 text-sm font-medium text-white">
                            <FileText size={15} className="text-cyan-200" />
                            <span className="truncate">{document.filename}</span>
                          </span>
                          <span className="mt-1 block text-xs text-slate-400">
                            {formatBytes(document.file_size)}
                            {pageCount ? ` | ${pageCount} page${pageCount > 1 ? "s" : ""}` : ""}
                            {wordCount ? ` | ${wordCount.toLocaleString()} words` : ""}
                          </span>
                          {document.summary && (
                            <span className="mt-2 line-clamp-4 block text-xs leading-5 text-slate-300/80">
                              {document.summary}
                            </span>
                          )}
                        </span>
                        <button
                          className="icon-button-dark h-8 w-8 shrink-0 opacity-0 transition group-hover:opacity-100"
                          onClick={async () => {
                            await onDeleteDocument(document.id);
                          }}
                          title="Delete document"
                          type="button"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!documents.length && (
                  <div className="rounded-lg border border-dashed border-white/15 p-4 text-sm text-slate-400">
                    Uploaded documents will appear here after you attach them in the composer.
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="memory"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="space-y-3"
              >
                <div className="rounded-lg border border-fuchsia-300/20 bg-fuchsia-300/10 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
                    <Sparkles size={15} className="text-fuchsia-200" />
                    Personal signal
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs text-slate-200">
                    <span className="rounded-md bg-white/10 p-2">Trust {humanState?.profile.trust_score ?? 50}</span>
                    <span className="rounded-md bg-white/10 p-2">Humor {humanState?.profile.humor_score ?? 30}</span>
                    <span className="rounded-md bg-white/10 p-2">Flow {humanState?.profile.rapport_score ?? 40}</span>
                  </div>
                </div>

                <form className="rounded-lg border border-white/10 bg-white/[0.04] p-3" onSubmit={createMemory}>
                  <select
                    className="model-select-dark mb-2 w-full"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                    aria-label="Memory category"
                  >
                    <option value="preference">Preference</option>
                    <option value="project">Project</option>
                    <option value="identity">Identity</option>
                    <option value="learning_goal">Learning</option>
                  </select>
                  <textarea
                    className="min-h-20 w-full resize-none rounded-md border border-white/10 bg-slate-950/50 p-2 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-200/60"
                    value={memoryDraft}
                    onChange={(event) => setMemoryDraft(event.target.value)}
                    placeholder="Save a preference or project detail"
                  />
                  <button className="btn-primary mt-2 w-full" disabled={!memoryDraft.trim()}>
                    Save memory
                  </button>
                </form>

                {(humanState?.memories ?? []).map((memory) => (
                  <div key={memory.id} className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs uppercase text-cyan-200/70">{memory.category}</p>
                        <p className="mt-1 text-sm leading-5 text-white">{memory.value}</p>
                      </div>
                      <button
                        className="icon-button-dark h-8 w-8"
                        onClick={() => deleteMemory(memory)}
                        title="Delete memory"
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p className="text-xs text-slate-500">{Math.round(memory.confidence * 100)}% confidence</p>
                  </div>
                ))}
                {!humanState?.memories.length && (
                  <div className="rounded-lg border border-dashed border-white/15 p-4 text-sm text-slate-400">
                    Memories you save or teach Auto-AI will appear here.
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </aside>
  );
}
