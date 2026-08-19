import { type ChangeEvent, type ClipboardEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { Camera, Check, ChevronDown, Code2, FileImage, FileText, Plus, SendHorizonal, Sparkles, Square, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "../../motion/staticMotion";
import clsx from "clsx";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { ChatMode, DocumentItem, IntelligenceConfig, IntelligenceMode, LibraryAttachment } from "../../types";
import { useAppSettings } from "../../contexts/AppSettingsContext";
import { useCrystalEffects } from "../../crystal/useCrystalEffects";
import { VoiceButton } from "./VoiceButton";
import { usePublishedUiText } from "../../hooks/useCmsContent";
import { COMPOSER_MODE_OPTIONS, composerModeOption, composerModeValue } from "./composerSelection";
import { ComposerPopover } from "./ComposerPopover";
import { detectPreset } from "./PresetDetectionService";

export type ComposerOptions = {
  chatMode: ChatMode;
  presetMode: "auto" | "manual";
  presetSource: "auto" | "manual";
  selectedPreset: IntelligenceMode;
  detectedPreset: IntelligenceMode;
  manualPresetLocked: boolean;
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

const DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".docx", ".txt",
  ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".go", ".rs",
  ".css", ".html", ".json", ".md", ".yaml", ".yml", ".sql"
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
type ComposerOpenMenu = "attachments" | "mode" | null;

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
    auto: "Detect the best preset for every message",
    instant: "Fast single-model response",
    medium: "Balanced parallel intelligence",
    high: "Advanced multi-provider reasoning",
    deep_research: "Source-backed comprehensive research",
    coding: "Groq Qwen implements while Bedrock Qwen Coder reviews and corrects."
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
              aria-disabled={option.value !== "auto" && config?.modes[option.value]?.available === false}
              disabled={option.value !== "auto" && config?.modes[option.value]?.available === false}
              className={clsx("composer-popover-option", option.value === selected.value && "composer-popover-option-active")}
              onClick={() => {
                onSelect(option.value);
                onClose();
              }}
            >
              <span>
                {option.value === "coding" && <Code2 size={16} />}
                <strong>{option.label}</strong>
                <small>
                  {option.value !== "auto" && config?.modes[option.value]?.available === false
                    ? config.modes[option.value]?.unavailable_reason || "Temporarily unavailable"
                    : (option.value !== "auto" ? config?.modes[option.value]?.fallback_message : null) || descriptions[option.value] || "Choose this intelligence preset"}
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
  selectedLibraryAttachments,
  uploadTasks,
  onRemoveDocument,
  onRemoveLibraryAttachment,
  onDeleteDocument,
  onUploadDocuments,
  onSend,
  onStop,
  onOpenLiveMode,
  focusKey,
  initialDraft = "",
  conversationMode,
  conversationPresetMode,
  conversationSelectedPreset,
  conversationManualPresetLocked,
  onPresetChange
}: {
  disabled?: boolean;
  selectedDocuments: DocumentItem[];
  selectedLibraryAttachments: LibraryAttachment[];
  uploadTasks: UploadTask[];
  onRemoveDocument: (id: string) => void;
  onRemoveLibraryAttachment: (id: string) => void;
  onDeleteDocument: (id: string) => Promise<void>;
  onUploadDocuments: (files: File[]) => Promise<void>;
  onSend: (text: string, options: ComposerOptions, imageFiles: File[]) => Promise<void | boolean>;
  onStop?: () => Promise<void> | void;
  onOpenLiveMode: () => void;
  focusKey?: string;
  initialDraft?: string;
  conversationMode?: string;
  conversationPresetMode?: "auto" | "manual";
  conversationSelectedPreset?: string;
  conversationManualPresetLocked?: boolean;
  onPresetChange?: (selection: {
    presetMode: "auto" | "manual";
    selectedPreset: IntelligenceMode;
    manualPresetLocked: boolean;
  }) => Promise<void> | void;
}) {
  const uiText = usePublishedUiText();
  const { token } = useAuth();
  const { settings } = useAppSettings();
  const crystalEffects = useCrystalEffects();
  const attachmentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageAttachmentsRef = useRef<ImageAttachment[]>([]);
  const draftStorageKey = `autoai:chat-draft:${focusKey || "new"}`;
  const [draft, setDraft] = useState(() => {
    try { return window.localStorage.getItem(draftStorageKey) || ""; } catch { return ""; }
  });
  const [chatMode, setChatMode] = useState<ChatMode>("instant");
  const [presetMode, setPresetMode] = useState<"auto" | "manual">("auto");
  const [intelligenceConfig, setIntelligenceConfig] = useState<IntelligenceConfig | null>(null);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [openMenu, setOpenMenu] = useState<ComposerOpenMenu>(null);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [error, setError] = useState("");
  const [composerActive, setComposerActive] = useState(false);
  const appliedInitialDraftRef = useRef("");
  const loadedDraftKeyRef = useRef(draftStorageKey);

  const uploading = uploadTasks.some((task) => task.status === "uploading" || task.status === "processing");
  const hasAttachment = Boolean(selectedDocuments.length || imageAttachments.length || selectedLibraryAttachments.length);
  const canSend = Boolean(draft.trim() || hasAttachment) && !disabled && !sending && !uploading;

  useEffect(() => { imageAttachmentsRef.current = imageAttachments; }, [imageAttachments]);
  useEffect(() => { textareaRef.current?.focus({ preventScroll: true }); }, [focusKey]);
  useEffect(() => {
    if (loadedDraftKeyRef.current === draftStorageKey) return;
    loadedDraftKeyRef.current = draftStorageKey;
    try { setDraft(window.localStorage.getItem(draftStorageKey) || ""); } catch { setDraft(""); }
  }, [draftStorageKey]);
  useEffect(() => {
    if (loadedDraftKeyRef.current !== draftStorageKey) return;
    try {
      if (draft) window.localStorage.setItem(draftStorageKey, draft);
      else window.localStorage.removeItem(draftStorageKey);
    } catch { /* Draft persistence is best-effort in restricted WebViews. */ }
  }, [draft, draftStorageKey]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(180, Math.max(48, textarea.scrollHeight))}px`;
  }, [draft]);
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
    const preferred = conversationSelectedPreset || conversationMode || "instant";
    const option = composerModeOption(preferred);
    setChatMode(option.chatMode);
    setPresetMode(conversationPresetMode === "manual" || conversationManualPresetLocked ? "manual" : "auto");
  }, [focusKey, conversationMode, conversationPresetMode, conversationSelectedPreset, conversationManualPresetLocked]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    api.intelligenceConfig(token)
      .then((config) => { if (active) setIntelligenceConfig(config); })
      .catch(() => { if (active) setIntelligenceConfig(null); });
    return () => { active = false; };
  }, [token]);
  useEffect(() => () => {
    imageAttachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  }, []);

  async function addFiles(files: File[]) {
    setError("");
    setComposerActive(true);
    const documentFiles: File[] = [];
    const imageFiles: ImageAttachment[] = [];
    const unsupported: string[] = [];
    files.forEach((file, index) => {
      if (isDocument(file)) { documentFiles.push(file); return; }
      if (isImage(file)) {
        const filename = file.name || `pasted-image-${Date.now()}-${index}.png`;
        const normalizedFile = file.name ? file : new File([file], filename, { type: file.type || "image/png", lastModified: Date.now() });
        imageFiles.push({ id: crypto.randomUUID(), file: normalizedFile, previewUrl: URL.createObjectURL(normalizedFile) });
        return;
      }
      unsupported.push(file.name || "Unnamed file");
    });
    if (imageFiles.length) {
      setImageAttachments((current) => {
        const next = [...current, ...imageFiles];
        const overflow = next.slice(0, Math.max(0, next.length - 6));
        overflow.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        return next.slice(-6);
      });
    }
    if (documentFiles.length) await onUploadDocuments(documentFiles);
    if (unsupported.length) setError(`Unsupported file: ${unsupported.join(", ")}`);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files ?? []);
    if (!clipboardFiles.length) return;
    const supportedFiles = clipboardFiles.filter((file) => isImage(file) || isDocument(file));
    if (!supportedFiles.length) return;
    event.preventDefault();
    void addFiles(supportedFiles);
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
      if (files.length) {
        if (!token) throw new Error("Sign in again to save image attachments.");
        await Promise.all(files.map((file) => api.uploadLibraryAsset(token, file, "chat_attachment")));
      }
      const detectedPreset = detectPreset(text, Boolean(files.length || selectedDocuments.length || selectedLibraryAttachments.length));
      const selectedPreset = presetMode === "auto" ? detectedPreset : composerModeOption(chatMode).chatMode as IntelligenceMode;
      const result = await onSend(text, {
        chatMode: selectedPreset,
        presetMode,
        presetSource: presetMode,
        selectedPreset,
        detectedPreset,
        manualPresetLocked: presetMode === "manual"
      }, files);
      accepted = result !== false;
      if (accepted) {
        submittedAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        setComposerActive(false);
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
  function openDocumentPicker() { setOpenMenu(null); setComposerActive(true); documentInputRef.current?.click(); }
  function openImagePicker() { setOpenMenu(null); setComposerActive(true); imageInputRef.current?.click(); }
  function openCameraPicker() { setOpenMenu(null); setComposerActive(true); cameraInputRef.current?.click(); }
  function updateCombinedMode(value: string) {
    const option = composerModeOption(value);
    setChatMode(option.chatMode);
    const nextPresetMode = value === "auto" ? "auto" : "manual";
    setPresetMode(nextPresetMode);
    setComposerActive(true);
    setOpenMenu(null);
    void onPresetChange?.({ presetMode: nextPresetMode, selectedPreset: option.chatMode as IntelligenceMode, manualPresetLocked: nextPresetMode === "manual" });
  }
  const selectedModeValue = presetMode === "auto" ? "auto" : composerModeValue("auto", chatMode);

  return (
    <form
      className={clsx("composer-shell", composerActive && "composer-shell-active")}
      onSubmit={submit}
      onDragEnter={(event) => { event.preventDefault(); setDragActive(true); setComposerActive(true); }}
      onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
      onDragLeave={(event) => { event.preventDefault(); if (event.currentTarget === event.target) setDragActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDragActive(false); setComposerActive(true); void addFiles(Array.from(event.dataTransfer.files)); }}
    >
      <div className={clsx("composer-card compact-card crystal-surface", crystalEffects.surfaces && "is-crystal-enabled", dragActive && "composer-card-active")}>
        <AnimatePresence>
          {(selectedDocuments.length > 0 || selectedLibraryAttachments.length > 0 || uploadTasks.length > 0 || imageAttachments.length > 0 || error) && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-2 overflow-hidden composer-attachments-area">
              {error && <div className="composer-error" role="alert">{error}</div>}
              <div className="flex flex-wrap gap-2">
                {selectedDocuments.map((document) => (
                  <span key={document.id} className="attachment-chip"><FileText size={14} /><span className="max-w-40 truncate">{document.filename}</span><button type="button" onClick={() => onRemoveDocument(document.id)} title="Remove document"><X size={13} /></button><button type="button" onClick={() => onDeleteDocument(document.id)} title="Delete document"><Trash2 size={13} /></button></span>
                ))}
                {selectedLibraryAttachments.map((attachment) => (
                  <span key={attachment.asset_id} className="attachment-chip">{attachment.type === "image" ? <FileImage size={14} /> : <FileText size={14} />}<span className="max-w-40 truncate">{attachment.filename}</span><button type="button" onClick={() => onRemoveLibraryAttachment(attachment.asset_id)} title="Remove library attachment"><X size={13} /></button></span>
                ))}
                {imageAttachments.map((attachment) => (
                  <span key={attachment.id} className="image-chip"><img src={attachment.previewUrl} alt={`Attached image preview: ${attachment.file.name}`} loading="lazy" decoding="async" /><span className="max-w-32 truncate">{attachment.file.name}</span><button type="button" onClick={() => removeImage(attachment.id)} title="Remove image"><X size={13} /></button></span>
                ))}
              </div>
              {uploadTasks.map((task) => (
                <div key={task.id} className="upload-progress"><div className="mb-1 flex items-center justify-between gap-2 text-xs"><span className="truncate text-slate-200">{task.filename}</span><span className={task.status === "error" ? "text-red-200" : "text-cyan-100"}>{task.status === "error" ? "Failed" : `${task.progress}%`}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/10"><span className={clsx("block h-full rounded-full", task.status === "error" ? "bg-red-400" : "bg-cyan-300")} style={{ width: `${Math.max(task.progress, task.status === "processing" ? 92 : 4)}%` }} /></div>{task.error && <p className="mt-1 text-xs text-red-200">{task.error}</p>}</div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <input ref={documentInputRef} className="hidden" type="file" multiple accept=".pdf,.docx,.txt,.py,.ts,.tsx,.js,.jsx,.java,.kt,.go,.rs,.css,.html,.json,.md,.yaml,.yml,.sql" onChange={handleFileSelection} />
        <input ref={imageInputRef} className="hidden" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleFileSelection} />
        <input ref={cameraInputRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={handleFileSelection} />
        <div className="composer-top-row compact-toolbar">
          <div className="attachment-menu"><button ref={attachmentTriggerRef} aria-expanded={openMenu === "attachments"} aria-haspopup="dialog" aria-controls="composer-attachment-popover" aria-label="Add to chat" className={clsx("composer-plus-button", openMenu === "attachments" && "composer-plus-button-active")} type="button" onClick={() => setOpenMenu((current) => current === "attachments" ? null : "attachments")} title="Add attachment"><Plus size={19} /></button><ComposerPopover open={openMenu === "attachments"} triggerRef={attachmentTriggerRef} onClose={() => setOpenMenu(null)} ariaLabel="Add to chat" preferredWidth={240} maxWidth={320} className="composer-attachment-popover"><div id="composer-attachment-popover"><div className="composer-popover-header">Add to chat</div><div className="composer-popover-list" role="menu"><button className="composer-popover-option composer-attachment-option" type="button" role="menuitem" onClick={openCameraPicker}><Camera size={20} /><span><strong>Camera</strong><small>Take a new photo</small></span></button><button className="composer-popover-option composer-attachment-option" type="button" role="menuitem" onClick={openImagePicker}><FileImage size={20} /><span><strong>Photos</strong><small>Choose one or more images</small></span></button><button className="composer-popover-option composer-attachment-option" type="button" role="menuitem" onClick={openDocumentPicker}><FileText size={20} /><span><strong>Documents & code</strong><small>PDF, DOCX, TXT or source code</small></span></button></div></div></ComposerPopover></div>
          <ModeMenu value={selectedModeValue} config={intelligenceConfig} open={openMenu === "mode"} onToggle={() => { setComposerActive(true); setOpenMenu((current) => current === "mode" ? null : "mode"); }} onClose={() => setOpenMenu(null)} onSelect={updateCombinedMode} />
          <span className="preset-source-indicator">{presetMode === "auto" ? "Auto detected" : "Manual"}</span>
        </div>
        <div className="composer-input-row">
          <textarea ref={textareaRef} className="composer-textarea" placeholder={selectedDocuments.length ? `Ask about ${selectedDocuments.length} selected document${selectedDocuments.length > 1 ? "s" : ""}` : "Ask anything..."} rows={1} aria-label="Message AutoAI" value={draft} onFocus={() => setComposerActive(true)} onChange={(event) => { setComposerActive(true); setDraft(event.target.value); }} onPaste={handlePaste} onKeyDown={(event) => { if (event.key === "Escape") { setOpenMenu(null); setComposerActive(false); textareaRef.current?.blur(); return; } if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
          <div className="composer-inline-actions">{settings.voiceEnabled && <VoiceButton onOpen={onOpenLiveMode} />}{disabled && onStop ? <button className="stop-button composer-send-round" type="button" onClick={onStop} title="Stop response" aria-label="Stop generation"><Square size={16} /></button> : <button className="send-button composer-send-round" disabled={!canSend} type="submit" title={uiText?.["chat.send"] || "Send message"} aria-label={uiText?.["chat.send"] || "Send message"}><SendHorizonal size={18} /></button>}</div>
        </div>
      </div>
      <p className="composer-disclaimer">AutoAI can make mistakes. Verify important information.</p>
    </form>
  );
}
