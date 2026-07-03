import {
  Bookmark,
  BookmarkCheck,
  Bot,
  Copy,
  CornerDownRight,
  Cpu,
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
import type { Message, ResponseModelInfo } from "../../types";
import { coerceTextContent } from "../../utils/text";
import { MarkdownMessage } from "./MarkdownMessage";
import { SourceCards } from "./SourceCards";
import { ThinkingIndicator } from "./ThinkingIndicator";

export type MessageReaction = "up" | "down" | null;

const THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>\s*/gi;
const OPEN_THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*$/i;

function stripThinkBlocks(value: string) {
  return value.replace(THINK_BLOCK_PATTERN, "").replace(OPEN_THINK_BLOCK_PATTERN, "").trim();
}

export function MessageBubble({
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
  const rawContent = coerceTextContent(message.content);
  const content = isAssistant ? stripThinkBlocks(rawContent) : rawContent;
  const isEmptyStreaming = isAssistant && isStreaming && !content && !isSearchingWeb;
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
    navigator.clipboard.writeText(content);
  }

  function speakMessage() {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24 }}
      className={clsx("message-row group", isAssistant ? "message-row-assistant" : "message-row-user")}
    >
      <div className={clsx("message-avatar", isAssistant ? "message-avatar-ai" : "message-avatar-user")}>
        {isAssistant ? <Bot size={18} /> : <User size={18} />}
      </div>
      <div className={clsx("message-card", isAssistant ? "message-card-ai" : "message-card-user")}>
        {isEmptyStreaming ? (
          <ThinkingIndicator />
        ) : (
          <div className="prose prose-slate max-w-none dark:prose-invert prose-pre:m-0 prose-pre:bg-transparent">
            {isSearchingWeb && (
              <div className="searching-web-indicator not-prose">
                <Search size={15} className="animate-spin" />
                Searching the web...
              </div>
            )}
            <MarkdownMessage content={content} />
            {isAssistant && isStreaming && <span className="typing-cursor" aria-hidden="true" />}
          </div>
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

        {!isEmptyStreaming && (
          <div className="message-actions">
            <button className="message-action" onClick={copyMessage} title="Copy message">
              <Copy size={15} />
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
