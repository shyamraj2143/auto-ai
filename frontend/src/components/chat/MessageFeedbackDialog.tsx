import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageFeedbackReason } from "../../types";

const REASONS: Array<{ value: MessageFeedbackReason; label: string }> = [
  { value: "incorrect", label: "Incorrect" },
  { value: "not_helpful", label: "Not helpful" },
  { value: "outdated", label: "Outdated information" },
  { value: "ignored_instructions", label: "Did not follow instructions" },
  { value: "poor_writing", label: "Poor writing style" },
  { value: "unsafe", label: "Unsafe or inappropriate" },
  { value: "other", label: "Other" }
];

export function MessageFeedbackDialog({
  open,
  busy,
  initialReason,
  initialComment,
  returnFocusRef,
  onCancel,
  onSubmit
}: {
  open: boolean;
  busy: boolean;
  initialReason?: MessageFeedbackReason | null;
  initialComment?: string | null;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onSubmit: (reason: MessageFeedbackReason, comment: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState<MessageFeedbackReason>(initialReason || "not_helpful");
  const [comment, setComment] = useState(initialComment || "");

  useEffect(() => {
    if (!open) return;
    setReason(initialReason || "not_helpful");
    setComment(initialComment || "");
    const timer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled), textarea")?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        returnFocusRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled)")
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [initialComment, initialReason, onCancel, open, returnFocusRef]);

  if (!open) return null;
  return createPortal(
    <div
      className="message-feedback-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="message-feedback-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
      >
        <div>
          <h2 id="feedback-dialog-title">What could be better?</h2>
          <p>Your feedback improves responses only for your account preferences.</p>
        </div>
        <div className="message-feedback-reasons">
          {REASONS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={reason === item.value ? "is-selected" : ""}
              aria-pressed={reason === item.value}
              onClick={() => setReason(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <textarea
          value={comment}
          maxLength={500}
          rows={3}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Optional detail"
          aria-label="Optional feedback detail"
        />
        <small>{comment.length}/500</small>
        <div className="message-feedback-dialog-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => onSubmit(reason, comment)} disabled={busy}>
            {busy ? "Saving" : "Submit"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
