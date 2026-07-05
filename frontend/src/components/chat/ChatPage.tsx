import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Bot, Brain, CornerDownRight, Menu, RefreshCw, Settings, Sparkles, Square } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import type { ChatGeneration, DocumentItem, Message, ResponseModelInfo } from "../../types";
import { coerceTextContent } from "../../utils/text";
import { Composer, type ComposerOptions, type UploadTask } from "./Composer";
import { ContextPanel } from "./ContextPanel";
import { MessageBubble, type MessageReaction } from "./MessageBubble";
import { useAppSettings } from "../../contexts/AppSettingsContext";
import { useShell } from "../../contexts/ShellContext";
import { useSettingsNavigation } from "../../hooks/useSettingsNavigation";

const DEFAULT_OPTIONS: ComposerOptions = {
  searchMode: "auto",
  chatMode: "normal",
  researchProviders: ["groq", "bedrock"],
  maxModels: 3,
  allModels: false,
  timeoutSeconds: 45,
  groqModels: [],
  bedrockModels: [],
  openaiModels: [],
  geminiModels: [],
  finalJudgeModel: null,
  reasoning: false,
  provider: "groq",
  model: "openai/gpt-oss-120b"
};

function modelSelectionPayload(options: ComposerOptions) {
  const staleGroqDefault = options.provider === "groq" && options.model === "openai/gpt-oss-120b";
  return {
    provider: staleGroqDefault ? undefined : options.provider,
    model: staleGroqDefault ? undefined : options.model
  };
}

function splitDelta(delta: unknown) {
  const text = coerceTextContent(delta);
  return text ? text.match(/\S+\s*/g) ?? [text] : [];
}

function responseModelFallback(model?: string | null): ResponseModelInfo | null {
  if (!model) return null;
  if (model.startsWith("deep_research:")) {
    return {
      provider: "deep_research",
      provider_label: "Deep Research",
      model: model.replace(/^deep_research:/, "")
    };
  }
  if (/^(amazon|anthropic)\./.test(model)) {
    return { provider: "bedrock", provider_label: "AWS Bedrock", model };
  }
  return { provider: "groq", provider_label: "Groq", model };
}

export function ChatPage() {
  const { token } = useAuth();
  const { settings } = useAppSettings();
  const { activeChat, createChat, openChat, refreshChats, setActiveChat } = useChat();
  const { openSidebar } = useShell();
  const openSettings = useSettingsNavigation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [searchingMessageId, setSearchingMessageId] = useState<string | null>(null);
  const [activeGeneration, setActiveGeneration] = useState<ChatGeneration | null>(null);
  const [reactions, setReactions] = useState<Record<string, MessageReaction>>({});
  const [bookmarks, setBookmarks] = useState<Record<string, boolean>>({});
  const [isContextOpen, setIsContextOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const activeChatRef = useRef(activeChat);
  const tokenRef = useRef(token);
  const activeGenerationRef = useRef<ChatGeneration | null>(null);
  const deltaQueueRef = useRef<string[]>([]);
  const deltaTimerRef = useRef<number | null>(null);
  const deltaTargetRef = useRef<{ chatId: string; messageId: string } | null>(null);
  const deltaResolversRef = useRef<Array<() => void>>([]);
  const queuedContentRef = useRef<Record<string, string>>({});
  const generationPollTimerRef = useRef<number | null>(null);
  const lastOptionsRef = useRef<ComposerOptions>(DEFAULT_OPTIONS);

  useEffect(() => {
    setMessages(activeChat?.messages ?? []);
  }, [activeChat]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    activeChatRef.current = activeChat;
  }, [activeChat]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    activeGenerationRef.current = activeGeneration;
  }, [activeGeneration]);

  useEffect(() => {
    const handleToggle = () => setIsContextOpen((prev) => !prev);
    const handleOpen = () => setIsContextOpen(true);
    window.addEventListener("toggle-context-panel", handleToggle);
    window.addEventListener("open-context-panel", handleOpen);
    return () => {
      window.removeEventListener("toggle-context-panel", handleToggle);
      window.removeEventListener("open-context-panel", handleOpen);
    };
  }, []);

  const refreshDocuments = useCallback(async () => {
    if (!token) return;
    setDocumentsLoading(true);
    try {
      setDocuments(await api.listDocuments(token));
    } finally {
      setDocumentsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refreshDocuments();
  }, [refreshDocuments]);

  useEffect(() => {
    return () => {
      if (deltaTimerRef.current) window.cancelAnimationFrame(deltaTimerRef.current);
      if (generationPollTimerRef.current) window.clearTimeout(generationPollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    void recoverActiveGeneration();
  }, [token]);

  useEffect(() => {
    const resume = () => {
      if (document.hidden) return;
      const generation = activeGenerationRef.current;
      if (generation && isRunningGenerationStatus(generation.status)) {
        startGenerationPolling(generation.id);
        return;
      }
      void recoverActiveGeneration();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [token]);

  const { isPinnedToBottom, scrollToBottom } = useAutoScroll(scrollRef, [messages, streamingMessageId]);

  const hasMessages = messages.length > 0;
  const activeTitle = useMemo(() => activeChat?.title ?? "New chat", [activeChat]);
  const fallbackResponseModel = useMemo(
    () => responseModelFallback(activeChat?.model),
    [activeChat?.model]
  );
  const selectedDocuments = useMemo(
    () => documents.filter((document) => selectedDocumentIds.includes(document.id)),
    [documents, selectedDocumentIds]
  );
  const visibleMessages = useMemo(
    () => (messages.length > 160 ? messages.slice(-160) : messages),
    [messages]
  );
  const isGenerationRunning =
    activeGeneration?.status === "pending" ||
    activeGeneration?.status === "running" ||
    activeGeneration?.status === "cancel_requested";
  const visibleGeneration = activeGeneration?.chat_id === activeChat?.id ? activeGeneration : null;
  const visibleStreamingMessageId =
    visibleGeneration && isGenerationRunning ? visibleGeneration.assistant_message_id ?? null : null;

  function syncActiveChatMessages(chatId: string, nextMessages: Message[]) {
    setActiveChat((current) =>
      current?.id === chatId ? { ...current, messages: nextMessages } : current
    );
  }

  function updateMessagesForChat(
    chatId: string,
    updater: (current: Message[]) => Message[],
    sync = false
  ) {
    setMessages((current) => {
      const nextMessages = updater(current);
      if (sync) syncActiveChatMessages(chatId, nextMessages);
      return nextMessages;
    });
  }

  function resolveDeltaQueueIfIdle() {
    if (deltaQueueRef.current.length || deltaTimerRef.current) return;
    const resolvers = deltaResolversRef.current.splice(0);
    resolvers.forEach((resolve) => resolve());
  }

  function enqueueDelta(chatId: string, messageId: string, delta: unknown) {
    deltaTargetRef.current = { chatId, messageId };
    deltaQueueRef.current.push(...splitDelta(delta));
    if (deltaTimerRef.current) return;

    const drainQueue = () => {
      deltaTimerRef.current = null;
      const target = deltaTargetRef.current;
      const batchSize = document.hidden ? deltaQueueRef.current.length : 8;
      const piece = deltaQueueRef.current.splice(0, Math.max(1, batchSize)).join("");
      if (piece && target) {
        updateMessagesForChat(target.chatId, (current) =>
          current.map((message) =>
            message.id === target.messageId
              ? { ...message, content: coerceTextContent(message.content) + piece }
              : message
          )
        );
      }
      if (deltaQueueRef.current.length) {
        deltaTimerRef.current = window.requestAnimationFrame(drainQueue);
      } else {
        resolveDeltaQueueIfIdle();
      }
    };

    deltaTimerRef.current = window.requestAnimationFrame(drainQueue);
  }

  function waitForDeltaDrain() {
    if (!deltaQueueRef.current.length && !deltaTimerRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      deltaResolversRef.current.push(resolve);
    });
  }

  function notifyResponseComplete(title: string) {
    if (!settings.notificationsEnabled || !document.hidden || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification("Auto-AI response ready", {
        body: title,
        tag: "auto-ai-chat-response",
        silent: true
      });
    } catch (error) {
      console.warn("[Auto-AI Notifications] Unable to show response notification.", error);
    }
  }

  function isRunningGenerationStatus(status?: string | null) {
    return status === "pending" || status === "running" || status === "cancel_requested";
  }

  function upsertMessage(current: Message[], incoming: Message) {
    const index = current.findIndex((message) => message.id === incoming.id);
    if (index < 0) return [...current, incoming];
    if (current[index] === incoming) return current;
    const next = current.slice();
    next[index] = incoming;
    return next;
  }

  function applyGenerationSnapshot(generation: ChatGeneration) {
    const running = isRunningGenerationStatus(generation.status);
    const assistant = generation.assistant_message ?? null;
    const user = generation.user_message ?? null;

    if (generation.status === "completed") {
      setActiveGeneration(null);
    } else {
      setActiveGeneration(generation);
    }
    setStreaming(running);
    setStreamingMessageId(running ? generation.assistant_message_id ?? null : null);

    const streamMetadata = assistant?.message_metadata?.streaming as { phase?: string } | undefined;
    const phase = streamMetadata?.phase;
    setSearchingMessageId(running && phase === "searching" ? assistant?.id ?? null : null);

    if (activeChatRef.current?.id !== generation.chat_id) return;

    let queuedDelta = "";
    if (assistant) {
      const serverContent = coerceTextContent(assistant.content);
      const existing = messagesRef.current.find((message) => message.id === assistant.id);
      const displayedContent = coerceTextContent(existing?.content);
      const queuedContent = queuedContentRef.current[assistant.id] ?? displayedContent;

      if (running && existing && serverContent.startsWith(queuedContent)) {
        queuedDelta = serverContent.slice(queuedContent.length);
        queuedContentRef.current[assistant.id] = serverContent;
      } else {
        queuedContentRef.current[assistant.id] = serverContent;
      }
    }

    updateMessagesForChat(generation.chat_id, (current) => {
      let next = current;
      if (user) next = upsertMessage(next, user);
      if (assistant) {
        const existing = next.find((message) => message.id === assistant.id);
        const content = running && existing ? coerceTextContent(existing.content) : coerceTextContent(assistant.content);
        next = upsertMessage(next, { ...assistant, content });
      }
      return next;
    });

    if (assistant && queuedDelta) {
      enqueueDelta(generation.chat_id, assistant.id, queuedDelta);
    }
  }

  async function pollGeneration(generationId: string) {
    const authToken = tokenRef.current;
    if (!authToken) return false;
    try {
      const generation = await api.getChatGeneration(authToken, generationId);
      applyGenerationSnapshot(generation);
      if (!isRunningGenerationStatus(generation.status)) {
        await waitForDeltaDrain();
        setStreaming(false);
        setStreamingMessageId(null);
        setSearchingMessageId(null);
        if (activeChatRef.current?.id === generation.chat_id) {
          await openChat(generation.chat_id);
        }
        await refreshChats();
        if (generation.status === "completed") {
          notifyResponseComplete(activeChatRef.current?.title ?? "Response ready");
        }
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  function stopGenerationPolling() {
    if (generationPollTimerRef.current) {
      window.clearTimeout(generationPollTimerRef.current);
      generationPollTimerRef.current = null;
    }
  }

  function startGenerationPolling(generationId: string) {
    stopGenerationPolling();
    const tick = async () => {
      const keepPolling = await pollGeneration(generationId);
      if (!keepPolling) {
        stopGenerationPolling();
        return;
      }
      const retryDelay = navigator.onLine === false ? 1800 : document.hidden ? 1200 : 280;
      generationPollTimerRef.current = window.setTimeout(tick, retryDelay);
    };
    void tick();
  }

  async function recoverActiveGeneration() {
    if (!token) return;
    try {
      const generations = await api.activeChatGenerations(token);
      const generation = generations[0];
      if (!generation) {
        if (activeGenerationRef.current && isRunningGenerationStatus(activeGenerationRef.current.status)) {
          setStreaming(false);
          setStreamingMessageId(null);
          setSearchingMessageId(null);
          setActiveGeneration(null);
        }
        if (activeChatRef.current?.id) {
          await openChat(activeChatRef.current.id);
        }
        return;
      }
      applyGenerationSnapshot(generation);
      startGenerationPolling(generation.id);
    } catch (error) {
      console.warn("[Auto-AI Streaming] Unable to recover active generation.", error);
    }
  }

  async function uploadDocuments(files: File[], provider: ComposerOptions["provider"]) {
    if (!token) return;
    await Promise.all(
      files.map(async (file) => {
        const id = crypto.randomUUID();
        setUploadTasks((current) => [
          ...current,
          { id, filename: file.name, progress: 1, status: "uploading" }
        ]);
        const formData = new FormData();
        formData.append("file", file);
        formData.append("summarize", "true");
        formData.append("provider", provider);
        if (activeChat?.id) formData.append("chat_id", activeChat.id);

        try {
          const created = await api.uploadDocumentWithProgress(token, formData, (progress) => {
            setUploadTasks((current) =>
              current.map((task) =>
                task.id === id
                  ? {
                      ...task,
                      progress,
                      status: progress >= 100 ? "processing" : "uploading"
                    }
                  : task
              )
            );
          });
          setDocuments((current) => [created, ...current.filter((document) => document.id !== created.id)]);
          setSelectedDocumentIds((current) => Array.from(new Set([...current, created.id])));
          setUploadTasks((current) =>
            current.map((task) =>
              task.id === id ? { ...task, progress: 100, status: "done" } : task
            )
          );
          window.setTimeout(() => {
            setUploadTasks((current) => current.filter((task) => task.id !== id));
          }, 1800);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Upload failed";
          setUploadTasks((current) =>
            current.map((task) =>
              task.id === id ? { ...task, status: "error", error: detail, progress: 100 } : task
            )
          );
        }
      })
    );
  }

  async function handleDeleteDocument(documentId: string) {
    if (!token || !window.confirm("Delete this document?")) return;
    try {
      await api.deleteDocument(token, documentId);
      setDocuments((current) => current.filter((document) => document.id !== documentId));
      setSelectedDocumentIds((current) => current.filter((id) => id !== documentId));
      await refreshDocuments();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to delete document";
      window.alert(detail);
    }
  }

  async function analyzeImages(text: string, imageFiles: File[]) {
    if (!token || !imageFiles.length) return "";
    const analyses: string[] = [];
    for (const file of imageFiles) {
      const result = await api.analyzeImage(
        token,
        file,
        text || "Analyze this image in detail and extract useful context for the next answer."
      );
      analyses.push(`Image: ${file.name}\n${result.content}`);
    }
    return analyses.join("\n\n---\n\n");
  }

  function requestOptionsPayload(options: ComposerOptions) {
    const modelSelection = modelSelectionPayload(options);
    return {
      provider: modelSelection.provider,
      model: modelSelection.model,
      mode: options.chatMode,
      providers: options.chatMode === "normal" ? undefined : options.researchProviders,
      max_models: options.chatMode === "normal" ? undefined : options.maxModels,
      all_models: options.chatMode === "normal" ? undefined : options.allModels,
      timeout_seconds: options.chatMode === "normal" ? undefined : options.timeoutSeconds,
      groq_models: options.chatMode === "normal" ? undefined : options.groqModels,
      bedrock_models: options.chatMode === "normal" ? undefined : options.bedrockModels,
      openai_models: options.chatMode === "normal" ? undefined : options.openaiModels,
      gemini_models: options.chatMode === "normal" ? undefined : options.geminiModels,
      final_judge_model: options.chatMode === "normal" ? undefined : options.finalJudgeModel,
      web_search: options.searchMode !== "off" && options.searchMode !== "auto",
      search_mode: options.searchMode,
      reasoning: options.reasoning,
      document_ids: settings.memoryEnabled ? selectedDocumentIds : []
    };
  }

  async function handleSend(text: string, options: ComposerOptions, imageFiles: File[] = []) {
    if (!token || streaming) return;
    lastOptionsRef.current = options;
    setStreaming(true);
    try {
      const chat = activeChat ?? (await createChat(text.slice(0, 60) || "New chat"));
      const imageContext = await analyzeImages(text, imageFiles);
      const modelMessage = imageContext
        ? `${text}\n\nAttached image context extracted by Auto-AI vision:\n${imageContext}`
        : text;

      const generation = await api.startChatGeneration(
        token,
        {
          message: modelMessage,
          chat_id: chat.id,
          ...requestOptionsPayload(options)
        }
      );

      applyGenerationSnapshot(generation);
      startGenerationPolling(generation.id);
      void refreshChats().catch(() => undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to stream response";
      window.alert(`AI request failed: ${detail}`);
      await refreshChats();
      setStreaming(false);
      setStreamingMessageId(null);
      setSearchingMessageId(null);
    }
  }

  function handleReact(messageId: string, reaction: MessageReaction) {
    setReactions((current) => ({ ...current, [messageId]: reaction }));
  }

  function handleBookmark(messageId: string) {
    setBookmarks((current) => ({ ...current, [messageId]: !current[messageId] }));
  }

  async function handleShare(messageId: string) {
    const message = messages.find((item) => item.id === messageId);
    if (!message) return;
    const text = `${activeTitle}\n\n${coerceTextContent(message.content)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Auto-AI", text });
        return;
      } catch {
        // Fall through to clipboard when the share sheet is dismissed or unavailable.
      }
    }
    await navigator.clipboard.writeText(text);
  }

  async function handleRegenerate(messageId: string) {
    if (streaming || !token || !activeChat?.id) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const previousUser = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (!previousUser) return;
    setStreaming(true);
    try {
      const generation = await api.regenerateChatSession(token, activeChat.id, {
        message_id: messageId,
        ...requestOptionsPayload(lastOptionsRef.current)
      });
      const trimmedMessages = messages.slice(0, index);
      setMessages(trimmedMessages);
      syncActiveChatMessages(activeChat.id, trimmedMessages);
      applyGenerationSnapshot(generation);
      startGenerationPolling(generation.id);
      void refreshChats().catch(() => undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to regenerate response";
      window.alert(detail);
      setStreaming(false);
    }
  }

  async function handleEdit(messageId: string) {
    if (streaming) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const message = messages[index];
    if (!message || message.role !== "user") return;
    const nextPrompt = window.prompt("Edit prompt", coerceTextContent(message.content));
    if (!nextPrompt?.trim()) return;
    if (activeChat?.id) {
      const trimmedMessages = messages.slice(0, index);
      setMessages(trimmedMessages);
      syncActiveChatMessages(activeChat.id, trimmedMessages);
    }
    await handleSend(nextPrompt.trim(), lastOptionsRef.current, []);
  }

  async function handleContinue() {
    if (streaming) return;
    const failedWithoutPartial =
      visibleGeneration?.status === "failed" &&
      !coerceTextContent(visibleGeneration.assistant_message?.content).trim();
    if (failedWithoutPartial) {
      await handleRetryGeneration();
      return;
    }
    await handleSend(
      "Continue the previous response from where it stopped. Do not restart the answer.",
      lastOptionsRef.current,
      []
    );
  }

  async function handleStopGeneration() {
    if (!token || !activeGeneration || !isRunningGenerationStatus(activeGeneration.status)) return;
    try {
      const generation = activeChat?.id
        ? await api.stopChatSession(token, activeChat.id)
        : await api.cancelChatGeneration(token, activeGeneration.id);
      applyGenerationSnapshot(generation);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to stop generation";
      window.alert(detail);
    }
  }

  async function handleRetryGeneration() {
    const assistantId = visibleGeneration?.assistant_message_id;
    if (!assistantId || streaming) return;
    await handleRegenerate(assistantId);
  }

  const generationStatusLabel =
    visibleGeneration?.status === "cancel_requested"
      ? "Stopping..."
      : visibleGeneration?.status === "failed"
        ? "Generation failed"
        : visibleGeneration?.status === "cancelled"
          ? "Generation stopped"
          : "Generating...";
  const generationErrorDetail =
    visibleGeneration?.status === "failed" && visibleGeneration.error
      ? coerceTextContent(visibleGeneration.error)
      : "";
  const generationStatusText = generationErrorDetail
    ? `${generationStatusLabel}: ${generationErrorDetail}`
    : generationStatusLabel;
  const canContinueVisibleGeneration =
    visibleGeneration?.status !== "failed" ||
    Boolean(coerceTextContent(visibleGeneration?.assistant_message?.content).trim());

  return (
    <div className="chat-workspace">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center justify-between border-b border-white/10 bg-slate-950/70 px-4 text-white backdrop-blur-xl md:hidden">
          <button
            className="icon-button-dark"
            onClick={openSidebar}
            title="Menu"
            type="button"
          >
            <Menu size={18} />
          </button>
          <span className="truncate text-sm font-medium">{activeTitle}</span>
          <div className="flex items-center gap-1.5">
            <button
              className="icon-button-dark"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("open-context-panel", { detail: { tab: "memory" } }));
              }}
              title="Context & Memory"
              aria-label="Open context and memory"
              type="button"
            >
              <Brain size={18} className="text-cyan-200" />
            </button>
            <button
              className="icon-button-dark"
              onClick={openSettings}
              title="Settings"
              aria-label="Open settings"
              type="button"
            >
              <Settings size={18} className="text-cyan-200" />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="chat-scroll">
          {messages.length > visibleMessages.length && (
            <div className="mx-auto my-3 max-w-3xl rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-center text-xs text-slate-400">
              Showing the latest {visibleMessages.length} messages for a faster chat view.
            </div>
          )}
          <AnimatePresence initial={false}>
            {hasMessages ? (
              visibleMessages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  isStreaming={message.id === visibleStreamingMessageId}
                  isSearchingWeb={message.id === searchingMessageId}
                  reaction={reactions[message.id]}
                  bookmarked={bookmarks[message.id]}
                  fallbackModel={message.role === "assistant" ? fallbackResponseModel : null}
                  onReact={handleReact}
                  onRegenerate={handleRegenerate}
                  onEdit={handleEdit}
                  onContinue={handleContinue}
                  onBookmark={handleBookmark}
                  onShare={handleShare}
                />
              ))
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="grid min-h-full place-items-center px-4 py-12"
              >
                <div className="max-w-3xl text-center">
                  <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-lg border border-cyan-200/30 bg-cyan-200/15 text-cyan-100 shadow-[0_0_38px_rgba(34,211,238,0.25)]">
                    <Bot size={25} />
                  </div>
                  <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase text-cyan-100">
                    <Sparkles size={13} />
                    Ultra human mode
                  </p>
                  <h1 className="text-3xl font-semibold text-white md:text-5xl">
                    Ask, upload, speak, and keep the thread alive.
                  </h1>
                  <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-slate-300 md:text-base">
                    Auto-AI adapts to tone, remembers useful preferences, streams answers smoothly, and can reason across your documents and images.
                  </p>
                  <div className="mt-6 grid gap-3 text-left md:grid-cols-3">
                    {["Document-aware", "Emotion-aware", "Action-ready"].map((label) => (
                      <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] p-3 text-sm text-slate-200">
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {!isPinnedToBottom && messages.length > 0 && (
          <button
            className="scroll-bottom-button"
            type="button"
            onClick={scrollToBottom}
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
          >
            <ArrowDown size={16} />
          </button>
        )}

        {visibleGeneration && (
          <div className="generation-status-bar">
            <span className="generation-dot" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={generationStatusText}>{generationStatusText}</span>
            {isGenerationRunning ? (
              <button className="generation-action" onClick={handleStopGeneration} type="button">
                <Square size={14} />
                Stop
              </button>
            ) : (
              <>
                <button className="generation-action" onClick={handleRetryGeneration} type="button">
                  <RefreshCw size={14} />
                  Retry
                </button>
                {canContinueVisibleGeneration && (
                  <button className="generation-action" onClick={handleContinue} type="button">
                    <CornerDownRight size={14} />
                    Continue
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <Composer
          disabled={streaming}
          selectedDocuments={selectedDocuments}
          uploadTasks={uploadTasks}
          onRemoveDocument={(id) =>
            setSelectedDocumentIds((current) => current.filter((documentId) => documentId !== id))
          }
          onDeleteDocument={handleDeleteDocument}
          onUploadDocuments={uploadDocuments}
          onSend={handleSend}
        />
      </section>

      <ContextPanel
        documents={documents}
        selectedIds={selectedDocumentIds}
        setSelectedIds={setSelectedDocumentIds}
        onDeleteDocument={handleDeleteDocument}
        loadingDocuments={documentsLoading}
        onRefreshDocuments={refreshDocuments}
        isOpen={isContextOpen}
        onClose={() => setIsContextOpen(false)}
      />
    </div>
  );
}
