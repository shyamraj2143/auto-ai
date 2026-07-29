export type MediaContentType = "video-call" | "screen-share";
export type MediaViewMode = "fit" | "fill" | "actual";
export type MediaDeviceType = "mobile" | "tablet" | "desktop";
export type MediaOrientation = "portrait" | "landscape" | "square" | "unknown";

export type MediaLayoutInput = {
  sourceWidth: number;
  sourceHeight: number;
  containerWidth: number;
  containerHeight: number;
  contentType: MediaContentType;
  preferredMode: MediaViewMode;
  deviceType?: MediaDeviceType;
  orientation?: "portrait" | "landscape";
};

export type MediaLayout = {
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
  sourceAspectRatio: number;
  containerAspectRatio: number;
  sourceOrientation: MediaOrientation;
  deviceType: MediaDeviceType;
  objectFit: "contain" | "cover" | "none";
  maxWidth: number;
  maxHeight: number;
  safeControlInsets: { top: number; right: number; bottom: number; left: number };
};

const valid = (value: number) => Number.isFinite(value) && value > 0;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function classifyMediaOrientation(width: number, height: number): MediaOrientation {
  if (!valid(width) || !valid(height)) return "unknown";
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.04) return "square";
  return ratio < 1 ? "portrait" : "landscape";
}

export function classifyMediaDevice(containerWidth: number): MediaDeviceType {
  if (containerWidth < 600) return "mobile";
  if (containerWidth < 1024) return "tablet";
  return "desktop";
}

export function calculateMediaLayout(input: MediaLayoutInput): MediaLayout {
  const deviceType = input.deviceType ?? classifyMediaDevice(input.containerWidth);
  const sourceOrientation = classifyMediaOrientation(input.sourceWidth, input.sourceHeight);
  const empty = !valid(input.sourceWidth) || !valid(input.sourceHeight) || !valid(input.containerWidth) || !valid(input.containerHeight);
  const safeControlInsets = {
    top: deviceType === "mobile" ? 12 : 16,
    right: deviceType === "mobile" ? 10 : 16,
    bottom: deviceType === "mobile" ? 82 : 96,
    left: deviceType === "mobile" ? 10 : 16,
  };
  if (empty) {
    return {
      renderedWidth: 0, renderedHeight: 0, offsetX: 0, offsetY: 0,
      sourceAspectRatio: 0, containerAspectRatio: 0, sourceOrientation,
      deviceType, objectFit: "contain", maxWidth: Math.max(0, input.containerWidth),
      maxHeight: Math.max(0, input.containerHeight), safeControlInsets,
    };
  }

  const sourceAspectRatio = input.sourceWidth / input.sourceHeight;
  const containerAspectRatio = input.containerWidth / input.containerHeight;
  const fitScale = Math.min(input.containerWidth / input.sourceWidth, input.containerHeight / input.sourceHeight);
  const fillScale = Math.max(input.containerWidth / input.sourceWidth, input.containerHeight / input.sourceHeight);
  let scale = input.preferredMode === "fill" ? fillScale : input.preferredMode === "actual" ? 1 : fitScale;
  let maxWidth = input.containerWidth;
  let maxHeight = input.containerHeight;

  // A phone camera/screen should use the laptop height without becoming a monitor-wide portrait.
  if (input.preferredMode !== "fill" && deviceType === "desktop" && sourceOrientation === "portrait") {
    const portraitWidthCap = clamp(input.containerHeight * 0.5625, 360, 480);
    maxWidth = Math.min(input.containerWidth, portraitWidthCap);
    maxHeight = input.containerHeight;
    scale = Math.min(scale, maxWidth / input.sourceWidth, maxHeight / input.sourceHeight);
  }

  const renderedWidth = input.sourceWidth * scale;
  const renderedHeight = input.sourceHeight * scale;
  return {
    renderedWidth,
    renderedHeight,
    offsetX: (input.containerWidth - renderedWidth) / 2,
    offsetY: (input.containerHeight - renderedHeight) / 2,
    sourceAspectRatio,
    containerAspectRatio,
    sourceOrientation,
    deviceType,
    objectFit: input.preferredMode === "fill" ? "cover" : input.preferredMode === "actual" ? "none" : "contain",
    maxWidth,
    maxHeight,
    safeControlInsets,
  };
}
