import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Bot, Brain, CornerDownRight, Menu, MessageSquarePlus, RefreshCw, Settings, Sparkles, Square } from "lucide-react";
import { ApiClientError, api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import type { ChatAttachment, ChatGeneration, ChatRequest, DocumentItem, Message, MessageInternalContext, ResponseModelInfo } from "../../types";
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

type LocalRetryRequest = {
  chatId?: string;
  text: string;
  options: ComposerOptions;
  imageFiles: File[];
  attachments: ChatAttachment[];
  internalContext: MessageInternalContext | null;
  clientMessageId: string;
  userMessageId: string;
  documentIds: string[];
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

function nowIso() {
  return new Date().toISOString();
}

function clientMessageIdOf(message?: Message | null) {
  return typeof message?.message_metadata?.client_message_id === "string"
    ? message.message_metadata.client_message_id
    : "";
}

function attachmentsOf(message?: Message | null): ChatAttachment[] {
  return Array.isArray(message?.message_metadata?.attachments)
    ? message.message_metadata.attachments
    : [];
}

function mergeAttachmentPreviews(incoming: ChatAttachment[], existing: ChatAttachment[]) {
  return incoming.map((attachment) => {
    const previous = existing.find((item) => item.id === attachment.id || item.filename === attachment.filename);
    return previous?.preview_url && !attachment.preview_url
      ? { ...attachment, preview_url: previous.preview_url }
      : attachment;
  });
}

function createImageAttachment(file: File): ChatAttachment {
  return {
    id: crypto.randomUUID(),
    type: "image",
    preview_url: URL.createObjectURL(file),
    filename: file.name || "image",
    mime_type: file.type || "image/*",
    file_size: file.size,
    status: "analyzing"
  };
}

function createDocumentAttachments(documents: DocumentItem[], documentIds: string[]): ChatAttachment[] {
  return documents
    .filter((document) => documentIds.includes(document.id))
    .map((document) => ({
      id: document.id,
      type: "file",
      filename: document.filename,
      mime_type: document.content_type,
      file_size: document.file_size,
      status: "uploaded"
    }));
}

function serializableAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    url: attachment.url,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    file_size: attachment.file_size,
    status: attachment.status === "analyzing" || attachment.status === "queued" ? "uploaded" : attachment.status
  }));
}

function thinkingPhase(options: ComposerOptions, attachments: ChatAttachment[], documentIds: string[]) {
  if (options.chatMode !== "normal" || options.searchMode === "deep" || options.searchMode === "research") return "researching";
  if (attachments.some((attachment) => attachment.type === "image")) return "analyzing_image";
  if (attachments.some((attachment) => attachment.type === "file") || documentIds.length) return "reading_file";
  return "thinking";
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
  const [submittingGeneration, setSubmittingGeneration] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [searchingMessageId, setSearchingMessageId] = useState<string | null>(null);
  const [activeGeneration, setActiveGeneration] = useState<ChatGeneration | null>(null);
  const [reactions, setReactions] = useState<Record<string, MessageReaction>>({});
  const [bookmarks, setBookmarks] = useState<Record<string, boolean>>({});
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
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
  const localRetryRef = useRef<Record<string, LocalRetryRequest>>({});

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
  const visibleGeneration = activeGeneration?.chat_id === activeChat?.id ? activeGeneration : null;
  const visibleGenerationRunning = Boolean(visibleGeneration && isRunningGenerationStatus(visibleGeneration.status));
  const visibleChatBusy = submittingGeneration || visibleGenerationRunning;
  const visibleStreamingMessageId =
    visibleGenerationRunning ? visibleGeneration?.assistant_message_id ?? streamingMessageId : streamingMessageId;

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

  function showChatNotice(message: string) {
    setChatNotice(message);
  }

  function isRunningGenerationStatus(status?: string | null) {
    return status === "pending" || status === "running" || status === "cancel_requested";
  }

  function upsertMessage(current: Message[], incoming: Message) {
    const incomingClientId = clientMessageIdOf(incoming);
    const index = current.findIndex((message) =>
      message.id === incoming.id ||
      (incomingClientId && message.role === incoming.role && clientMessageIdOf(message) === incomingClientId)
    );
    if (index < 0) return [...current, incoming];
    if (current[index] === incoming) return current;
    const next = current.slice();
    const existing = current[index];
    const existingAttachments = attachmentsOf(existing);
    const incomingAttachments = attachmentsOf(incoming);
    next[index] = incomingAttachments.length
      ? {
          ...incoming,
          message_metadata: {
            ...(incoming.message_metadata || {}),
            attachments: mergeAttachmentPreviews(incomingAttachments, existingAttachments)
          }
        }
      : incoming;
    return next;
  }

  function applyGenerationSnapshot(generation: ChatGeneration) {
    const running = isRunningGenerationStatus(generation.status);
    const visible = activeChatRef.current?.id === generation.chat_id;
    const assistant = generation.assistant_message ?? null;
    const user = generation.user_message ?? null;

    if (generation.status === "completed") {
      setActiveGeneration(null);
    } else {
      setActiveGeneration(generation);
    }
    setSubmittingGeneration(false);
    setStreaming(running && visible);
    setStreamingMessageId(running && visible ? generation.assistant_message_id ?? null : null);

    const streamMetadata = assistant?.message_metadata?.streaming as { phase?: string } | undefined;
    const phase = streamMetadata?.phase;
    setSearchingMessageId(running && visible && phase === "searching" ? assistant?.id ?? null : null);

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
          setSubmittingGeneration(false);
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
      showChatNotice(detail);
    }
  }

  async function analyzeImages(text: string, imageFiles: File[]): Promise<MessageInternalContext | null> {
    if (!token || !imageFiles.length) return null;
    const analyses: string[] = [];
    for (const file of imageFiles) {
      try {
        const result = await api.analyzeImage(
          token,
          file,
          text || "Analyze this image in detail and extract useful context for the next answer."
        );
        analyses.push(`Image: ${file.name}\n${result.content}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Image analysis failed";
        analyses.push(`Image: ${file.name}\nImage analysis unavailable: ${detail}`);
      }
    }
    return analyses.length ? { image_summary: analyses.join("\n\n---\n\n") } : null;
  }

  function requestOptionsPayload(options: ComposerOptions, documentIds = selectedDocumentIds) {
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
      document_ids: settings.memoryEnabled ? documentIds : []
    };
  }

  function buildGenerationPayload(request: LocalRetryRequest, chatId: string, internalContext: MessageInternalContext | null): ChatRequest {
    return {
      message: request.text,
      chat_id: chatId,
      client_message_id: request.clientMessageId,
      attachments: serializableAttachments(request.attachments),
      internal_context: internalContext,
      ...requestOptionsPayload(request.options, request.documentIds)
    };
  }

  function optimisticMessages(request: LocalRetryRequest, assistantId: string): Message[] {
    const phase = thinkingPhase(request.options, request.attachments, request.documentIds);
    return [
      {
        id: request.userMessageId,
        role: "user",
        content: request.text,
        message_metadata: {
          client_message_id: request.clientMessageId,
          attachments: request.attachments
        },
        created_at: nowIso()
      },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        message_metadata: {
          client_message_id: request.clientMessageId,
          streaming: {
            status: "pending",
            partial: true,
            phase
          }
        },
        created_at: nowIso()
      }
    ];
  }

  function markLocalAssistant(
    chatId: string | undefined,
    assistantId: string,
    updater: (message: Message) => Message
  ) {
    const applyUpdate = (current: Message[]) =>
      current.map((message) => (message.id === assistantId ? updater(message) : message));
    if (chatId) {
      updateMessagesForChat(chatId, applyUpdate, true);
    } else {
      setMessages(applyUpdate);
    }
  }

  function markLocalGenerationFailed(chatId: string | undefined, assistantId: string, error: unknown) {
    const detail = error instanceof Error ? error.message : "Unable to stream response";
    markLocalAssistant(chatId, assistantId, (message) => ({
      ...message,
      message_metadata: {
        ...(message.message_metadata || {}),
        streaming: {
          ...((message.message_metadata?.streaming as object | undefined) || {}),
          status: "failed",
          partial: false,
          error: detail
        }
      }
    }));
    showChatNotice("Response interrupted. Your message was saved. Tap Retry.");
  }

  async function startGenerationForLocalAssistant(request: LocalRetryRequest, assistantId: string) {
    if (!token) return;
    let chatId = request.chatId || activeChatRef.current?.id;
    setStreaming(true);
    setSubmittingGeneration(true);
    setStreamingMessageId(assistantId);
    setSearchingMessageId(null);
    try {
      if (!chatId) {
        const chat = await createChat(request.text.slice(0, 60) || request.attachments[0]?.filename || "New chat");
        chatId = chat.id;
        request.chatId = chat.id;
        const pendingMessages = optimisticMessages(request, assistantId);
        setMessages((current) =>
          current.some((message) => message.id === assistantId) ? current : [...current, ...pendingMessages]
        );
        setActiveChat({
          ...chat,
          messages: messagesRef.current.some((message) => message.id === assistantId)
            ? messagesRef.current
            : pendingMessages
        });
      }
      const internalContext = request.internalContext ?? await analyzeImages(request.text, request.imageFiles);
      request.internalContext = internalContext;
      const generation = await api.startChatGeneration(token, buildGenerationPayload(request, chatId, internalContext));
      delete localRetryRef.current[assistantId];
      applyGenerationSnapshot(generation);
      startGenerationPolling(generation.id);
      void refreshChats().catch(() => undefined);
    } catch (error) {
      markLocalGenerationFailed(chatId, assistantId, error);
      setStreaming(false);
      setSubmittingGeneration(false);
      setStreamingMessageId(null);
      setSearchingMessageId(null);
    }
  }

  async function handleSend(text: string, options: ComposerOptions, imageFiles: File[] = []) {
    if (!token || visibleChatBusy) return;
    const documentIds = settings.memoryEnabled ? [...selectedDocumentIds] : [];
    const attachments = [
      ...imageFiles.map(createImageAttachment),
      ...createDocumentAttachments(documents, documentIds)
    ];
    const request: LocalRetryRequest = {
      chatId: activeChat?.id,
      text,
      options,
      imageFiles,
      attachments,
      internalContext: null,
      clientMessageId: crypto.randomUUID(),
      userMessageId: "",
      documentIds
    };
    const assistantId = `local-assistant-${request.clientMessageId}`;
    const userId = `local-user-${request.clientMessageId}`;
    request.userMessageId = userId;
    const pendingMessages = optimisticMessages(request, assistantId);
    lastOptionsRef.current = options;
    setChatNotice("");
    localRetryRef.current[assistantId] = request;
    if (activeChat?.id) {
      updateMessagesForChat(activeChat.id, (current) => [...current, ...pendingMessages], true);
    } else {
      setMessages((current) => [...current, ...pendingMessages]);
    }
    await startGenerationForLocalAssistant(request, assistantId);
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
    const localRetry = localRetryRef.current[messageId];
    if (localRetry) {
      if (visibleChatBusy) return;
      markLocalAssistant(localRetry.chatId, messageId, (message) => ({
        ...message,
        content: "",
        message_metadata: {
          ...(message.message_metadata || {}),
          streaming: {
            status: "pending",
            partial: true,
            phase: thinkingPhase(localRetry.options, localRetry.attachments, localRetry.documentIds)
          }
        }
      }));
      await startGenerationForLocalAssistant(localRetry, messageId);
      return;
    }
    if (visibleChatBusy || !token || !activeChat?.id) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const previousUser = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (!previousUser) return;
    setStreaming(true);
    setSubmittingGeneration(true);
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
      showChatNotice(detail);
      setStreaming(false);
      setSubmittingGeneration(false);
    }
  }

  async function handleEdit(messageId: string) {
    if (visibleChatBusy) return;
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
    if (visibleChatBusy) return;
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
      const generation = activeGeneration.chat_id
        ? await api.stopChatSession(token, activeGeneration.chat_id)
        : await api.cancelChatGeneration(token, activeGeneration.id);
      applyGenerationSnapshot(generation);
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.status === 404 &&
        error.message.toLowerCase().includes("no active response")
      ) {
        stopGenerationPolling();
        setStreaming(false);
        setSubmittingGeneration(false);
        setStreamingMessageId(null);
        setSearchingMessageId(null);
        setActiveGeneration(null);
        await recoverActiveGeneration();
        return;
      }
      const detail = error instanceof Error ? error.message : "Unable to stop generation";
      showChatNotice(detail);
    }
  }

  async function handleRetryGeneration() {
    const assistantId = visibleGeneration?.assistant_message_id;
    if (!assistantId || visibleChatBusy) return;
    await handleRegenerate(assistantId);
  }

  async function handleNewChat() {
    await createChat();
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

        <div className="chat-topbar hidden md:flex">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="chat-topbar-dot" aria-hidden="true" />
              <h1 className="truncate text-sm font-semibold text-white">{activeTitle}</h1>
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {(activeChat?.mode || lastOptionsRef.current.chatMode).replace("_", " ")} / {activeChat?.model || lastOptionsRef.current.model}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {visibleGenerationRunning && (
              <button className="generation-action" onClick={handleStopGeneration} type="button">
                <Square size={14} />
                Stop
              </button>
            )}
            <button className="chat-topbar-action" onClick={handleNewChat} type="button">
              <MessageSquarePlus size={15} />
              New chat
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

        {chatNotice && (
          <div className="chat-notice" role="status">
            <span className="min-w-0 flex-1">{chatNotice}</span>
            <button className="chat-notice-close" onClick={() => setChatNotice("")} type="button">
              Dismiss
            </button>
          </div>
        )}

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
            {visibleGenerationRunning ? (
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
          disabled={visibleChatBusy}
          selectedDocuments={selectedDocuments}
          uploadTasks={uploadTasks}
          onRemoveDocument={(id) =>
            setSelectedDocumentIds((current) => current.filter((documentId) => documentId !== id))
          }
          onDeleteDocument={handleDeleteDocument}
          onUploadDocuments={uploadDocuments}
          onSend={handleSend}
          onStop={handleStopGeneration}
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
