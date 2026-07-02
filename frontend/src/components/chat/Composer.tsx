import { FormEvent, useEffect, useRef, useState } from "react";
import { Box, FileText, Plus, SendHorizonal, Sparkles, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import type { DocumentItem, SearchMode } from "../../types";
import { PROVIDER_MODELS, useAppSettings, type AiProvider } from "../../contexts/AppSettingsContext";
import { VoiceButton } from "./VoiceButton";

type Provider = AiProvider;

export type ComposerOptions = {
  searchMode: SearchMode;
  reasoning: boolean;
  provider: Provider;
  model: string;
};

export type UploadTask = {
  id: string;
  filename: string;
  progress: number;
  status: "uploading" | "processing" | "done" | "error";
  error?: string;
};

type ImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const SEARCH_MODES: Array<{ value: SearchMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "web", label: "Web" },
  { value: "news", label: "News" },
  { value: "research", label: "Research" },
  { value: "deep", label: "Deep" }
];

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  bedrock: "Bedrock"
};

function fileExtension(file: File) {
  const name = file.name.toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

function isDocument(file: File) {
  return DOCUMENT_EXTENSIONS.has(fileExtension(file));
}

function isImage(file: File) {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(fileExtension(file));
}

export function Composer({
  disabled,
  selectedDocuments,
  uploadTasks,
  onRemoveDocument,
  onDeleteDocument,
  onUploadDocuments,
  onSend
}: {
  disabled?: boolean;
  selectedDocuments: DocumentItem[];
  uploadTasks: UploadTask[];
  onRemoveDocument: (id: string) => void;
  onDeleteDocument: (id: string) => Promise<void>;
  onUploadDocuments: (files: File[], provider: Provider) => Promise<void>;
  onSend: (text: string, options: ComposerOptions, imageFiles: File[]) => Promise<void>;
}) {
  const { settings } = useAppSettings();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  const [draft, setDraft] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [reasoning] = useState(false);
  const [provider, setProvider] = useState<Provider>(settings.defaultProvider);
  const [model, setModel] = useState<string>(settings.defaultModel);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [error, setError] = useState("");

  const uploading = uploadTasks.some((task) => task.status === "uploading" || task.status === "processing");
  const canSend = Boolean(draft.trim() || imageAttachments.length) && !disabled && !sending && !uploading;

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(() => {
    setProvider(settings.defaultProvider);
    setModel(settings.defaultModel);
  }, [settings.defaultModel, settings.defaultProvider]);

  useEffect(() => {
    return () => {
      imageAttachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    };
  }, []);

  async function addFiles(files: File[]) {
    setError("");
    const documentFiles: File[] = [];
    const imageFiles: ImageAttachment[] = [];
    const unsupported: string[] = [];

    files.forEach((file) => {
      if (isDocument(file)) {
        documentFiles.push(file);
        return;
      }
      if (isImage(file)) {
        imageFiles.push({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file)
        });
        return;
      }
      unsupported.push(file.name);
    });

    if (imageFiles.length) {
      setImageAttachments((current) => {
        const next = [...current, ...imageFiles];
        const overflow = next.slice(0, Math.max(0, next.length - 6));
        overflow.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        return next.slice(-6);
      });
    }
    if (documentFiles.length) {
      await onUploadDocuments(documentFiles, provider);
    }
    if (unsupported.length) {
      setError(`Unsupported file: ${unsupported.join(", ")}`);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    const text = draft.trim() || "Analyze the attached image.";
    const files = imageAttachments.map((attachment) => attachment.file);
    setDraft("");
    imageAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    setImageAttachments([]);
    setSending(true);
    try {
      await onSend(text, { searchMode, reasoning, provider, model }, files);
    } finally {
      setSending(false);
    }
  }

  function removeImage(id: string) {
    setImageAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  const openFilePicker = () => fileInputRef.current?.click();
  return (
    <form
      className="composer-shell"
      onSubmit={submit}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget === event.target) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className={clsx("composer-card", dragActive && "composer-card-active")}>
        <AnimatePresence>
          {(selectedDocuments.length > 0 || uploadTasks.length > 0 || imageAttachments.length > 0 || error) && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-2 overflow-hidden"
            >
              {error && <div className="rounded-md border border-red-300/30 bg-red-500/10 px-3 py-2 text-xs text-red-100">{error}</div>}
              <div className="flex flex-wrap gap-2">
                {selectedDocuments.map((document) => (
                  <span key={document.id} className="attachment-chip">
                    <FileText size={14} />
                    <span className="max-w-40 truncate">{document.filename}</span>
                    <button type="button" onClick={() => onRemoveDocument(document.id)} title="Remove document">
                      <X size={13} />
                    </button>
                    <button type="button" onClick={() => onDeleteDocument(document.id)} title="Delete document">
                      <Trash2 size={13} />
                    </button>
                  </span>
                ))}
                {imageAttachments.map((attachment) => (
                  <span key={attachment.id} className="image-chip">
                    <img src={attachment.previewUrl} alt="" />
                    <span className="max-w-32 truncate">{attachment.file.name}</span>
                    <button type="button" onClick={() => removeImage(attachment.id)} title="Remove image">
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
              {uploadTasks.map((task) => (
                <div key={task.id} className="upload-progress">
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-slate-200">{task.filename}</span>
                    <span className={task.status === "error" ? "text-red-200" : "text-cyan-100"}>
                      {task.status === "error" ? "Failed" : `${task.progress}%`}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <span
                      className={clsx("block h-full rounded-full", task.status === "error" ? "bg-red-400" : "bg-cyan-300")}
                      style={{ width: `${Math.max(task.progress, task.status === "processing" ? 92 : 4)}%` }}
                    />
                  </div>
                  {task.error && <p className="mt-1 text-xs text-red-200">{task.error}</p>}
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          multiple
          accept=".pdf,.docx,.txt,image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) addFiles(files);
            event.target.value = "";
          }}
        />
        <div className="composer-top-row">
          <button className="composer-plus-button" type="button" onClick={openFilePicker} title="Attach files">
            <Plus size={19} />
          </button>
          <div className={clsx("composer-pill", searchMode !== "off" && "composer-pill-active")} title="Search mode">
              <Sparkles size={18} />
              <select
                aria-label="Search mode"
                className="composer-pill-select"
                value={searchMode}
                onChange={(event) => setSearchMode(event.target.value as SearchMode)}
              >
                {SEARCH_MODES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          <span className="composer-divider" />
          <div className="composer-pill" title="Model provider">
            <Box size={18} />
            <select
              aria-label="AI provider"
              className="composer-pill-select"
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value as Provider;
                setProvider(nextProvider);
                setModel(PROVIDER_MODELS[nextProvider][0].value);
              }}
            >
              {(Object.keys(PROVIDER_LABELS) as Provider[]).map((option) => (
                <option key={option} value={option}>
                  {PROVIDER_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="composer-input-row">
          <textarea
            className="composer-textarea"
            placeholder={
              selectedDocuments.length
                ? `Ask about ${selectedDocuments.length} selected document${selectedDocuments.length > 1 ? "s" : ""}`
                : "Ask anything..."
            }
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-inline-actions">
            {settings.voiceEnabled && (
              <VoiceButton onTranscript={(text) => setDraft((current) => [current, text].filter(Boolean).join(" "))} />
            )}
            <button className="send-button composer-send-round" disabled={!canSend} type="submit" title="Send message">
              <SendHorizonal size={18} />
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
