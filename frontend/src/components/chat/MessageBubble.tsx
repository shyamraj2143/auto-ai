import {
  Bookmark,
  BookmarkCheck,
  Bot,
  Copy,
  CornerDownRight,
  Pencil,
  RefreshCw,
  Share2,
  ThumbsDown,
  ThumbsUp,
  User,
  Volume2
} from "lucide-react";
import { motion } from "framer-motion";
import clsx from "clsx";
import type { Message } from "../../types";
import { MarkdownMessage } from "./MarkdownMessage";
import { ThinkingIndicator } from "./ThinkingIndicator";

export type MessageReaction = "up" | "down" | null;

export function MessageBubble({
  message,
  isStreaming,
  reaction,
  bookmarked,
  onReact,
  onRegenerate,
  onEdit,
  onContinue,
  onBookmark,
  onShare
}: {
  message: Message;
  isStreaming?: boolean;
  reaction?: MessageReaction;
  bookmarked?: boolean;
  onReact: (messageId: string, reaction: MessageReaction) => void;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onContinue: (messageId: string) => void;
  onBookmark: (messageId: string) => void;
  onShare: (messageId: string) => void;
}) {
  const isAssistant = message.role === "assistant";
  const isEmptyStreaming = isAssistant && isStreaming && !message.content;

  function copyMessage() {
    navigator.clipboard.writeText(message.content);
  }

  function speakMessage() {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message.content);
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
            <MarkdownMessage content={message.content} />
            {isAssistant && isStreaming && <span className="typing-cursor" aria-hidden="true" />}
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
