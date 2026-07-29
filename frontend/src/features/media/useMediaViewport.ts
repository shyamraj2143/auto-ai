import { useEffect, useMemo, useState, type RefObject } from "react";
import { calculateMediaLayout, type MediaContentType, type MediaViewMode } from "./mediaLayout";

export function useMediaViewport(
  containerRef: RefObject<HTMLElement | null>,
  source: { width: number; height: number },
  contentType: MediaContentType,
  preferredMode: MediaViewMode,
) {
  const [container, setContainer] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setContainer({ width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return () => observer.disconnect();
  }, [containerRef]);

  return useMemo(() => calculateMediaLayout({
    sourceWidth: source.width,
    sourceHeight: source.height,
    containerWidth: container.width,
    containerHeight: container.height,
    contentType,
    preferredMode,
  }), [container.height, container.width, contentType, preferredMode, source.height, source.width]);
}
