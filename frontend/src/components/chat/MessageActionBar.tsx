import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, RefreshCw, Share2 } from "lucide-react";
import { api } from "../../api/client";
import type { Message, MessageFeedback, MessageFeedbackReason } from "../../types";
import { MessageActionButton } from "./MessageActionButton";
import { MessageFeedbackButton } from "./MessageFeedbackButton";
import { MessageFeedbackDialog } from "./MessageFeedbackDialog";

export const ASSISTANT_ACTION_ORDER = ["Copy", "Like", "Dislike", "Share", "Regenerate"] as const;

export function nextFeedbackRating(current: 1 | -1 | null, requested: 1 | -1): 1 | -1 | null {
  return current === requested ? null : requested;
}

export function MessageActionBar({
  message,
  chatId,
  token,
  content,
  isStreaming,
  onFeedbackChange,
  onShare,
  onRegenerate
}: {
  message: Message;
  chatId?: string | null;
  token?: string | null;
  content: string;
  isStreaming: boolean;
  onFeedbackChange: (messageId: string, feedback: MessageFeedback | null) => void;
  onShare: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
}) {
  const isAssistant = message.role === "assistant";
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<MessageFeedback | null>(message.feedback ?? null);
  const [busyRating, setBusyRating] = useState<1 | -1 | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const dislikeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setFeedback(message.feedback ?? null), [message.feedback]);

  const persist = useCallback(async (
    nextRating: 1 | -1 | null,
    reason?: MessageFeedbackReason | null,
    comment?: string | null
  ) => {
    if (!chatId || !token || busyRating !== null) return;
    const previous = feedback;
    const optimistic = nextRating === null
      ? null
      : {
          message_id: message.id,
          rating: nextRating,
          reason: reason ?? null,
          comment: comment?.trim() || null,
          updated_at: new Date().toISOString()
        };
    setFeedback(optimistic);
    onFeedbackChange(message.id, optimistic);
    setBusyRating(nextRating ?? previous?.rating ?? null);
    setError("");
    try {
      const saved = nextRating === null
        ? (await api.deleteMessageFeedback(token, chatId, message.id), null)
        : await api.putMessageFeedback(token, chatId, message.id, {
            rating: nextRating,
            reason: nextRating === -1 ? reason : null,
            comment: comment?.trim() || null
          });
      setFeedback(saved);
      onFeedbackChange(message.id, saved);
      setDialogOpen(false);
    } catch {
      setFeedback(previous);
      onFeedbackChange(message.id, previous);
      setError("Feedback was not saved. Try again.");
    } finally {
      setBusyRating(null);
    }
  }, [busyRating, chatId, feedback, message.id, onFeedbackChange, token]);

  function copyMessage() {
    if (!content.trim()) return;
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    });
  }

  const disabled = isStreaming || !chatId || !token;
  return (
    <>
      <div className="message-actions" aria-label={isAssistant ? "Assistant message actions" : "User message actions"}>
        <MessageActionButton
          label={copied ? "Copied" : "Copy message"}
          icon={copied ? Check : Copy}
          active={copied}
          tone={copied ? "positive" : undefined}
          disabled={!content.trim()}
          onClick={copyMessage}
        />
        {isAssistant && (
          <>
            <MessageFeedbackButton
              value="like"
              active={feedback?.rating === 1}
              disabled={disabled}
              loading={busyRating === 1}
              onClick={() => void persist(nextFeedbackRating(feedback?.rating ?? null, 1))}
            />
            <MessageFeedbackButton
              ref={dislikeRef}
              value="dislike"
              active={feedback?.rating === -1}
              disabled={disabled}
              loading={busyRating === -1}
              onClick={() => {
                if (feedback?.rating === -1) void persist(null);
                else setDialogOpen(true);
              }}
            />
            <MessageActionButton
              label="Share response"
              icon={Share2}
              disabled={isStreaming}
              onClick={() => onShare(message.id)}
            />
            <MessageActionButton
              label="Regenerate response"
              icon={isStreaming ? LoaderCircle : RefreshCw}
              disabled={isStreaming}
              loading={isStreaming}
              onClick={() => onRegenerate(message.id)}
            />
          </>
        )}
      </div>
      {error && <div className="message-feedback-error" role="status">{error}</div>}
      <MessageFeedbackDialog
        open={dialogOpen}
        busy={busyRating !== null}
        initialReason={feedback?.rating === -1 ? feedback.reason : null}
        initialComment={feedback?.rating === -1 ? feedback.comment : null}
        returnFocusRef={dislikeRef}
        onCancel={() => setDialogOpen(false)}
        onSubmit={(reason, comment) => void persist(-1, reason, comment)}
      />
    </>
  );
}
