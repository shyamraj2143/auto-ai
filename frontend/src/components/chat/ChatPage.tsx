import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Menu, MessageSquarePlus, Sparkles } from "lucide-react";
import { api, streamChat } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import type { DocumentItem, Message } from "../../types";
import { Composer, type ComposerOptions, type UploadTask } from "./Composer";
import { ContextPanel } from "./ContextPanel";
import { MessageBubble, type MessageReaction } from "./MessageBubble";

const DEFAULT_OPTIONS: ComposerOptions = {
  webSearch: false,
  reasoning: false,
  provider: "groq",
  model: "openai/gpt-oss-120b"
};

function splitDelta(delta: string) {
  return delta.match(/\S+\s*/g) ?? [delta];
}

export function ChatPage() {
  const { token } = useAuth();
  const { activeChat, createChat, openChat, refreshChats, setActiveChat } = useChat();
  const [messages, setMessages] = useState<Message[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Record<string, MessageReaction>>({});
  const [bookmarks, setBookmarks] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const deltaQueueRef = useRef<string[]>([]);
  const deltaTimerRef = useRef<number | null>(null);
  const deltaTargetRef = useRef<{ chatId: string; messageId: string } | null>(null);
  const deltaResolversRef = useRef<Array<() => void>>([]);
  const lastOptionsRef = useRef<ComposerOptions>(DEFAULT_OPTIONS);

  useEffect(() => {
    setMessages(activeChat?.messages ?? []);
  }, [activeChat]);

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
      if (deltaTimerRef.current) window.clearInterval(deltaTimerRef.current);
    };
  }, []);

  useAutoScroll(scrollRef, [messages, streamingMessageId]);

  const hasMessages = messages.length > 0;
  const activeTitle = useMemo(() => activeChat?.title ?? "New chat", [activeChat]);
  const selectedDocuments = useMemo(
    () => documents.filter((document) => selectedDocumentIds.includes(document.id)),
    [documents, selectedDocumentIds]
  );
  const visibleMessages = useMemo(
    () => (messages.length > 160 ? messages.slice(-160) : messages),
    [messages]
  );

  function syncActiveChatMessages(chatId: string, nextMessages: Message[]) {
    setActiveChat((current) =>
      current?.id === chatId ? { ...current, messages: nextMessages } : current
    );
  }

  function updateMessagesForChat(
    chatId: string,
    updater: (current: Message[]) => Message[]
  ) {
    setMessages((current) => {
      const nextMessages = updater(current);
      syncActiveChatMessages(chatId, nextMessages);
      return nextMessages;
    });
  }

  function resolveDeltaQueueIfIdle() {
    if (deltaQueueRef.current.length || deltaTimerRef.current) return;
    const resolvers = deltaResolversRef.current.splice(0);
    resolvers.forEach((resolve) => resolve());
  }

  function enqueueDelta(chatId: string, messageId: string, delta: string) {
    deltaTargetRef.current = { chatId, messageId };
    deltaQueueRef.current.push(...splitDelta(delta));
    if (deltaTimerRef.current) return;

    deltaTimerRef.current = window.setInterval(() => {
      const piece = deltaQueueRef.current.shift();
      const target = deltaTargetRef.current;
      if (piece && target) {
        updateMessagesForChat(target.chatId, (current) =>
          current.map((message) =>
            message.id === target.messageId
              ? { ...message, content: message.content + piece }
              : message
          )
        );
      }
      if (!deltaQueueRef.current.length && deltaTimerRef.current) {
        window.clearInterval(deltaTimerRef.current);
        deltaTimerRef.current = null;
        resolveDeltaQueueIfIdle();
      }
    }, 18);
  }

  function waitForDeltaDrain() {
    if (!deltaQueueRef.current.length && !deltaTimerRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      deltaResolversRef.current.push(resolve);
    });
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

  async function handleSend(text: string, options: ComposerOptions, imageFiles: File[] = []) {
    if (!token || streaming) return;
    lastOptionsRef.current = options;
    setStreaming(true);
    const chat = activeChat ?? (await createChat(text.slice(0, 60) || "New chat"));
    const displayText = imageFiles.length
      ? [text, imageFiles.map((file) => `[Image: ${file.name}]`).join("\n")].join("\n\n")
      : text;
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: displayText,
      created_at: new Date().toISOString()
    };
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      created_at: new Date().toISOString()
    };
    const optimisticMessages = [...messages, userMessage, assistantMessage];
    setMessages(optimisticMessages);
    setStreamingMessageId(assistantMessage.id);
    syncActiveChatMessages(chat.id, optimisticMessages);

    try {
      const imageContext = await analyzeImages(text, imageFiles);
      const modelMessage = imageContext
        ? `${text}\n\nAttached image context extracted by Auto-AI vision:\n${imageContext}`
        : text;
      let streamFailed = false;
      let persistedAssistantId: string | null = null;

      await streamChat(
        token,
        {
          message: modelMessage,
          chat_id: chat.id,
          provider: options.provider,
          model: options.model,
          web_search: options.webSearch,
          reasoning: options.reasoning,
          document_ids: selectedDocumentIds
        },
        (event) => {
          if (event.type === "delta") {
            enqueueDelta(chat.id, assistantMessage.id, event.delta);
          }
          if (event.type === "done") {
            persistedAssistantId = event.message_id;
          }
          if (event.type === "error") {
            streamFailed = true;
            updateMessagesForChat(chat.id, (current) =>
              current.map((message) =>
                message.id === assistantMessage.id ? { ...message, content: event.detail } : message
              )
            );
          }
        }
      );

      await waitForDeltaDrain();
      const finalAssistantId = persistedAssistantId;
      if (finalAssistantId) {
        updateMessagesForChat(chat.id, (current) =>
          current.map((message) =>
            message.id === assistantMessage.id ? { ...message, id: finalAssistantId } : message
          )
        );
      }
      if (!streamFailed) {
        await openChat(chat.id);
      }
      await refreshChats();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to stream response";
      updateMessagesForChat(chat.id, (current) =>
        current.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: `AI request failed: ${detail}` }
            : message
        )
      );
      await refreshChats();
    } finally {
      setStreaming(false);
      setStreamingMessageId(null);
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
    const text = `${activeTitle}\n\n${message.content}`;
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
    if (streaming) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const previousUser = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (!previousUser) return;
    await handleSend(previousUser.content, lastOptionsRef.current, []);
  }

  async function handleEdit(messageId: string) {
    if (streaming) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const message = messages[index];
    if (!message || message.role !== "user") return;
    const nextPrompt = window.prompt("Edit prompt", message.content);
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
    await handleSend(
      "Continue the previous response from where it stopped. Do not restart the answer.",
      lastOptionsRef.current,
      []
    );
  }

  return (
    <div className="chat-workspace">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center justify-between border-b border-white/10 bg-slate-950/70 px-4 text-white backdrop-blur-xl md:hidden">
          <button className="icon-button-dark" title="Menu">
            <Menu size={18} />
          </button>
          <span className="truncate text-sm font-medium">{activeTitle}</span>
          <button className="icon-button-dark" onClick={() => setActiveChat(null)} title="New chat">
            <MessageSquarePlus size={18} />
          </button>
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
                  isStreaming={message.id === streamingMessageId}
                  reaction={reactions[message.id]}
                  bookmarked={bookmarks[message.id]}
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
      />
    </div>
  );
}
