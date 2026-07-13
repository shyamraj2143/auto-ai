import { memo, useMemo, useState } from "react";
import {
  AlertCircle,
  Bookmark,
  BookmarkCheck,
  Bot,
  Check,
  Copy,
  CornerDownRight,
  Cpu,
  FileText,
  ImageIcon,
  Pencil,
  RefreshCw,
  Share2,
  Search,
  ThumbsDown,
  ThumbsUp,
  User,
  Volume2
} from "lucide-react";
import { motion } from "framer-motion";
import clsx from "clsx";
import type { ChatAttachment, Message, ResponseModelInfo } from "../../types";
import { coerceTextContent } from "../../utils/text";
import { MarkdownMessage } from "./MarkdownMessage";
import { SourceCards } from "./SourceCards";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useMotionMode } from "../../motion/MotionProvider";
import { StreamingPulse } from "../../motion/primitives";

export type MessageReaction = "up" | "down" | null;

const THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>\s*/gi;
const OPEN_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*$/i;

function stripThinkBlocks(value: string) {
  return value.replace(THINK_BLOCK_PATTERN, "").replace(OPEN_THINK_BLOCK_PATTERN, "").trim();
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
  const detail = value || "";
  if (/network|interrupted|offline|timeout|failed to fetch|connection/i.test(detail)) {
    return "Network interrupted. Your message was saved. Retry response.";
  }
  return "Response interrupted. Your message was saved. Retry response.";
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
  reaction,
  bookmarked,
  onReact,
  onRegenerate,
  onEdit,
  onContinue,
  onBookmark,
  onShare,
  fallbackModel
}: {
  message: Message;
  isStreaming?: boolean;
  isSearchingWeb?: boolean;
  reaction?: MessageReaction;
  bookmarked?: boolean;
  fallbackModel?: ResponseModelInfo | null;
  onReact: (messageId: string, reaction: MessageReaction) => void;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onContinue: (messageId: string) => void;
  onBookmark: (messageId: string) => void;
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
  const streamingMetadata = message.message_metadata?.streaming as
    | { status?: string; phase?: string; error?: string; error_detail?: string }
    | undefined;
  const isFailedAssistant = isAssistant && streamingMetadata?.status === "failed" && !content.trim();
  const attachments = attachmentsOf(message);
  const isEmptyStreaming = isAssistant && isStreaming && !content && !isSearchingWeb && !isFailedAssistant;
  const search = message.message_metadata?.search;
  const responseModel = message.message_metadata?.model ?? fallbackModel ?? undefined;
  const deepResearch = message.message_metadata?.deep_research as
    | { models_consulted?: Array<{ provider?: string; model?: string }>; confidence?: string }
    | undefined;
  const consultedModels = deepResearch?.models_consulted ?? [];
  const responseModelLabel = responseModel
    ? `${responseModel.provider_label || responseModel.provider} / ${responseModel.model}`
    : "";

  function copyMessage() {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    });
  }

  function speakMessage() {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
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
            {(content.trim() || isAssistant || isSearchingWeb) && (
              <div className="prose prose-slate max-w-none dark:prose-invert prose-pre:m-0 prose-pre:bg-transparent">
                {isSearchingWeb && (
                  <div className="searching-web-indicator not-prose">
                    <Search size={15} className="animate-spin" />
                    Searching the web...
                  </div>
                )}
                {isAssistant && isStreaming ? (
                  <div className="streaming-plain-text">
                    {content}
                    <StreamingPulse active={isStreaming} />
                  </div>
                ) : (
                  <MarkdownMessage content={content} />
                )}
                {isAssistant && isStreaming && <span className="typing-cursor" aria-hidden="true" />}
              </div>
            )}
          </>
        )}
        {isAssistant && <SourceCards search={search} />}
        {isAssistant && consultedModels.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="rounded-md border border-cyan-200/15 bg-cyan-200/10 px-2 py-1 font-semibold text-cyan-100">
              Multi-model
            </span>
            <span>{consultedModels.length} models consulted</span>
            {deepResearch?.confidence && <span>Confidence: {deepResearch.confidence}</span>}
          </div>
        )}
        {isAssistant && responseModelLabel && (
          <div className="message-model-corner" title={`Responded by ${responseModelLabel}`}>
            <Cpu size={13} />
            <span>{responseModelLabel}</span>
          </div>
        )}

        {!isEmptyStreaming && !isFailedAssistant && (
          <div className="message-actions">
            <button className="message-action" onClick={copyMessage} title="Copy message">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <button
              className={clsx("message-action", reaction === "up" && "message-action-active")}
              onClick={() => onReact(message.id, reaction === "up" ? null : "up")}
              title="Good response"
            >
              <ThumbsUp size={15} />
            </button>
            <button
              className={clsx("message-action", reaction === "down" && "message-action-active")}
              onClick={() => onReact(message.id, reaction === "down" ? null : "down")}
              title="Poor response"
            >
              <ThumbsDown size={15} />
            </button>
            <button className="message-action" onClick={() => onBookmark(message.id)} title="Bookmark message">
              {bookmarked ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
            </button>
            <button className="message-action" onClick={() => onShare(message.id)} title="Share message">
              <Share2 size={15} />
            </button>
            {isAssistant ? (
              <>
                <button className="message-action" onClick={speakMessage} title="Read aloud">
                  <Volume2 size={15} />
                </button>
                <button className="message-action" onClick={() => onRegenerate(message.id)} title="Regenerate response">
                  <RefreshCw size={15} />
                </button>
                <button className="message-action" onClick={() => onContinue(message.id)} title="Continue response">
                  <CornerDownRight size={15} />
                </button>
              </>
            ) : (
              <button className="message-action" onClick={() => onEdit(message.id)} title="Edit prompt">
                <Pencil size={15} />
              </button>
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
    previous.reaction === next.reaction &&
    previous.bookmarked === next.bookmarked &&
    previous.fallbackModel === next.fallbackModel
  );
});
