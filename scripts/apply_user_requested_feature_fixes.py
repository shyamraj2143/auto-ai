from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGED: list[str] = []


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    current = target.read_text(encoding="utf-8") if target.exists() else None
    if current == content:
        return
    target.write_text(content, encoding="utf-8")
    CHANGED.append(path)


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


def patch_app_settings() -> None:
    path = "frontend/src/contexts/AppSettingsContext.tsx"
    replace_once(
        path,
        'export type AppLanguage = "system" | "en" | "hi" | "hinglish";\n',
        'export type AppLanguage = "system" | "en" | "hi" | "hinglish";\n'
        'export type ResponseLanguage = "auto" | "en" | "hi";\n',
    )
    replace_once(
        path,
        '  language: AppLanguage;\n  visualEffectsLevel: CrystalEffectsLevel;\n',
        '  language: AppLanguage;\n  responseLanguage: ResponseLanguage;\n  visualEffectsLevel: CrystalEffectsLevel;\n',
    )
    replace_once(
        path,
        '  setLanguage: (language: AppLanguage) => void;\n  setVisualEffectsLevel: (level: CrystalEffectsLevel) => void;\n',
        '  setLanguage: (language: AppLanguage) => void;\n'
        '  setResponseLanguage: (language: ResponseLanguage) => void;\n'
        '  setVisualEffectsLevel: (level: CrystalEffectsLevel) => void;\n',
    )
    replace_once(
        path,
        '  language: "system",\n  visualEffectsLevel: "reduced",\n',
        '  language: "system",\n  responseLanguage: "auto",\n  visualEffectsLevel: "reduced",\n',
    )
    replace_once(
        path,
        'const LANGUAGE_VALUES = new Set<AppLanguage>(["system", "en", "hi", "hinglish"]);\n',
        'const LANGUAGE_VALUES = new Set<AppLanguage>(["system", "en", "hi", "hinglish"]);\n'
        'const RESPONSE_LANGUAGE_VALUES = new Set<ResponseLanguage>(["auto", "en", "hi"]);\n',
    )
    replace_once(
        path,
        '    language: raw.language && LANGUAGE_VALUES.has(raw.language) ? raw.language : DEFAULT_SETTINGS.language,\n'
        '    visualEffectsLevel:',
        '    language: raw.language && LANGUAGE_VALUES.has(raw.language) ? raw.language : DEFAULT_SETTINGS.language,\n'
        '    responseLanguage: raw.responseLanguage && RESPONSE_LANGUAGE_VALUES.has(raw.responseLanguage)\n'
        '      ? raw.responseLanguage\n'
        '      : DEFAULT_SETTINGS.responseLanguage,\n'
        '    visualEffectsLevel:',
    )
    replace_once(
        path,
        '      setLanguage: (language) => {\n'
        '        updateSettings((current) => ({ ...current, language }));\n'
        '      },\n'
        '      setVisualEffectsLevel:',
        '      setLanguage: (language) => {\n'
        '        updateSettings((current) => ({ ...current, language }));\n'
        '      },\n'
        '      setResponseLanguage: (responseLanguage) => {\n'
        '        updateSettings((current) => ({ ...current, responseLanguage }));\n'
        '      },\n'
        '      setVisualEffectsLevel:',
    )


def patch_chat_page() -> None:
    path = "frontend/src/components/chat/ChatPage.tsx"
    replace_once(
        path,
        'import { ArrowDown, Brain, Library, Menu, MessageSquarePlus, MoreHorizontal, Search, Settings, Sparkles, Square, Trash2, Pencil, Eraser } from "lucide-react";\n',
        'import { ArrowDown, Brain, Languages, Library, Menu, MessageSquarePlus, MoreHorizontal, Search, Settings, Sparkles, Square, Trash2, Pencil, Eraser } from "lucide-react";\n',
    )
    replace_once(
        path,
        '  const { settings } = useAppSettings();\n',
        '  const { settings, setResponseLanguage } = useAppSettings();\n',
    )
    replace_once(
        path,
        '  const visibleGeneration = activeGeneration?.chat_id === activeChat?.id ? activeGeneration : null;\n',
        '  const activeVisibleChatId = activeChat?.id ?? activeRequestRef.current?.chatId ?? chatId ?? null;\n'
        '  const visibleGeneration = activeGeneration?.chat_id === activeVisibleChatId ? activeGeneration : null;\n',
    )
    replace_once(
        path,
        '        const result = await api.analyzeImage(\n'
        '          token,\n'
        '          file,\n'
        '          text || "Analyze this image in detail and extract useful context for the next answer."\n'
        '        );\n',
        '        const analysisPrompt = [\n'
        '          "Inspect this image as a high-quality multimodal assistant.",\n'
        '          text.trim() ? `The user request is: ${text.trim()}` : "The user did not add a separate question, so provide a useful complete analysis.",\n'
        '          "Identify the image type and main subject, describe the scene and layout, list important objects and visual details, and explain what matters for the user request.",\n'
        '          "Transcribe every readable word, number, label, table entry, code fragment, warning, and UI message accurately. Preserve order and structure where possible.",\n'
        '          "For screenshots, explain the interface state, visible errors, likely cause, and practical next steps. For documents or diagrams, summarize sections and key facts.",\n'
        '          "Do not identify real people. Do not invent unclear details; explicitly mark uncertainty."\n'
        '        ].join("\\n");\n'
        '        const result = await api.analyzeImage(token, file, analysisPrompt);\n',
    )
    replace_once(
        path,
        '      user_locale: navigator.language || "en"\n',
        '      user_locale: `autoai-response-${settings.responseLanguage}`\n',
    )
    replace_once(
        path,
        '        const pendingMessages = optimisticMessages(request, assistantId);\n'
        '        setMessages((current) => appendOptimisticMessages(current, pendingMessages));\n'
        '        const chatWithLocalMessages = {\n'
        '          ...chat,\n'
        '          messages: mergeChatMessages(chat.messages ?? [], messagesRef.current.some((message) => message.id === assistantId) ? messagesRef.current : pendingMessages)\n'
        '        };\n',
        '        const pendingMessages = optimisticMessages(request, assistantId);\n'
        '        const nextMessages = appendOptimisticMessages(messagesRef.current, pendingMessages);\n'
        '        messagesRef.current = nextMessages;\n'
        '        setMessages(nextMessages);\n'
        '        const chatWithLocalMessages = {\n'
        '          ...chat,\n'
        '          messages: mergeChatMessages(chat.messages ?? [], nextMessages)\n'
        '        };\n',
    )
    replace_once(
        path,
        '    if (activeChat?.id) {\n'
        '      updateMessagesForChat(activeChat.id, (current) => appendOptimisticMessages(current, pendingMessages), true);\n'
        '    } else {\n'
        '      setMessages((current) => appendOptimisticMessages(current, pendingMessages));\n'
        '    }\n',
        '    const nextLocalMessages = appendOptimisticMessages(messagesRef.current, pendingMessages);\n'
        '    messagesRef.current = nextLocalMessages;\n'
        '    setMessages(nextLocalMessages);\n'
        '    if (activeChat?.id) syncActiveChatMessages(activeChat.id, nextLocalMessages);\n',
    )
    replace_once(
        path,
        '            <button role="menuitem" type="button" onClick={() => { setChatMenuOpen(false); setLibraryOpen(true); }}><Library size={15} />Library</button>\n'
        '            <button className="is-danger" role="menuitem" type="button" onClick={deleteCurrentChat} disabled={!activeChat}><Trash2 size={15} />Delete conversation</button>\n',
        '            <button role="menuitem" type="button" onClick={() => { setChatMenuOpen(false); setLibraryOpen(true); }}><Library size={15} />Library</button>\n'
        '            <div className="chat-language-section" role="group" aria-label="Response language">\n'
        '              <div className="chat-language-heading"><Languages size={15} /><span><strong>Response language</strong><small>Choose how AutoAI replies</small></span></div>\n'
        '              <div className="chat-language-options">\n'
        '                <button type="button" className={settings.responseLanguage === "auto" ? "is-active" : ""} aria-pressed={settings.responseLanguage === "auto"} onClick={() => { setResponseLanguage("auto"); setChatMenuOpen(false); }}>Automatic</button>\n'
        '                <button type="button" className={settings.responseLanguage === "en" ? "is-active" : ""} aria-pressed={settings.responseLanguage === "en"} onClick={() => { setResponseLanguage("en"); setChatMenuOpen(false); }}>English</button>\n'
        '                <button type="button" className={settings.responseLanguage === "hi" ? "is-active" : ""} aria-pressed={settings.responseLanguage === "hi"} onClick={() => { setResponseLanguage("hi"); setChatMenuOpen(false); }}>हिन्दी</button>\n'
        '              </div>\n'
        '            </div>\n'
        '            <button className="is-danger" role="menuitem" type="button" onClick={deleteCurrentChat} disabled={!activeChat}><Trash2 size={15} />Delete conversation</button>\n',
    )


def patch_live_context() -> None:
    path = "backend/app/services/live_context.py"
    replace_once(
        path,
        'TIME_QUERY_PATTERN = re.compile(\n'
        '    r"\\b(date|time|datetime|clock)\\b|तारीख|समय|टाइम|कितने बजे",\n'
        '    re.IGNORECASE,\n'
        ')\n\n\n',
        'TIME_QUERY_PATTERN = re.compile(\n'
        '    r"\\b(date|time|datetime|clock)\\b|तारीख|समय|टाइम|कितने बजे",\n'
        '    re.IGNORECASE,\n'
        ')\n'
        'RESPONSE_LANGUAGE_PREFIX = "autoai-response-"\n\n\n'
        'def response_language_instruction(locale: str) -> str:\n'
        '    if not locale.startswith(RESPONSE_LANGUAGE_PREFIX):\n'
        '        return ""\n'
        '    preference = locale.removeprefix(RESPONSE_LANGUAGE_PREFIX)\n'
        '    if preference == "en":\n'
        '        return "Always answer in clear English. Keep code, commands, filenames, and technical identifiers unchanged."\n'
        '    if preference == "hi":\n'
        '        return "Always answer in clear Hindi using Devanagari script. Keep code, commands, filenames, and technical identifiers unchanged."\n'
        '    return (\n'
        '        "Match the language and script of the user\'s latest message. If the message mixes languages, "\n'
        '        "use the dominant language while keeping code and technical identifiers unchanged."\n'
        '    )\n\n\n',
    )
    replace_once(
        path,
        '    def system_prompt(self) -> str:\n'
        '        return (\n'
        '            "Authoritative per-request time context (server clock; never guess or replace it):\\n"\n'
        '            f"request_started_at_utc={self.started_at_utc.isoformat()}\\n"\n'
        '            f"request_started_at_epoch_ms={int(self.started_at_utc.timestamp() * 1000)}\\n"\n'
        '            f"user_timezone={self.timezone_name}\\n"\n'
        '            f"user_locale={self.locale}\\n"\n'
        '            f"user_local_datetime={self.local_datetime.isoformat()}\\n"\n'
        '            f"request_id={self.request_id}"\n'
        '        )\n',
        '    def system_prompt(self) -> str:\n'
        '        prompt = (\n'
        '            "Authoritative per-request time context (server clock; never guess or replace it):\\n"\n'
        '            f"request_started_at_utc={self.started_at_utc.isoformat()}\\n"\n'
        '            f"request_started_at_epoch_ms={int(self.started_at_utc.timestamp() * 1000)}\\n"\n'
        '            f"user_timezone={self.timezone_name}\\n"\n'
        '            f"user_locale={self.locale}\\n"\n'
        '            f"user_local_datetime={self.local_datetime.isoformat()}\\n"\n'
        '            f"request_id={self.request_id}"\n'
        '        )\n'
        '        language_instruction = response_language_instruction(self.locale)\n'
        '        return f"{prompt}\\n\\nResponse language instruction: {language_instruction}" if language_instruction else prompt\n',
    )


def patch_ai_attachment_prompts() -> None:
    path = "backend/app/api/routes/ai.py"
    replace_once(
        path,
        '                    "Use the following uploaded document context when it is relevant. "\n'
        '                    "If the answer is not in the documents, say so clearly.\\n\\n"\n',
        '                    "The user uploaded document or code content for this turn. Analyze it like a strong document assistant: "\n'
        '                    "answer the request directly, identify the file structure, extract important facts, explain relevant sections, "\n'
        '                    "preserve exact code and values, and mention uncertainty or missing content. If the answer is not in the files, say so clearly.\\n\\n"\n',
    )
    replace_once(
        path,
        '                    "Describe this image accurately for use as context in an AI chat. Include visible text.",\n',
        '                    "Analyze this image comprehensively for an AI chat. Identify the image or screenshot type, describe the full scene and layout, list important objects and UI elements, transcribe every readable word and number accurately, explain visible errors or warnings, and connect the findings to likely user questions. Do not invent unclear details.",\n',
    )
    replace_once(
        path,
        '                    "Hidden attachment context for this turn. Use it only to answer the user. "\n'
        '                    "Do not reveal, quote, or say that this hidden context was extracted.\\n\\n"\n',
        '                    "The user attached images, files, documents, or code for this turn. Use the extracted context as source material and respond like a high-quality multimodal assistant. "\n'
        '                    "Start with the direct answer, then provide a useful structured analysis: identify the content, summarize it, extract exact visible text or values, explain relevant details, and give practical next steps when applicable. "\n'
        '                    "For screenshots, explain the visible UI state and errors. For code, preserve syntax and review correctness and security. Never invent missing details. "\n'
        '                    "Do not reveal internal extraction notes or claim that hidden context was shown to you.\\n\\n"\n',
    )
    replace_once(
        path,
        '    return "Analyze the attached content." if hidden_attachment_context else "Continue."\n',
        '    return "Analyze the attached content comprehensively and explain all important details." if hidden_attachment_context else "Continue."\n',
    )


def patch_settings_page() -> None:
    path = "frontend/src/components/settings/SettingsPage.tsx"
    replace_once(
        path,
        '  RotateCcw,\n  type LucideIcon\n',
        '  RotateCcw,\n  Info,\n  X,\n  type LucideIcon\n',
    )
    replace_once(
        path,
        'const APP_VERSION = "1.0.3";\n',
        'const APP_VERSION = import.meta.env.VITE_APP_VERSION || "1.0.3";\n',
    )
    replace_once(
        path,
        '  const [memoryNotice, setMemoryNotice] = useState("");\n',
        '  const [memoryNotice, setMemoryNotice] = useState("");\n'
        '  const [versionDetailsOpen, setVersionDetailsOpen] = useState(false);\n',
    )
    replace_once(
        path,
        '            <SettingsRow icon={Monitor} title="App Version" description="Installed frontend build">\n'
        '              <span className="text-[11px] font-semibold text-slate-300">v{APP_VERSION}</span>\n'
        '            </SettingsRow>\n',
        '            <SettingsRow icon={Monitor} title="App Version" description="Tap to view AutoAI project and feature details" onClick={() => setVersionDetailsOpen(true)}>\n'
        '              <span className="text-[11px] font-semibold text-slate-300">v{APP_VERSION}</span>\n'
        '            </SettingsRow>\n',
    )
    replace_once(
        path,
        '        <div className="settings-reference-content">\n'
        '          {section === "main" && renderMainSettings()}\n'
        '          {section === "general" && renderGeneralSettings()}\n'
        '          {section === "ai" && renderAiSettings()}\n'
        '          {section === "screen-share" && renderScreenShareSettings()}\n'
        '          {section === "visual" && renderVisualEffectsSettings()}\n'
        '          {section === "subscription" && <SubscriptionBillingCenter />}\n'
        '          {section === "privacy" && renderPrivacySettings()}\n'
        '          {section === "calls" && <CallSettings />}\n'
        '          {section === "chat" && renderChatSettings()}\n'
        '        </div>\n'
        '      </div>\n'
        '    </div>\n',
        '        <div className="settings-reference-content">\n'
        '          {section === "main" && renderMainSettings()}\n'
        '          {section === "general" && renderGeneralSettings()}\n'
        '          {section === "ai" && renderAiSettings()}\n'
        '          {section === "screen-share" && renderScreenShareSettings()}\n'
        '          {section === "visual" && renderVisualEffectsSettings()}\n'
        '          {section === "subscription" && <SubscriptionBillingCenter />}\n'
        '          {section === "privacy" && renderPrivacySettings()}\n'
        '          {section === "calls" && <CallSettings />}\n'
        '          {section === "chat" && renderChatSettings()}\n'
        '        </div>\n'
        '      </div>\n'
        '      {versionDetailsOpen && (\n'
        '        <div className="version-details-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setVersionDetailsOpen(false)}>\n'
        '          <section className="version-details-dialog" role="dialog" aria-modal="true" aria-label="AutoAI app details">\n'
        '            <header><span><Info size={18} /><strong>AutoAI v{APP_VERSION}</strong></span><button type="button" onClick={() => setVersionDetailsOpen(false)} aria-label="Close app details"><X size={18} /></button></header>\n'
        '            <p>AutoAI is a multi-workspace AI platform for intelligent chat, reusable attachment analysis, secure screen sharing, calls, and user messaging.</p>\n'
        '            <div className="version-details-grid">\n'
        '              <article><strong>AI Chat</strong><small>Automatic intelligence presets, Coding, Deep Research, response streaming, voice, memory, files, images and personal Library.</small></article>\n'
        '              <article><strong>Attachment intelligence</strong><small>Photos, selfies, screenshots, documents and code are analyzed and saved automatically in each user\'s Library.</small></article>\n'
        '              <article><strong>Screen Sharing</strong><small>Secure share codes, mobile and desktop viewing, pause/resume and movable live controls.</small></article>\n'
        '              <article><strong>Communication</strong><small>User messages, audio/video calls, profiles, contacts, notifications and privacy controls.</small></article>\n'
        '              <article><strong>Account & billing</strong><small>Subscriptions, token usage, promo codes, payment history, receipts and app updates.</small></article>\n'
        '              <article><strong>Privacy</strong><small>Account-scoped chats, files, memories and Library items with user-controlled deletion and settings.</small></article>\n'
        '            </div>\n'
        '          </section>\n'
        '        </div>\n'
        '      )}\n'
        '    </div>\n',
    )


def patch_screen_share_provider() -> None:
    path = "frontend/src/features/screenShare/ScreenShareProvider.tsx"
    replace_once(
        path,
        '  const generateShareCode = useCallback(async () => {\n'
        '    if (!inviteOnlyRequest && !requestPeer) return;\n'
        '    if (!canShareScreen) {\n',
        '  const generateShareCode = useCallback(async () => {\n'
        '    if (!canShareScreen) {\n',
    )


def patch_screen_share_workspace() -> None:
    path = "frontend/src/features/screenShare/ScreenShareWorkspacePage.tsx"
    replace_once(
        path,
        '  const [code, setCode] = useState("");\n',
        '  const [code, setCode] = useState("");\n  const [starting, setStarting] = useState(false);\n',
    )
    replace_once(
        path,
        '  async function join() {\n'
        '    const normalized = code.trim();\n'
        '    if (!normalized) return;\n'
        '    await screenShare.joinWithCode(normalized);\n'
        '  }\n\n',
        '  async function join() {\n'
        '    const normalized = code.trim();\n'
        '    if (!normalized) return;\n'
        '    await screenShare.joinWithCode(normalized);\n'
        '  }\n\n'
        '  async function startSharing() {\n'
        '    if (starting || active) return;\n'
        '    setStarting(true);\n'
        '    try {\n'
        '      await screenShare.generateShareCode();\n'
        '    } finally {\n'
        '      setStarting(false);\n'
        '    }\n'
        '  }\n\n',
    )
    replace_once(
        path,
        '            <button type="button" onClick={screenShare.requestInviteShare}><MonitorUp size={18} /> Share my screen</button>\n',
        '            <button type="button" onClick={() => void startSharing()} disabled={starting || active}><MonitorUp size={18} /> {starting ? "Starting..." : "Share my screen"}</button>\n',
    )


def patch_screen_share_overlay() -> None:
    path = "frontend/src/features/screenShare/ScreenShareOverlay.tsx"
    replace_once(
        path,
        'import { ChevronDown, ChevronUp, Clipboard, GripHorizontal, Hash, LogIn, Monitor, Mic, MicOff, Pause, Play, ScreenShare, Square, Users, X } from "lucide-react";\n',
        'import { GripHorizontal, Hash, LogIn, Monitor, Pause, Play, ScreenShare, Square, X } from "lucide-react";\n',
    )
    replace_once(path, 'import { AppSelect } from "../../components/common/AppSelect";\n', '')
    replace_once(path, 'import type { ScreenShareQualityMode } from "./types";\n', '')
    old_duration = '''function formatDuration(startedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "00:00";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

'''
    replace_once(path, old_duration, '')
    replace_once(
        path,
        '  const duration = formatDuration(share.startedAt);\n'
        '  const inviteAvatar = resolveApiAssetUrl(share.pendingInvite?.sharer.avatar_url);\n'
        '  const active = share.uiState !== "idle" && share.uiState !== "ended";\n'
        '  const [code, setCode] = useState("");\n'
        '  const [busy, setBusy] = useState(false);\n'
        '  const [dockCollapsed, setDockCollapsed] = useState(false);\n'
        '  const [codeExpanded, setCodeExpanded] = useState(false);\n'
        '  const collapseTimerRef = useRef<number>(0);\n'
        '  const dock = useFloatingPanel({ storageKey: "autoai.screen-share.dock.anchor", defaultAnchor: "bottom-center", bottomInset: 18 });\n\n'
        '  function keepDockOpen() {\n'
        '    window.clearTimeout(collapseTimerRef.current);\n'
        '    if (dockCollapsed) setDockCollapsed(false);\n'
        '    collapseTimerRef.current = window.setTimeout(() => setDockCollapsed(true), 6000);\n'
        '  }\n\n'
        '  useEffect(() => {\n'
        '    if (!active || share.role !== "sharer") return;\n'
        '    keepDockOpen();\n'
        '    return () => window.clearTimeout(collapseTimerRef.current);\n'
        '  }, [active, share.role]);\n',
        '  const inviteAvatar = resolveApiAssetUrl(share.pendingInvite?.sharer.avatar_url);\n'
        '  const active = share.uiState !== "idle" && share.uiState !== "ended";\n'
        '  const [code, setCode] = useState("");\n'
        '  const [busy, setBusy] = useState(false);\n'
        '  const dock = useFloatingPanel({ storageKey: "autoai.screen-share.dock.anchor", defaultAnchor: "bottom-center", bottomInset: 18 });\n',
    )
    old_dock = '''      {active && share.role === "sharer" && (
        <div
          ref={dock.ref}
          className={`ss-control-bar ss-floating-dock ${dockCollapsed ? "ss-dock-collapsed" : "ss-dock-expanded"}`}
          style={dock.style}
          role="toolbar"
          aria-label="Screen sharing controls"
          tabIndex={0}
          onPointerDown={dock.onPointerDown}
          onPointerMove={dock.onPointerMove}
          onPointerUp={dock.onPointerUp}
          onPointerCancel={dock.onPointerCancel}
          onKeyDown={dock.onKeyDown}
          onPointerEnter={keepDockOpen}
          onFocus={keepDockOpen}
        >
          <AudioSurface stream={share.remoteStream} />
          <button type="button" className="ss-drag-handle" aria-label="Move screen share controls" title="Drag controls"><GripHorizontal size={17} /></button>
          <span className="ss-live-summary"><ScreenShare size={17} /><strong>Live</strong><time>{duration}</time></span>
          <button type="button" className="ss-dock-toggle" onClick={() => setDockCollapsed((value) => !value)} aria-label={dockCollapsed ? "Expand controls" : "Minimize controls"}>{dockCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button>
          <div className="ss-dock-expanded-content">
          {share.uiState === "reconnecting" && <small>Reconnecting...</small>}
          {share.uiState === "waiting" && <small>Waiting for viewer</small>}
          <small className={`ss-network ss-network-${share.networkQuality}`}>{share.networkQuality === "poor" ? "Poor network" : share.networkQuality === "good" ? "Network good" : share.networkQuality}</small>
          {share.sentResolution && <small>{share.sentResolution}</small>}
          <small className="ss-viewer-count"><Users size={13} />{share.session?.viewer_user_id || share.session?.viewerUserId ? 1 : 0}</small>
          <AppSelect value={share.qualityMode} onChange={(value) => share.setQualityMode(value as ScreenShareQualityMode)} label="Screen share quality" options={[{value:"auto",label:"Auto"},{value:"data-saver",label:"Data Saver"},{value:"sharp-text",label:"Sharp Text"},{value:"smooth-motion",label:"Smooth Motion"},{value:"hd",label:"HD"}]} />
          {share.shareCode && <div className="ss-code-chip-wrap"><button type="button" className="ss-code-pill" onClick={() => setCodeExpanded((value) => !value)} aria-expanded={codeExpanded} aria-label="Show screen share code"><Hash size={15} /><span>{codeExpanded ? share.shareCode : `${share.shareCode.slice(0, 3)}•••`}</span></button>{codeExpanded && <div className="ss-code-popover"><strong>{share.shareCode}</strong><button type="button" onClick={() => void share.copyShareCode()}><Clipboard size={14} /> Copy</button><button type="button" onClick={() => void share.copyInviteLink()}>Share link</button></div>}</div>}
          <button type="button" onClick={() => void share.toggleMute()} aria-label={share.muted ? "Turn on mic" : "Mute mic"}>{share.muted ? <MicOff size={17} /> : <Mic size={17} />}</button>
          <button type="button" onClick={share.togglePause} aria-label={share.paused ? "Resume share" : "Pause share"}>{share.paused ? <Play size={17} /> : <Pause size={17} />}</button>
          <button type="button" onClick={() => void (share.shareCode ? share.copyShareCode() : share.copyInviteLink())} aria-label={share.shareCode ? "Copy code" : "Copy invite link"}><Clipboard size={17} /></button>
          <button type="button" className="stop" onClick={() => void share.stopShare()}><Square size={16} /> Stop Sharing</button>
          </div>
        </div>
      )}
'''
    new_dock = '''      {active && share.role === "sharer" && (
        <div
          ref={dock.ref}
          className="ss-control-bar ss-floating-dock ss-dock-compact"
          style={dock.style}
          role="toolbar"
          aria-label="Screen sharing controls"
          tabIndex={0}
          onPointerDown={dock.onPointerDown}
          onPointerMove={dock.onPointerMove}
          onPointerUp={dock.onPointerUp}
          onPointerCancel={dock.onPointerCancel}
          onKeyDown={dock.onKeyDown}
        >
          <AudioSurface stream={share.remoteStream} />
          <button type="button" className="ss-drag-handle" aria-label="Move screen share controls" title="Drag controls"><GripHorizontal size={17} /></button>
          <button type="button" className="ss-pause-control" onClick={share.togglePause} aria-label={share.paused ? "Resume screen sharing" : "Pause screen sharing"}>{share.paused ? <Play size={17} /> : <Pause size={17} />}<span>{share.paused ? "Resume" : "Pause"}</span></button>
          <button type="button" className="stop ss-stop-control" onClick={() => void share.stopShare()}><Square size={16} /><span>Stop</span></button>
        </div>
      )}
'''
    replace_once(path, old_dock, new_dock)


def patch_main_and_css() -> None:
    main_path = "frontend/src/main.tsx"
    replace_once(
        main_path,
        'import "./styles/brandingOverrides.css";\n',
        'import "./styles/brandingOverrides.css";\nimport "./styles/featureFixes.css";\n',
    )
    css = r'''/* Targeted user-facing fixes. Keep this file loaded after legacy themes. */

#chat-actions-menu .chat-language-section {
  display: grid;
  gap: 8px;
  margin: 4px 6px 7px;
  padding: 10px;
  border: 1px solid rgba(103, 232, 249, 0.18);
  border-radius: 10px;
  background: rgba(8, 24, 50, 0.88);
}

#chat-actions-menu .chat-language-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #cffafe;
}

#chat-actions-menu .chat-language-heading > span {
  display: grid;
  gap: 1px;
}

#chat-actions-menu .chat-language-heading strong {
  font-size: 12px;
  line-height: 1.2;
}

#chat-actions-menu .chat-language-heading small {
  color: #94a3b8;
  font-size: 10px;
}

#chat-actions-menu .chat-language-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

#chat-actions-menu .chat-language-options button {
  min-width: 0;
  min-height: 32px;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.05);
  padding: 4px 6px;
  color: #cbd5e1;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

#chat-actions-menu .chat-language-options button.is-active {
  border-color: rgba(103, 232, 249, 0.48);
  background: rgba(34, 211, 238, 0.16);
  color: #ecfeff;
}

.settings-reference-page .settings-reference-shell,
.settings-reference-page .settings-reference-content,
.settings-reference-page .settings-section-stack,
.settings-reference-page .settings-group {
  min-width: 0;
  max-width: 100%;
}

.settings-reference-page .settings-reference-content {
  overflow: visible;
  padding-bottom: calc(24px + var(--safe-bottom));
}

.settings-reference-page .settings-card {
  overflow: visible !important;
}

.settings-reference-page .settings-row {
  min-height: 60px;
  isolation: isolate;
  overflow: visible;
}

.settings-reference-page .settings-row-copy,
.settings-reference-page .settings-row-controls {
  min-width: 0;
}

.settings-reference-page .settings-row-controls {
  position: relative;
  z-index: 3;
  overflow: visible;
}

.settings-reference-page .app-select-root {
  position: relative;
  width: min(220px, 100%);
  min-width: 150px;
  max-width: 100%;
}

.settings-reference-page .app-select {
  width: 100%;
  min-width: 0;
}

.settings-reference-page .app-select-backdrop {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147482500 !important;
}

.settings-reference-page .app-select-menu {
  position: fixed !important;
  z-index: 2147482600 !important;
  top: 50% !important;
  left: 50% !important;
  right: auto !important;
  bottom: auto !important;
  width: min(420px, calc(100vw - 24px)) !important;
  max-width: calc(100vw - 24px) !important;
  max-height: min(74dvh, 620px) !important;
  transform: translate(-50%, -50%) !important;
  overflow: hidden !important;
}

.settings-reference-page .app-select-options {
  max-height: min(58dvh, 480px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.version-details-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147482700;
  display: grid;
  place-items: center;
  padding: max(14px, var(--safe-top)) max(14px, var(--safe-right)) max(14px, var(--safe-bottom)) max(14px, var(--safe-left));
  background: rgba(2, 6, 23, 0.78);
  backdrop-filter: blur(10px);
}

.version-details-dialog {
  width: min(680px, 100%);
  max-height: min(84dvh, 760px);
  overflow-y: auto;
  border: 1px solid rgba(103, 232, 249, 0.26);
  border-radius: 14px;
  background: linear-gradient(160deg, rgba(8, 28, 57, 0.99), rgba(4, 12, 29, 0.99));
  padding: 16px;
  color: #e2e8f0;
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.54);
}

.version-details-dialog > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.version-details-dialog > header span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #cffafe;
}

.version-details-dialog > header button {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}

.version-details-dialog > p {
  margin: 0 0 14px;
  color: #cbd5e1;
  font-size: 13px;
  line-height: 1.6;
}

.version-details-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.version-details-grid article {
  display: grid;
  gap: 5px;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.045);
  padding: 11px;
}

.version-details-grid article strong {
  color: #fff;
  font-size: 12px;
}

.version-details-grid article small {
  color: #94a3b8;
  font-size: 11px;
  line-height: 1.5;
}

.ss-floating-dock.ss-dock-compact {
  display: flex !important;
  width: auto !important;
  max-width: calc(100vw - 20px) !important;
  min-height: 48px;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(103, 232, 249, 0.32);
  border-radius: 14px;
  background: rgba(3, 12, 29, 0.96);
  padding: 5px;
  box-shadow: 0 18px 56px rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(12px);
  touch-action: none;
  user-select: none;
}

.ss-dock-compact .ss-drag-handle,
.ss-dock-compact .ss-pause-control,
.ss-dock-compact .ss-stop-control {
  min-width: 42px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  color: #e2e8f0;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 750;
}

.ss-dock-compact .ss-drag-handle {
  width: 34px;
  min-width: 34px;
  padding: 0;
  cursor: grab;
  color: #a5f3fc;
}

.ss-dock-compact .ss-drag-handle:active {
  cursor: grabbing;
}

.ss-dock-compact .ss-stop-control {
  border-color: rgba(248, 113, 113, 0.34);
  background: rgba(127, 29, 29, 0.66);
  color: #fee2e2;
}

@media (max-width: 599px) {
  .settings-reference-page .settings-row {
    min-height: 0;
    padding: 10px;
  }

  .settings-reference-page .settings-row-controls,
  .settings-reference-page .app-select-root {
    width: 100%;
  }

  .version-details-grid {
    grid-template-columns: 1fr;
  }

  .ss-dock-compact .ss-pause-control,
  .ss-dock-compact .ss-stop-control {
    min-width: 76px;
  }

  .um-chat-head {
    min-height: 52px !important;
    gap: 4px !important;
    padding: 6px 8px !important;
    overflow: hidden;
  }

  .um-chat-head .back {
    display: grid !important;
  }

  .um-chat-head .um-avatar {
    width: 34px !important;
    height: 34px !important;
    flex: 0 0 34px !important;
  }

  .um-chat-head > span {
    min-width: 36px !important;
    flex: 1 1 auto !important;
  }

  .um-chat-head > span strong {
    font-size: 12px !important;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .um-chat-head > span small {
    font-size: 9px !important;
  }

  .um-chat-head > button {
    width: 31px !important;
    height: 31px !important;
    flex: 0 0 31px !important;
    border-radius: 8px !important;
  }

  .um-chat-head > button svg {
    width: 15px;
    height: 15px;
  }
}
'''
    write("frontend/src/styles/featureFixes.css", css)


def add_tests() -> None:
    backend_test = '''from app.services.live_context import LiveRequestContext, response_language_instruction


def test_response_language_preferences_are_explicit():
    assert "Always answer in clear English" in response_language_instruction("autoai-response-en")
    assert "Always answer in clear Hindi" in response_language_instruction("autoai-response-hi")
    assert "latest message" in response_language_instruction("autoai-response-auto")
    assert response_language_instruction("en-IN") == ""


def test_live_context_includes_response_language_instruction():
    prompt = LiveRequestContext.create("Asia/Kolkata", "autoai-response-hi").system_prompt()
    assert "Response language instruction" in prompt
    assert "Devanagari" in prompt
'''
    write("backend/tests/test_response_language_context.py", backend_test)

    frontend_test = '''import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("requested user-facing feature fixes", () => {
  it("keeps response language controls in AI Chat", () => {
    const chat = source("components/chat/ChatPage.tsx");
    expect(chat).toContain("Response language");
    expect(chat).toContain("autoai-response-${settings.responseLanguage}");
  });

  it("uses direct first-click screen sharing and compact controls", () => {
    const workspace = source("features/screenShare/ScreenShareWorkspacePage.tsx");
    const overlay = source("features/screenShare/ScreenShareOverlay.tsx");
    expect(workspace).toContain("await screenShare.generateShareCode()");
    expect(overlay).toContain("ss-dock-compact");
    expect(overlay).not.toContain("Screen share quality");
  });

  it("keeps app version details and mobile layout fixes", () => {
    const settings = source("components/settings/SettingsPage.tsx");
    const css = source("styles/featureFixes.css");
    expect(settings).toContain("AutoAI app details");
    expect(css).toContain(".um-chat-head > button");
    expect(css).toContain(".app-select-menu");
  });
});
'''
    write("frontend/src/reliability/requestedFeatureFixes.contract.test.ts", frontend_test)


def main() -> None:
    patch_app_settings()
    patch_chat_page()
    patch_live_context()
    patch_ai_attachment_prompts()
    patch_settings_page()
    patch_screen_share_provider()
    patch_screen_share_workspace()
    patch_screen_share_overlay()
    patch_main_and_css()
    add_tests()

    forbidden = [path for path in CHANGED if "/admin/" in path or path.startswith("frontend/src/admin")]
    if forbidden:
        raise RuntimeError(f"Admin files must not be changed: {forbidden}")
    print("Changed files:")
    for path in CHANGED:
        print(f"- {path}")


if __name__ == "__main__":
    main()
