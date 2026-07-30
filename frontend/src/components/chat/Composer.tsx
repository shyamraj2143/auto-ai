import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Box, BrainCircuit, Camera, Check, ChevronDown, FileImage, FileText, Plus, Search, SendHorizonal, Sparkles, Square, Timer, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { AiProvider, ChatMode, DocumentItem, IntelligenceConfig, ResearchModelOptions, ResearchProvider, SearchMode } from "../../types";
import { PROVIDER_MODELS, useAppSettings } from "../../contexts/AppSettingsContext";
import { useCrystalEffects } from "../../crystal/useCrystalEffects";
import { VoiceButton } from "./VoiceButton";
import { usePublishedUiText } from "../../hooks/useCmsContent";
import { AppSelect } from "../common/AppSelect";
import { COMPOSER_MODE_OPTIONS, composerModeOption, composerModeValue } from "./composerSelection";
import { ComposerPopover } from "./ComposerPopover";

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
const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  bedrock: "Bedrock",
  gemini: "Gemini"
};

type ModelOption = { value: string; label: string };
type ComposerOpenMenu = "attachments" | "mode" | "model" | "research-model" | null;

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
  open,
  onToggle,
  onClose,
  onSelect
}: {
  provider: Provider;
  model: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (provider: Provider, model: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [activeProvider, setActiveProvider] = useState<Provider>(provider);
  const [query, setQuery] = useState("");
  const triggerLabel = readableModelLabel(model);
  const options = modelOptionsFor(activeProvider);
  const filteredOptions = options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => setActiveProvider(provider), [provider]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className="model-menu">
      <button
        ref={triggerRef}
        className={clsx("composer-pill model-menu-trigger", provider !== "groq" && "composer-pill-active")}
        type="button"
        onClick={() => {
          setActiveProvider(provider);
          onToggle();
        }}
        title="Choose intelligence and model"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="composer-model-popover"
      >
        <BrainCircuit size={18} />
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown size={15} />
      </button>
      <ComposerPopover open={open} triggerRef={triggerRef} onClose={onClose} ariaLabel="Choose AI model" preferredWidth={420} maxWidth={420} placement="top-end" className="composer-model-popover" backdrop="model">
        <div id="composer-model-popover" className="composer-model-panel">
          <div className="composer-popover-header">
            <span>AI model</span>
            <small>{triggerLabel}</small>
          </div>
          <div className="composer-model-provider-tabs" role="tablist" aria-label="Model providers">
          {(["groq", "bedrock", "openai", "gemini"] as Provider[]).map((item) => (
            <button
              key={item}
              className={clsx(activeProvider === item && "composer-popover-option-active")}
              type="button"
              role="tab"
              aria-selected={activeProvider === item}
              onClick={() => setActiveProvider(item)}
              onFocus={() => setActiveProvider(item)}
            >
              <span>{PROVIDER_LABELS[item]}</span>
            </button>
          ))}
          </div>
          {options.length > 8 && (
            <label className="composer-model-search">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models" />
            </label>
          )}
          <div className="composer-popover-list composer-model-list" role="listbox" aria-label={`${PROVIDER_LABELS[activeProvider]} models`}>
            {filteredOptions.map((option) => (
              <button
                key={option.value}
                className={clsx("composer-popover-option", provider === activeProvider && model === option.value && "composer-popover-option-active")}
                type="button"
                role="option"
                aria-selected={provider === activeProvider && model === option.value}
                onClick={() => {
                  onSelect(activeProvider, option.value);
                  onClose();
                }}
              >
                <span><strong>{option.label}</strong><small>{PROVIDER_LABELS[activeProvider]}</small></span>
                {provider === activeProvider && model === option.value && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      </ComposerPopover>
    </div>
  );
}

function ModeMenu({
  value,
  config,
  open,
  onToggle,
  onClose,
  onSelect
}: {
  value: string;
  config: IntelligenceConfig | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (value: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = composerModeOption(value);
  const descriptions: Record<string, string> = {
    instant: "Fast single-model response",
    medium: "Balanced parallel intelligence",
    high: "Advanced multi-provider reasoning",
    deep_research: "Source-backed comprehensive research"
  };

  return (
    <div className="model-menu mode-menu">
      <button
        ref={triggerRef}
        type="button"
        className="composer-pill composer-mode-pill composer-pill-active"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="composer-mode-popover"
        title="Choose intelligence preset"
      >
        <Sparkles size={18} />
        <span className="composer-mode-label">{selected.label}</span>
        <ChevronDown size={15} />
      </button>
      <ComposerPopover open={open} triggerRef={triggerRef} onClose={onClose} ariaLabel="Choose intelligence preset" preferredWidth={360} maxWidth={380}>
        <div id="composer-mode-popover">
          <div className="composer-popover-header">Intelligence preset</div>
          <div className="composer-popover-list" role="menu">
          {COMPOSER_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === selected.value}
              aria-disabled={config?.modes[option.value]?.available === false}
              disabled={config?.modes[option.value]?.available === false}
              className={clsx("composer-popover-option", option.value === selected.value && "composer-popover-option-active")}
              onClick={() => {
                onSelect(option.value);
                onClose();
              }}
            >
              <span>
                <strong>{option.label}</strong>
                <small>
                  {config?.modes[option.value]?.available === false
                    ? "Temporarily unavailable"
                    : config?.modes[option.value]?.fallback_message || descriptions[option.value] || "Choose this intelligence preset"}
                </small>
              </span>
              {option.value === selected.value && <Check size={14} />}
            </button>
          ))}
          </div>
        </div>
      </ComposerPopover>
    </div>
  );
}

function ResearchModelMenu({
  config,
  selectedGroqModels,
  selectedBedrockModels,
  selectedOpenAiModels,
  selectedGeminiModels,
  open,
  onToggleMenu,
  onClose,
  onToggle
}: {
  config: ResearchModelOptions | null;
  selectedGroqModels: string[];
  selectedBedrockModels: string[];
  selectedOpenAiModels: string[];
  selectedGeminiModels: string[];
  open: boolean;
  onToggleMenu: () => void;
  onClose: () => void;
  onToggle: (provider: ResearchProvider, model: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
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

  return (
    <div className="model-menu model-menu-research">
      <button ref={triggerRef} className="chip-dark model-menu-compact-trigger" type="button" onClick={onToggleMenu} aria-expanded={open} aria-haspopup="dialog" aria-controls="composer-research-model-popover">
        <Box size={13} />
        Models {selectedCount ? `(${selectedCount})` : ""}
        <ChevronDown size={13} />
      </button>
      <ComposerPopover open={open} triggerRef={triggerRef} onClose={onClose} ariaLabel="Research models" preferredWidth={380} maxWidth={420} placement="top-end" className="composer-research-model-popover" backdrop="model">
        <div id="composer-research-model-popover" className="composer-model-panel">
          <div className="composer-popover-header">Research models</div>
          <div className="composer-model-provider-tabs" role="tablist" aria-label="Research model providers">
          {(["groq", "bedrock", "openai", "gemini"] as ResearchProvider[]).map((item) => {
            const enabled = !config || config.providers[item]?.enabled;
            const optionCount = providerOptions[item].length;
            return (
              <button
                key={item}
                className={clsx(
                  activeProvider === item && "composer-popover-option-active",
                  (!enabled || optionCount === 0) && "model-menu-item-disabled"
                )}
                type="button"
                role="tab"
                aria-selected={activeProvider === item}
                disabled={!enabled || optionCount === 0}
                onClick={() => setActiveProvider(item)}
                onFocus={() => setActiveProvider(item)}
              >
                <span>{PROVIDER_LABELS[item]}</span>
                <span className="model-menu-muted">
                  {enabled ? selectedByProvider[item].length || "Auto" : "Off"}
                </span>
              </button>
            );
          })}
          </div>
          <div className="composer-popover-list composer-model-list" role="listbox" aria-label={`${PROVIDER_LABELS[activeProvider]} research models`}>
            {providerOptions[activeProvider].map((option) => {
              const checked = selectedByProvider[activeProvider].includes(option.value);
              return (
                <button
                  key={option.value}
                  className={clsx("composer-popover-option", checked && "composer-popover-option-active")}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => onToggle(activeProvider, option.value)}
                >
                  <span><strong>{option.label}</strong><small>{PROVIDER_LABELS[activeProvider]}</small></span>
                  {checked && <Check size={14} />}
                </button>
              );
            })}
          </div>
        </div>
      </ComposerPopover>
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
  onSend,
  onStop,
  onOpenLiveMode,
  focusKey,
  initialDraft = "",
  conversationMode
}: {
  disabled?: boolean;
  selectedDocuments: DocumentItem[];
  uploadTasks: UploadTask[];
  onRemoveDocument: (id: string) => void;
  onDeleteDocument: (id: string) => Promise<void>;
  onUploadDocuments: (files: File[], provider: Provider) => Promise<void>;
  onSend: (text: string, options: ComposerOptions, imageFiles: File[]) => Promise<void | boolean>;
  onStop?: () => Promise<void> | void;
  onOpenLiveMode: () => void;
  focusKey?: string;
  initialDraft?: string;
  conversationMode?: string;
}) {
  const uiText = usePublishedUiText();
  const { token, user } = useAuth();
  const { settings } = useAppSettings();
  const crystalEffects = useCrystalEffects();
  const attachmentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  const [draft, setDraft] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("autoai-intelligence-mode") : null;
    return composerModeOption(stored || "instant").chatMode;
  });
  const [researchProviders, setResearchProviders] = useState<ResearchProvider[]>(settings.deepResearchProviders);
  const [maxModels, setMaxModels] = useState(settings.deepResearchMaxModels);
  const [allModels, setAllModels] = useState(settings.deepResearchAllModels);
  const [timeoutSeconds, setTimeoutSeconds] = useState(settings.deepResearchTimeoutSeconds);
  const [researchModelOptions, setResearchModelOptions] = useState<ResearchModelOptions | null>(null);
  const [intelligenceConfig, setIntelligenceConfig] = useState<IntelligenceConfig | null>(null);
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
  const [openMenu, setOpenMenu] = useState<ComposerOpenMenu>(null);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [error, setError] = useState("");
  const appliedInitialDraftRef = useRef("");

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
    textareaRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  useEffect(() => {
    const next = initialDraft.trim();
    if (!next || appliedInitialDraftRef.current === next) return;
    appliedInitialDraftRef.current = next;
    setDraft((current) => current.trim() ? current : next);
  }, [initialDraft]);

  useEffect(() => {
    const handleAndroidBack = (event: Event) => {
      if (imageAttachmentsRef.current.length) {
        event.preventDefault();
        clearImageAttachments();
      }
    };
    window.addEventListener("auto-ai-android-back", handleAndroidBack);
    return () => window.removeEventListener("auto-ai-android-back", handleAndroidBack);
  }, []);

  useEffect(() => {
    const close = () => setOpenMenu(null);
    window.addEventListener("popstate", close);
    window.addEventListener("hashchange", close);
    return () => {
      window.removeEventListener("popstate", close);
      window.removeEventListener("hashchange", close);
    };
  }, []);

  useEffect(() => {
    setProvider(settings.defaultProvider);
    setModel(settings.defaultModel);
  }, [settings.defaultModel, settings.defaultProvider]);

  useEffect(() => {
    const preferred = conversationMode || user?.intelligence_mode;
    if (!preferred) return;
    const option = composerModeOption(preferred);
    setChatMode(option.chatMode);
    setSearchMode(option.searchMode);
    window.localStorage.setItem("autoai-intelligence-mode", option.value);
  }, [conversationMode, user?.intelligence_mode]);

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
    if (!token) return;
    let active = true;
    api.intelligenceConfig(token)
      .then((config) => {
        if (active) setIntelligenceConfig(config);
      })
      .catch(() => {
        if (active) setIntelligenceConfig(null);
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
    setOpenMenu(null);
    if (!canSend) return;
    const text = draft.trim();
    const submittedAttachments = imageAttachments;
    const files = submittedAttachments.map((attachment) => attachment.file);
    setDraft("");
    setImageAttachments([]);
    setSending(true);
    let accepted = false;
    try {
      const result = await onSend(
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
      accepted = result !== false;
      if (accepted) {
        submittedAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      } else {
        setDraft(text);
        setImageAttachments(submittedAttachments);
      }
    } catch (sendError) {
      setDraft(text);
      setImageAttachments(submittedAttachments);
      setError(sendError instanceof Error ? sendError.message : "Message was not sent.");
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

  function clearImageAttachments() {
    imageAttachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    imageAttachmentsRef.current = [];
    setImageAttachments([]);
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length) void addFiles(files);
    event.target.value = "";
  }

  function openDocumentPicker() {
    setOpenMenu(null);
    documentInputRef.current?.click();
  }

  function openImagePicker() {
    setOpenMenu(null);
    imageInputRef.current?.click();
  }

  function openCameraPicker() {
    setOpenMenu(null);
    cameraInputRef.current?.click();
  }

  const researchModeActive = chatMode !== "instant";

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
    const option = composerModeOption(value);
    setSearchMode(option.searchMode);
    setChatMode(option.chatMode);
    window.localStorage.setItem("autoai-intelligence-mode", option.value);
  }

  const selectedModeValue = composerModeValue(searchMode, chatMode);

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
      <div className={clsx("composer-card compact-card crystal-surface", crystalEffects.surfaces && "is-crystal-enabled", dragActive && "composer-card-active")}>
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

        <input ref={documentInputRef} className="hidden" type="file" multiple accept=".pdf,.docx,.txt" onChange={handleFileSelection} />
        <input ref={imageInputRef} className="hidden" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleFileSelection} />
        <input ref={cameraInputRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={handleFileSelection} />
        <div className="composer-top-row compact-toolbar">
          <div className="attachment-menu">
            <button
              ref={attachmentTriggerRef}
              aria-expanded={openMenu === "attachments"}
              aria-haspopup="dialog"
              aria-controls="composer-attachment-popover"
              aria-label="Add to chat"
              className={clsx("composer-plus-button", openMenu === "attachments" && "composer-plus-button-active")}
              type="button"
              onClick={() => setOpenMenu((current) => current === "attachments" ? null : "attachments")}
              title="Add attachment"
            >
              <Plus size={19} />
            </button>
            <ComposerPopover open={openMenu === "attachments"} triggerRef={attachmentTriggerRef} onClose={() => setOpenMenu(null)} ariaLabel="Add to chat" preferredWidth={240} maxWidth={320} className="composer-attachment-popover">
              <div id="composer-attachment-popover">
                <div className="composer-popover-header">Add to chat</div>
                <div className="composer-popover-list" role="menu">
                  <button className="composer-popover-option composer-attachment-option" type="button" role="menuitem" onClick={openCameraPicker}>
                    <Camera size={20} />
                    <span><strong>Camera</strong><small>Take a new photo</small></span>
                  </button>
                  <button className="composer-popover-option composer-attachment-option" type="button" role="menuitem" onClick={openImagePicker}>
                    <FileImage size={20} />
                    <span><strong>Photos</strong><small>Choose one or more images</small></span>
                  </button>
                  <button className="composer-popover-option composer-attachment-option" type="button" role="menuitem" onClick={openDocumentPicker}>
                    <FileText size={20} />
                    <span><strong>Documents</strong><small>PDF, DOCX or TXT</small></span>
                  </button>
                </div>
              </div>
            </ComposerPopover>
          </div>
          <ModeMenu value={selectedModeValue} config={intelligenceConfig} open={openMenu === "mode"} onToggle={() => setOpenMenu((current) => current === "mode" ? null : "mode")} onClose={() => setOpenMenu(null)} onSelect={updateCombinedMode} />
          <span className="composer-divider" />
          <ModelMenu provider={provider} model={model} open={openMenu === "model"} onToggle={() => setOpenMenu((current) => current === "model" ? null : "model")} onClose={() => setOpenMenu(null)} onSelect={selectModelProvider} />
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
                  open={openMenu === "research-model"}
                  onToggleMenu={() => setOpenMenu((current) => current === "research-model" ? null : "research-model")}
                  onClose={() => setOpenMenu(null)}
                  onToggle={toggleResearchModel}
                />
                <label className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2">
                  <Box size={13} />
                  <AppSelect label="Max research models" value={maxModels} disabled={allModels} onChange={(value) => setMaxModels(Number(value))} options={[1,2,3,4,5,6,7,8,9].map((value) => ({value:String(value),label:`Max ${value}`}))} />
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
                  <AppSelect label="Research timeout" value={timeoutSeconds} onChange={(value) => setTimeoutSeconds(Number(value))} options={[20,35,45,60].map((value) => ({value:String(value),label:`${value}s`}))} />
                </label>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="composer-input-row">
          <textarea
            ref={textareaRef}
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
              <VoiceButton onOpen={onOpenLiveMode} />
            )}
            {disabled && onStop ? (
              <button className="stop-button composer-send-round" type="button" onClick={onStop} title="Stop response">
                <Square size={16} />
              </button>
            ) : (
              <button className="send-button composer-send-round" disabled={!canSend} type="submit" title={uiText?.["chat.send"] || "Send message"}>
                <SendHorizonal size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
