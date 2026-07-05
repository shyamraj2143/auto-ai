import { RefObject, useCallback, useEffect, useRef, useState } from "react";

export function useAutoScroll<T extends HTMLElement>(ref: RefObject<T>, deps: unknown[]) {
  const pinnedToBottomRef = useRef(true);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    pinnedToBottomRef.current = true;
    setIsPinnedToBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [ref]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const handleScroll = () => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottomRef.current = distanceFromBottom < 160;
      setIsPinnedToBottom(pinnedToBottomRef.current);
    };

    element.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => element.removeEventListener("scroll", handleScroll);
  }, [ref]);

  useEffect(() => {
    const element = ref.current;
    if (!element || !pinnedToBottomRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, deps);

  return { isPinnedToBottom, scrollToBottom };
}
