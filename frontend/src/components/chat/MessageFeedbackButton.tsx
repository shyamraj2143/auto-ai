import { LoaderCircle, ThumbsDown, ThumbsUp } from "lucide-react";
import { forwardRef } from "react";
import { MessageActionButton } from "./MessageActionButton";

export const MessageFeedbackButton = forwardRef<HTMLButtonElement, {
  value: "like" | "dislike";
  active: boolean;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}>(function MessageFeedbackButton({
  value,
  active,
  disabled,
  loading,
  onClick
}, ref) {
  const positive = value === "like";
  return (
    <MessageActionButton
      label={positive ? "Like response" : "Dislike response"}
      icon={loading ? LoaderCircle : positive ? ThumbsUp : ThumbsDown}
      active={active}
      pressed={active}
      disabled={disabled}
      loading={loading}
      tone={positive ? "positive" : "negative"}
      onClick={onClick}
      ref={ref}
    />
  );
});
