from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
CHAT = ROOT / "frontend" / "src" / "components" / "chat" / "ChatPage.tsx"
CSS = ROOT / "frontend" / "src" / "styles" / "chatResponseLayoutFix.css"
MAIN = ROOT / "frontend" / "src" / "main.tsx"

text = CHAT.read_text(encoding="utf-8")

# 1) Keep every generation poll alive instead of cancelling the previous request.
text = text.replace(
    '  const generationPollTimerRef = useRef<number | null>(null);',
    '  const generationPollTimersRef = useRef<Record<string, number>>({});',
)
text = text.replace(
    '      if (generationPollTimerRef.current) window.clearTimeout(generationPollTimerRef.current);',
    '      Object.values(generationPollTimersRef.current).forEach((timer) => window.clearTimeout(timer));\n      generationPollTimersRef.current = {};',
)

old_poll = '''  function stopGenerationPolling() {
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
'''
new_poll = '''  function stopGenerationPolling(generationId?: string) {
    if (generationId) {
      const timer = generationPollTimersRef.current[generationId];
      if (timer) window.clearTimeout(timer);
      delete generationPollTimersRef.current[generationId];
      return;
    }
    Object.values(generationPollTimersRef.current).forEach((timer) => window.clearTimeout(timer));
    generationPollTimersRef.current = {};
  }

  function startGenerationPolling(generationId: string) {
    stopGenerationPolling(generationId);
    const tick = async () => {
      const keepPolling = await pollGeneration(generationId);
      if (!keepPolling) {
        stopGenerationPolling(generationId);
        return;
      }
      const retryDelay = navigator.onLine === false ? 1800 : document.hidden ? 1200 : 280;
      generationPollTimersRef.current[generationId] = window.setTimeout(tick, retryDelay);
    };
    void tick();
  }
'''
if old_poll not in text:
    raise SystemExit("polling block not found")
text = text.replace(old_poll, new_poll, 1)

# 2) Do not reject a second send while another generation is running.
old_guard = '    if (!token || visibleChatBusy || (!trimmedText && !imageFiles.length && !selectedLibraryAttachments.length)) return false;'
new_guard = '    if (!token || (!trimmedText && !imageFiles.length && !selectedLibraryAttachments.length)) return false;'
if old_guard not in text:
    raise SystemExit("send guard not found")
text = text.replace(old_guard, new_guard, 1)

# 3) Make the user bubble optimistic before slow service/intent preflight calls.
anchor = '''  async function handleSend(text: string, options: ComposerOptions, imageFiles: File[] = []) {
    const trimmedText = text.trim();
    if (!token || (!trimmedText && !imageFiles.length && !selectedLibraryAttachments.length)) return false;
    if (trimmedText) {
'''
replacement = '''  async function handleSend(text: string, options: ComposerOptions, imageFiles: File[] = []) {
    const trimmedText = text.trim();
    if (!token || (!trimmedText && !imageFiles.length && !selectedLibraryAttachments.length)) return false;

    const preflightClientMessageId = crypto.randomUUID();
    const preflightRequestId = crypto.randomUUID();
    const preflightAssistantId = `local-assistant-${preflightClientMessageId}`;
    const preflightUserId = `local-user-${preflightClientMessageId}`;
    activeRequestRef.current = {
      requestId: preflightRequestId,
      assistantId: preflightAssistantId,
      chatId: activeChat?.id,
      clientMessageId: preflightClientMessageId
    };
    const immediateUser: Message = {
      id: preflightUserId,
      role: "user",
      content: trimmedText,
      message_metadata: { client_message_id: preflightClientMessageId },
      created_at: nowIso()
    };
    const immediateMessages = appendOptimisticMessages(messagesRef.current, [immediateUser]);
    messagesRef.current = immediateMessages;
    setMessages(immediateMessages);
    if (activeChat?.id) syncActiveChatMessages(activeChat.id, immediateMessages);
    window.requestAnimationFrame(scrollToBottom);

    if (trimmedText) {
'''
if anchor not in text:
    raise SystemExit("handleSend anchor not found")
text = text.replace(anchor, replacement, 1)

# 4) Reuse the same client/user IDs for the eventual generation so the server response
#    upserts the already-visible bubble instead of creating a duplicate.
old_request_ids = '''      clientMessageId: crypto.randomUUID(),
      userMessageId: "",
      documentIds,
      libraryAssetIds: selectedLibraryAttachments.map((item) => item.asset_id),
      requestId: crypto.randomUUID()
    };
    const assistantId = `local-assistant-${request.clientMessageId}`;
    const userId = `local-user-${request.clientMessageId}`;
    request.userMessageId = userId;
'''
new_request_ids = '''      clientMessageId: preflightClientMessageId,
      userMessageId: preflightUserId,
      documentIds,
      libraryAssetIds: selectedLibraryAttachments.map((item) => item.asset_id),
      requestId: preflightRequestId
    };
    const assistantId = preflightAssistantId;
    const userId = preflightUserId;
    request.userMessageId = userId;
'''
if old_request_ids not in text:
    raise SystemExit("request id block not found")
text = text.replace(old_request_ids, new_request_ids, 1)

# The request object is now created after the preflight branches, so avoid replacing
# the already-visible user message with a second local copy before generation starts.
old_local_append = '''    const nextLocalMessages = appendOptimisticMessages(messagesRef.current, pendingMessages);
    messagesRef.current = nextLocalMessages;
    setMessages(nextLocalMessages);
    if (activeChat?.id) syncActiveChatMessages(activeChat.id, nextLocalMessages);
'''
new_local_append = '''    const nextLocalMessages = appendOptimisticMessages(messagesRef.current, pendingMessages);
    messagesRef.current = nextLocalMessages;
    setMessages(nextLocalMessages);
    if (activeChat?.id) syncActiveChatMessages(activeChat.id, nextLocalMessages);
'''
# Keep this explicit replacement as a safety assertion; the upsert is intentionally retained.
if old_local_append not in text:
    raise SystemExit("local append block not found")

# Clear the preflight request when a non-generation path handled the message.
text = text.replace(
    '          window.requestAnimationFrame(scrollToBottom);\n          return true;\n        }\n      } catch (error) {',
    '          window.requestAnimationFrame(scrollToBottom);\n          activeRequestRef.current = null;\n          return true;\n        }\n      } catch (error) {',
    1,
)
text = text.replace(
    '          messagesRef.current=next;setMessages(next);if(activeChat?.id)syncActiveChatMessages(activeChat.id,next);window.requestAnimationFrame(scrollToBottom);return true;',
    '          messagesRef.current=next;setMessages(next);if(activeChat?.id)syncActiveChatMessages(activeChat.id,next);window.requestAnimationFrame(scrollToBottom);activeRequestRef.current=null;return true;',
    1,
)
text = text.replace(
    '      return true;\n    }\n    const documentIds = settings.memoryEnabled',
    '      activeRequestRef.current = null;\n      return true;\n    }\n    const documentIds = settings.memoryEnabled',
    1,
)

# 5) A generation snapshot is valid even when another request is currently active.
old_snapshot_guard = '    if (!isGenerationForActiveRequest(generation, activeRequestRef.current)) return;\n'
if old_snapshot_guard not in text:
    raise SystemExit("generation guard not found")
text = text.replace(old_snapshot_guard, '', 1)

# Do not let completion of request A clear the tracking identity of request B.
text = text.replace(
    '      if (activeRequestRef.current?.chatId === generation.chat_id) activeRequestRef.current = null;',
    '      if (activeRequestRef.current?.chatId === generation.chat_id && activeRequestRef.current.clientMessageId === generationClientMessageId(generation)) activeRequestRef.current = null;',
    1,
)

# Add the generation client id helper locally without changing shared state APIs.
needle = '  function applyGenerationSnapshot(generation: ChatGeneration) {\n'
insert = '''  function generationClientId(generation: ChatGeneration) {
    return clientMessageIdOf(generation.user_message) || clientMessageIdOf(generation.assistant_message);
  }

'''
if needle not in text:
    raise SystemExit("snapshot function not found")
text = text.replace(needle, insert + needle, 1)
text = text.replace('generationClientMessageId(generation)', 'generationClientId(generation)', 1)

# Recover every active generation after app resume, not just the newest one.
old_recover = '''      const generation = generations[0];
      if (!generation) {
        if (activeGenerationRef.current && isRunningGenerationStatus(activeGenerationRef.current.status)) {
          setStreaming(false);
          setSubmittingGeneration(false);
          setStreamingMessageId(null);
          setSearchingMessageId(null);
          setActiveGeneration(null);
          setRequestState("idle");
        }
        if (activeChatRef.current?.id) {
          await openChat(activeChatRef.current.id);
        }
        return;
      }
      applyGenerationSnapshot(generation);
      startGenerationPolling(generation.id);
'''
new_recover = '''      if (!generations.length) {
        if (activeGenerationRef.current && isRunningGenerationStatus(activeGenerationRef.current.status)) {
          setStreaming(false);
          setSubmittingGeneration(false);
          setStreamingMessageId(null);
          setSearchingMessageId(null);
          setActiveGeneration(null);
          setRequestState("idle");
        }
        if (activeChatRef.current?.id) await openChat(activeChatRef.current.id);
        return;
      }
      generations.forEach((generation) => {
        applyGenerationSnapshot(generation);
        startGenerationPolling(generation.id);
      });
'''
if old_recover not in text:
    raise SystemExit("recovery block not found")
text = text.replace(old_recover, new_recover, 1)

CHAT.write_text(text, encoding="utf-8")

CSS.write_text('''/* Prevent response audit/status chips from covering the composer on mobile. */\n.response-audit {\n  position: relative !important;\n  inset: auto !important;\n  width: min(100%, 720px) !important;\n  max-width: 100% !important;\n  margin: 8px auto 12px !important;\n  z-index: 3 !important;\n  pointer-events: auto;\n}\n\n.response-audit-trigger {\n  max-width: 100%;\n  min-height: 36px;\n}\n\n.response-audit-log {\n  max-width: 100%;\n  max-height: min(48vh, 420px);\n  overflow: auto;\n}\n\n@media (max-width: 768px) {\n  .response-audit {\n    margin: 6px 0 10px !important;\n  }\n  .response-audit-trigger {\n    width: 100%;\n    min-height: 34px;\n  }\n}\n''', encoding="utf-8")

main = MAIN.read_text(encoding="utf-8")
import_line = 'import "./styles/chatResponseLayoutFix.css";\n'
if import_line not in main:
    marker = 'import "./styles/modelActivityVisibilityFix.css";\n'
    if marker not in main:
        raise SystemExit("main css import marker not found")
    main = main.replace(marker, marker + import_line, 1)
    MAIN.write_text(main, encoding="utf-8")

print("Applied chat latency/concurrency and response layout fixes.")
