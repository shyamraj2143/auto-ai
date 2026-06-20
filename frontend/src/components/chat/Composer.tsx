import { FormEvent, useEffect, useRef, useState } from "react";
import { FileText, Globe2, Image, Lightbulb, Paperclip, SendHorizonal, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import type { DocumentItem } from "../../types";
import { VoiceButton } from "./VoiceButton";

type Provider = keyof typeof PROVIDER_MODELS;

export type ComposerOptions = {
  webSearch: boolean;
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

const PROVIDER_MODELS = {
  openai: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { value: "gpt-4o-mini", label: "GPT-4o mini" },
    { value: "gpt-4.1", label: "GPT-4.1" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-5-mini", label: "GPT-5 mini" }
  ],
  groq: [
    { value: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    { value: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B" },
    { value: "qwen/qwen3-32b", label: "Qwen 3 32B" },
    { value: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout" }
  ],
  bedrock: [
    { value: "openai.gpt-oss-120b", label: "GPT-OSS 120B" },
    { value: "openai.gpt-oss-20b", label: "GPT-OSS 20B" },
    { value: "mistral.ministral-3-8b-instruct", label: "Ministral 3 8B" },
    { value: "mistral.ministral-3-14b-instruct", label: "Ministral 3 14B" },
    { value: "mistral.mistral-large-3-675b-instruct", label: "Mistral Large 3" },
    { value: "google.gemma-3-27b-it", label: "Gemma 3 27B" },
    { value: "qwen.qwen3-coder-30b-a3b-instruct", label: "Qwen 3 Coder 30B" }
  ]
} as const;

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  const [draft, setDraft] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [provider, setProvider] = useState<Provider>("groq");
  const [model, setModel] = useState<string>(PROVIDER_MODELS.groq[0].value);
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
      await onSend(text, { webSearch, reasoning, provider, model }, files);
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

        <textarea
          className="composer-textarea"
          placeholder={
            selectedDocuments.length
              ? `Ask about ${selectedDocuments.length} selected document${selectedDocuments.length > 1 ? "s" : ""}`
              : "Message Auto-AI"
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
          <div className="flex flex-wrap items-center gap-2">
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
            <button className="icon-button-dark" type="button" onClick={() => fileInputRef.current?.click()} title="Attach files">
              <Paperclip size={17} />
            </button>
            <button className="icon-button-dark" type="button" onClick={() => fileInputRef.current?.click()} title="Attach image">
              <Image size={17} />
            </button>
            <button
              type="button"
              className={clsx("chip-dark", webSearch && "chip-dark-active")}
              disabled={provider !== "groq"}
              onClick={() => setWebSearch((value) => !value)}
              title={provider === "groq" ? "Toggle web search" : "Web search requires Groq"}
            >
              <Globe2 size={15} />
              Search
            </button>
            <button
              type="button"
              className={clsx("chip-dark", reasoning && "chip-dark-active")}
              onClick={() => setReasoning((value) => !value)}
            >
              <Lightbulb size={15} />
              Reason
            </button>
            <select
              aria-label="AI provider"
              className="model-select-dark w-28"
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value as Provider;
                setProvider(nextProvider);
                setModel(PROVIDER_MODELS[nextProvider][0].value);
                if (nextProvider !== "groq") setWebSearch(false);
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="groq">Groq</option>
              <option value="bedrock">Bedrock</option>
            </select>
            <select
              aria-label="AI model"
              className="model-select-dark w-44 sm:w-52"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {PROVIDER_MODELS[provider].map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <VoiceButton onTranscript={(text) => setDraft((current) => [current, text].filter(Boolean).join(" "))} />
            <button className="send-button" disabled={!canSend} type="submit" title="Send message">
              <SendHorizonal size={18} />
              <span>{sending ? "Sending" : "Send"}</span>
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
