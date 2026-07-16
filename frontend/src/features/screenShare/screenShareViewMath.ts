export type ScreenShareViewMode = "fit" | "fill" | "actual";

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function constrainScreenSharePan(
  x: number,
  y: number,
  zoom: number,
  box: { width: number; height: number } | null,
) {
  if (!box || zoom <= 1) return { x: 0, y: 0 };
  const limitX = (box.width * (zoom - 1)) / 2;
  const limitY = (box.height * (zoom - 1)) / 2;
  return {
    x: clamp(x, -limitX, limitX),
    y: clamp(y, -limitY, limitY),
  };
}

export function screenShareVideoStyle(
  mode: ScreenShareViewMode,
  naturalSize: { width: number; height: number },
) {
  if (mode === "actual" && naturalSize.width && naturalSize.height) {
    return {
      width: `${naturalSize.width}px`,
      height: `${naturalSize.height}px`,
      objectFit: "contain" as const,
    };
  }
  return {
    width: "100%",
    height: "100%",
    objectFit: mode === "fill" ? "cover" as const : "contain" as const,
  };
}

export function containSize(source: { width: number; height: number }, container: { width: number; height: number }) {
  if (!source.width || !source.height || !container.width || !container.height) return { width: 0, height: 0 };
  const ratio = Math.min(container.width / source.width, container.height / source.height);
  return {
    width: source.width * ratio,
    height: source.height * ratio,
  };
}

export function coverSize(source: { width: number; height: number }, container: { width: number; height: number }) {
  if (!source.width || !source.height || !container.width || !container.height) return { width: 0, height: 0 };
  const ratio = Math.max(container.width / source.width, container.height / source.height);
  return {
    width: source.width * ratio,
    height: source.height * ratio,
  };
}
