import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Box, BrainCircuit, Check, ChevronDown, ChevronRight, FileText, Plus, SendHorizonal, Sparkles, Timer, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { AiProvider, ChatMode, DocumentItem, ResearchModelOptions, ResearchProvider, SearchMode } from "../../types";
import { PROVIDER_MODELS, useAppSettings } from "../../contexts/AppSettingsContext";
import { VoiceButton } from "./VoiceButton";

type Provider = AiProvider;

export type ComposerOptions = {
  searchMode: SearchMode;
  chatMode: ChatMode;
  researchProviders: ResearchProvider[];
  maxModels: number;
  allModels: boolean;
  timeoutSeconds: number;
  groqModels: string[];
  bedrockModels: string[];
  openaiModels: string[];
  geminiModels: string[];
  finalJudgeModel: string | null;
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
const MODE_OPTIONS: Array<{ value: string; label: string; searchMode: SearchMode; chatMode: ChatMode }> = [
  { value: "normal", label: "Normal", searchMode: "auto", chatMode: "normal" },
  { value: "deep", label: "Deep", searchMode: "deep", chatMode: "deep_research" },
  { value: "research", label: "Research", searchMode: "research", chatMode: "multi_model" }
];

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  bedrock: "Bedrock",
  gemini: "Gemini"
};

type ModelOption = { value: string; label: string };

const INTELLIGENCE_PRESETS: Array<{ value: string; label: string; provider: Provider; model: string }> = [
  { value: "instant", label: "Instant", provider: "groq", model: "llama-3.1-8b-instant" },
  { value: "medium", label: "Medium", provider: "groq", model: "openai/gpt-oss-20b" },
  { value: "high", label: "High", provider: "groq", model: "openai/gpt-oss-120b" }
];

function readableModelLabel(value: string) {
  for (const options of Object.values(PROVIDER_MODELS)) {
    const found = options.find((option) => option.value === value);
    if (found) return found.label;
  }
  return value
    .replace(/^amazon\./, "Amazon ")
    .replace(/^anthropic\./, "Claude ")
    .replace(/^gemini-/, "Gemini ")
    .replace(/^openai[/.]/, "GPT ")
    .replace(/^llama-/, "Llama ")
    .replace(/^meta-/, "Meta ")
    .replace(/[:/_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function modelOptionsFor(provider: Provider, configured?: string[]): ModelOption[] {
  const configuredModels = configured?.filter(Boolean) ?? [];
  const values = configuredModels.length ? configuredModels : PROVIDER_MODELS[provider].map((option) => option.value);
  return values.map((value) => ({ value, label: readableModelLabel(value) }));
}

function researchOptionsFor(provider: ResearchProvider, config: ResearchModelOptions | null): ModelOption[] {
  return modelOptionsFor(provider, config?.providers[provider]?.models);
}

function ModelMenu({
  provider,
  model,
  onSelect
}: {
  provider: Provider;
  model: string;
  onSelect: (provider: Provider, model: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<Provider>(provider);
  const preset = INTELLIGENCE_PRESETS.find((item) => item.provider === provider && item.model === model);
  const triggerLabel = preset?.label ?? readableModelLabel(model);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="model-menu">
      <button
        className={clsx("composer-pill model-menu-trigger", provider !== "groq" || preset ? "composer-pill-active" : "")}
        type="button"
        onClick={() => {
          setActiveProvider(provider);
          setOpen((current) => !current);
        }}
        title="Choose intelligence and model"
      >
        <BrainCircuit size={18} />
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="model-menu-panel">
          <div className="model-menu-title">Intelligence</div>
          {INTELLIGENCE_PRESETS.map((item) => (
            <button
              key={item.value}
              className="model-menu-item"
              type="button"
              onClick={() => {
                onSelect(item.provider, item.model);
                setOpen(false);
              }}
            >
              <span>{item.label}</span>
              {provider === item.provider && model === item.model && <Check size={14} />}
            </button>
          ))}
          <div className="model-menu-separator" />
          {(["groq", "bedrock", "openai", "gemini"] as Provider[]).map((item) => (
            <button
              key={item}
              className={clsx("model-menu-item model-menu-parent", activeProvider === item && "model-menu-item-active")}
              type="button"
              onClick={() => setActiveProvider(item)}
              onFocus={() => setActiveProvider(item)}
              onMouseEnter={() => setActiveProvider(item)}
            >
              <span>{PROVIDER_LABELS[item]}</span>
              <ChevronRight size={14} />
            </button>
          ))}
          <div className="model-menu-subpanel">
            {modelOptionsFor(activeProvider).map((option) => (
              <button
                key={option.value}
                className="model-menu-item"
                type="button"
                onClick={() => {
                  onSelect(activeProvider, option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {provider === activeProvider && model === option.value && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ResearchModelMenu({
  config,
  selectedGroqModels,
  selectedBedrockModels,
  selectedOpenAiModels,
  selectedGeminiModels,
  onToggle
}: {
  config: ResearchModelOptions | null;
  selectedGroqModels: string[];
  selectedBedrockModels: string[];
  selectedOpenAiModels: string[];
  selectedGeminiModels: string[];
  onToggle: (provider: ResearchProvider, model: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<ResearchProvider>("groq");
  const providerOptions = {
    groq: researchOptionsFor("groq", config),
    bedrock: researchOptionsFor("bedrock", config),
    openai: researchOptionsFor("openai", config),
    gemini: researchOptionsFor("gemini", config)
  };
  const selectedByProvider = {
    groq: selectedGroqModels,
    bedrock: selectedBedrockModels,
    openai: selectedOpenAiModels,
    gemini: selectedGeminiModels
  };
  const selectedCount = selectedGroqModels.length + selectedBedrockModels.length + selectedOpenAiModels.length + selectedGeminiModels.length;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="model-menu model-menu-research">
      <button className="chip-dark model-menu-compact-trigger" type="button" onClick={() => setOpen((current) => !current)}>
        <Box size={13} />
        Models {selectedCount ? `(${selectedCount})` : ""}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="model-menu-panel model-menu-panel-compact">
          <div className="model-menu-title">Research Models</div>
          {(["groq", "bedrock", "openai", "gemini"] as ResearchProvider[]).map((item) => {
            const enabled = !config || config.providers[item]?.enabled;
            const optionCount = providerOptions[item].length;
            return (
              <button
                key={item}
                className={clsx(
                  "model-menu-item model-menu-parent",
                  activeProvider === item && "model-menu-item-active",
                  (!enabled || optionCount === 0) && "model-menu-item-disabled"
                )}
                type="button"
                disabled={!enabled || optionCount === 0}
                onClick={() => setActiveProvider(item)}
                onFocus={() => setActiveProvider(item)}
                onMouseEnter={() => setActiveProvider(item)}
              >
                <span>{PROVIDER_LABELS[item]}</span>
                <span className="model-menu-muted">
                  {enabled ? selectedByProvider[item].length || "Auto" : "Off"}
                  <ChevronRight size={14} />
                </span>
              </button>
            );
          })}
          <div className="model-menu-subpanel">
            {providerOptions[activeProvider].map((option) => {
              const checked = selectedByProvider[activeProvider].includes(option.value);
              return (
                <button
                  key={option.value}
                  className="model-menu-item"
                  type="button"
                  onClick={() => onToggle(activeProvider, option.value)}
                >
                  <span>{option.label}</span>
                  {checked && <Check size={14} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const { token } = useAuth();
  const { settings } = useAppSettings();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  const [draft, setDraft] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [chatMode, setChatMode] = useState<ChatMode>("normal");
  const [researchProviders, setResearchProviders] = useState<ResearchProvider[]>(settings.deepResearchProviders);
  const [maxModels, setMaxModels] = useState(settings.deepResearchMaxModels);
  const [allModels, setAllModels] = useState(settings.deepResearchAllModels);
  const [timeoutSeconds, setTimeoutSeconds] = useState(settings.deepResearchTimeoutSeconds);
  const [researchModelOptions, setResearchModelOptions] = useState<ResearchModelOptions | null>(null);
  const [groqModels, setGroqModels] = useState<string[]>([]);
  const [bedrockModels, setBedrockModels] = useState<string[]>([]);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [finalJudgeModel, setFinalJudgeModel] = useState<string | null>(null);
  const [reasoning] = useState(false);
  const [provider, setProvider] = useState<Provider>(settings.defaultProvider);
  const [model, setModel] = useState<string>(settings.defaultModel);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [error, setError] = useState("");

  const uploading = uploadTasks.some((task) => task.status === "uploading" || task.status === "processing");
  const canSend = Boolean(draft.trim() || imageAttachments.length) && !disabled && !sending && !uploading;
  const enabledResearchProviders = useMemo(
    () =>
      (["groq", "bedrock", "openai", "gemini"] as ResearchProvider[]).filter(
        (item) => !researchModelOptions || researchModelOptions.providers[item]?.enabled
      ),
    [researchModelOptions]
  );
  const effectiveResearchProviders = useMemo(() => {
    const selected = researchProviders.filter((item) => enabledResearchProviders.includes(item));
    return selected.length ? selected : enabledResearchProviders;
  }, [enabledResearchProviders, researchProviders]);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(() => {
    setProvider(settings.defaultProvider);
    setModel(settings.defaultModel);
  }, [settings.defaultModel, settings.defaultProvider]);

  useEffect(() => {
    setResearchProviders(settings.deepResearchProviders);
    setMaxModels(settings.deepResearchMaxModels);
    setAllModels(settings.deepResearchAllModels);
    setTimeoutSeconds(settings.deepResearchTimeoutSeconds);
  }, [
    settings.deepResearchAllModels,
    settings.deepResearchMaxModels,
    settings.deepResearchProviders,
    settings.deepResearchTimeoutSeconds
  ]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    api.researchModels(token)
      .then((options) => {
        if (!active) return;
        setResearchModelOptions(options);
        setFinalJudgeModel(options.defaults.final_judge_model ?? null);
        const enabled = (["groq", "bedrock", "openai", "gemini"] as ResearchProvider[]).filter((item) => options.providers[item]?.enabled);
        if (enabled.length) setResearchProviders((current) => current.filter((item) => enabled.includes(item)).concat(enabled.filter((item) => !current.includes(item))));
      })
      .catch(() => {
        if (active) setResearchModelOptions(null);
      });
    return () => {
      active = false;
    };
  }, [token]);

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
      await onSend(
        text,
        {
          searchMode,
          chatMode,
          researchProviders: effectiveResearchProviders,
          maxModels,
          allModels,
          timeoutSeconds,
          groqModels,
          bedrockModels,
          openaiModels,
          geminiModels,
          finalJudgeModel,
          reasoning,
          provider,
          model
        },
        files
      );
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
  const researchModeActive = chatMode !== "normal";

  function toggleResearchProvider(nextProvider: ResearchProvider) {
    if (researchModelOptions && !researchModelOptions.providers[nextProvider]?.enabled) return;
    setResearchProviders((current) => {
      if (current.includes(nextProvider)) {
        return current.length === 1 ? current : current.filter((item) => item !== nextProvider);
      }
      return [...current, nextProvider];
    });
  }

  function toggleResearchModel(nextProvider: ResearchProvider, nextModel: string) {
    const setter =
      nextProvider === "groq"
        ? setGroqModels
        : nextProvider === "bedrock"
          ? setBedrockModels
          : nextProvider === "openai"
            ? setOpenaiModels
            : setGeminiModels;
    setter((current) => {
      if (current.includes(nextModel)) return current.filter((item) => item !== nextModel);
      return [...current, nextModel];
    });
    setResearchProviders((current) => (current.includes(nextProvider) ? current : [...current, nextProvider]));
  }

  function selectModelProvider(nextProvider: Provider, nextModel: string) {
    setProvider(nextProvider);
    setModel(nextModel);
  }

  function updateCombinedMode(value: string) {
    const option = MODE_OPTIONS.find((item) => item.value === value);
    if (!option) return;
    setSearchMode(option.searchMode);
    setChatMode(option.chatMode);
  }

  const selectedModeValue =
    MODE_OPTIONS.find((option) => option.searchMode === searchMode && option.chatMode === chatMode)?.value ?? "auto";

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
                    <img
                      src={attachment.previewUrl}
                      alt={`Attached image preview: ${attachment.file.name}`}
                      loading="lazy"
                      decoding="async"
                    />
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
          <div className={clsx("composer-pill composer-mode-pill", (searchMode !== "off" || researchModeActive) && "composer-pill-active")} title="Mode">
            <Sparkles size={18} />
            <select
              aria-label="Mode"
              className="composer-pill-select"
              value={selectedModeValue}
              onChange={(event) => updateCombinedMode(event.target.value)}
            >
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <span className="composer-divider" />
          <ModelMenu provider={provider} model={model} onSelect={selectModelProvider} />
        </div>

        <AnimatePresence>
          {researchModeActive && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 overflow-visible"
            >
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-2 text-xs text-cyan-50">
                <span className="inline-flex items-center gap-1 font-semibold text-cyan-100">
                  <BrainCircuit size={14} />
                  Multi-model reasoning active
                </span>
                {(["groq", "bedrock", "openai", "gemini"] as ResearchProvider[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    disabled={researchModelOptions ? !researchModelOptions.providers[item]?.enabled : false}
                    className={clsx(
                      "inline-flex h-7 items-center gap-1 rounded-md border px-2 font-semibold transition",
                      researchProviders.includes(item)
                        ? "border-cyan-200/35 bg-cyan-200/12 text-cyan-50"
                        : "border-white/10 bg-white/5 text-slate-400",
                      researchModelOptions && !researchModelOptions.providers[item]?.enabled && "opacity-40"
                    )}
                    onClick={() => toggleResearchProvider(item)}
                  >
                    {researchProviders.includes(item) && <Check size={12} />}
                    {PROVIDER_LABELS[item]}
                  </button>
                ))}
                <ResearchModelMenu
                  config={researchModelOptions}
                  selectedGroqModels={groqModels}
                  selectedBedrockModels={bedrockModels}
                  selectedOpenAiModels={openaiModels}
                  selectedGeminiModels={geminiModels}
                  onToggle={toggleResearchModel}
                />
                <label className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2">
                  <Box size={13} />
                  <select
                    className="border-0 bg-transparent text-xs font-semibold text-cyan-50 outline-none"
                    value={maxModels}
                    disabled={allModels}
                    onChange={(event) => setMaxModels(Number(event.target.value))}
                    aria-label="Max research models"
                  >
                    {[1, 2, 3, 4, 5, 6].map((value) => (
                      <option key={value} value={value}>
                        Max {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 font-semibold">
                  <input
                    type="checkbox"
                    checked={allModels}
                    onChange={(event) => setAllModels(event.target.checked)}
                  />
                  All models
                </label>
                <label className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2">
                  <Timer size={13} />
                  <select
                    className="border-0 bg-transparent text-xs font-semibold text-cyan-50 outline-none"
                    value={timeoutSeconds}
                    onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
                    aria-label="Research timeout"
                  >
                    {[20, 35, 45, 60].map((value) => (
                      <option key={value} value={value}>
                        {value}s
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

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
