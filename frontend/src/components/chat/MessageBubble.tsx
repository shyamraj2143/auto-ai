import { memo, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  FileText,
  ImageIcon,
  RefreshCw,
  Share2,
  Search,
  User
} from "lucide-react";
import { motion } from "framer-motion";
import clsx from "clsx";
import type { ChatAttachment, Message, ResponseModelInfo } from "../../types";
import { coerceTextContent } from "../../utils/text";
import { MarkdownMessage } from "./MarkdownMessage";
import { SourceCards } from "./SourceCards";
import { ResponseGeneratedBy } from "./ResponseGeneratedBy";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useMotionMode } from "../../motion/MotionProvider";
import { StreamingPulse } from "../../motion/primitives";
import { formatMessageDateTimeTitle, formatMessageTime, normalizedApiTimestamp } from "../../utils/dateTime";

const THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>\s*/gi;
const OPEN_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*$/i;

function stripThinkBlocks(value: string) {
  return value.replace(THINK_BLOCK_PATTERN, "").replace(OPEN_THINK_BLOCK_PATTERN, "").trim();
}

function useTypingContent(content: string, enabled: boolean) {
  const [displayed, setDisplayed] = useState(content);

  useEffect(() => {
    if (!enabled) {
      setDisplayed(content);
      return;
    }

    setDisplayed((current) => (content.startsWith(current) ? current : ""));
    const timer = window.setInterval(() => {
      setDisplayed((current) => {
        if (current === content) {
          window.clearInterval(timer);
          return current;
        }
        if (!content.startsWith(current)) {
          return content.slice(0, Math.min(content.length, 4));
        }
        const remaining = content.length - current.length;
        const step = remaining > 120 ? 8 : remaining > 40 ? 4 : 2;
        return content.slice(0, current.length + step);
      });
    }, 18);

    return () => window.clearInterval(timer);
  }, [content, enabled]);

  return displayed;
}

function attachmentsOf(message: Message): ChatAttachment[] {
  return Array.isArray(message.message_metadata?.attachments)
    ? message.message_metadata.attachments
    : [];
}

function formatBytes(size?: number | null) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function thinkingCopy(phase?: string) {
  if (phase === "analyzing_image") {
    return { label: "Analyzing image", subtitle: "Reading the attachment without adding hidden notes to chat." };
  }
  if (phase === "reading_file") {
    return { label: "Reading file", subtitle: "Using the attached file context for this answer." };
  }
  if (phase === "researching" || phase === "searching") {
    return { label: "Researching", subtitle: "Checking current sources before answering." };
  }
  return { label: "Thinking", subtitle: "Crafting a response with the current context." };
}

function responseErrorText(value?: string) {
  const detail = (value || "").trim();
  if (/network|interrupted|offline|timeout|failed to fetch|connection/i.test(detail)) {
    return "Network interrupted. Your message was saved. Retry response.";
  }
  if (detail) {
    return `Response failed: ${detail}`;
  }
  return "Response interrupted. Your message was saved. Retry response.";
}

export function formatMessageTimestamp(value: string, now = new Date()) {
  void now;
  return formatMessageTime(value);
}

function AttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="message-attachments not-prose">
      {attachments.map((attachment) => {
        const source = attachment.preview_url || attachment.url || "";
        const detail = [attachment.mime_type, formatBytes(attachment.file_size), attachment.status]
          .filter(Boolean)
          .join(" / ");
        return (
          <div key={attachment.id} className="message-attachment">
            {attachment.type === "image" ? (
              source ? (
                <img className="message-image-attachment" src={source} alt={attachment.filename} loading="lazy" />
              ) : (
                <span className="message-attachment-icon"><ImageIcon size={18} /></span>
              )
            ) : (
              <span className="message-attachment-icon"><FileText size={18} /></span>
            )}
            <span className="min-w-0">
              <span className="message-attachment-name">{attachment.filename}</span>
              {detail && <span className="message-attachment-detail">{detail}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MessageBubbleComponent({
  message,
  isStreaming,
  isSearchingWeb,
  onRegenerate,
  onShare,
  fallbackModel
}: {
  message: Message;
  isStreaming?: boolean;
  isSearchingWeb?: boolean;
  fallbackModel?: ResponseModelInfo | null;
  onRegenerate: (messageId: string) => void;
  onShare: (messageId: string) => void;
}) {
  const isAssistant = message.role === "assistant";
  const { enabled, reduceMotion } = useMotionMode();
  const [copied, setCopied] = useState(false);
  const rawContent = coerceTextContent(message.content);
  const content = useMemo(
    () => (isAssistant ? stripThinkBlocks(rawContent) : rawContent),
    [isAssistant, rawContent]
  );
  const visibleContent = useTypingContent(content, isAssistant && Boolean(isStreaming));
  const streamingMetadata = message.message_metadata?.streaming as
    | { status?: string; phase?: string; error?: string; error_detail?: string }
    | undefined;
  const isFailedAssistant = isAssistant && streamingMetadata?.status === "failed" && !content.trim();
  const attachments = attachmentsOf(message);
  const isEmptyStreaming = isAssistant && isStreaming && !content && !isSearchingWeb && !isFailedAssistant;
  const search = message.message_metadata?.search;
  const orchestrationAudit =
    message.message_metadata?.orchestration ?? message.message_metadata?.deep_research;
  const normalizedTimestamp = normalizedApiTimestamp(message.created_at);
  void fallbackModel;

  function copyMessage() {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    });
  }

  return (
    <motion.article
      initial={enabled && !reduceMotion ? { opacity: 0, y: isAssistant ? 10 : 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: isAssistant ? 0.24 : 0.18 }}
      className={clsx("message-row group", isAssistant ? "message-row-assistant" : "message-row-user")}
    >
      <div className={clsx("message-avatar", isAssistant ? "message-avatar-ai" : "message-avatar-user")}>
        {isAssistant ? <Bot size={18} /> : <User size={18} />}
      </div>
      <div className="message-content-stack">
      <div className={clsx("message-card", isAssistant ? "message-card-ai" : "message-card-user")}>
        {isEmptyStreaming ? (
          <ThinkingIndicator {...thinkingCopy(streamingMetadata?.phase)} />
        ) : isFailedAssistant ? (
          <div className="message-error-panel">
            <AlertCircle size={18} />
            <span className="min-w-0 flex-1">{responseErrorText(streamingMetadata?.error || streamingMetadata?.error_detail)}</span>
            <button className="generation-action" onClick={() => onRegenerate(message.id)} type="button">
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        ) : (
          <>
            {!isAssistant && <AttachmentList attachments={attachments} />}
            {(visibleContent.trim() || isAssistant || isSearchingWeb) && (
              <div className="prose prose-slate max-w-none dark:prose-invert prose-pre:m-0 prose-pre:bg-transparent">
                {isSearchingWeb && (
                  <div className="searching-web-indicator not-prose">
                    <Search size={15} className="animate-spin" />
                    Searching the web...
                  </div>
                )}
                {isAssistant && isStreaming ? (
                  <div className="streaming-plain-text">
                    {visibleContent}
                    <StreamingPulse active={isStreaming} />
                  </div>
                ) : (
                  <MarkdownMessage content={visibleContent} />
                )}
                {isAssistant && isStreaming && <span className="typing-cursor" aria-hidden="true" />}
              </div>
            )}
          </>
        )}
        {isAssistant && <SourceCards search={search} />}
        {isAssistant && !isStreaming && <ResponseGeneratedBy audit={orchestrationAudit} />}
        {normalizedTimestamp && (
          <time className="message-timestamp" dateTime={normalizedTimestamp} title={formatMessageDateTimeTitle(message.created_at)}>
            {formatMessageTimestamp(message.created_at)}
          </time>
        )}
      </div>

        {!isEmptyStreaming && !isFailedAssistant && (
          <div className="message-actions">
            <button className="message-action" onClick={copyMessage} title="Copy message" aria-label="Copy message" type="button">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            {isAssistant && (
              <>
                <button className="message-action" onClick={() => onShare(message.id)} title="Share message" aria-label="Share response" type="button">
                  <Share2 size={15} />
                </button>
                <button className="message-action" onClick={() => onRegenerate(message.id)} title="Regenerate response" aria-label="Regenerate response" type="button">
                  <RefreshCw size={15} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </motion.article>
  );
}

export const MessageBubble = memo(MessageBubbleComponent, (previous, next) => {
  return (
    previous.message === next.message &&
    previous.isStreaming === next.isStreaming &&
    previous.isSearchingWeb === next.isSearchingWeb &&
    previous.fallbackModel === next.fallbackModel
  );
});
