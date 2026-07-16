import { Maximize2, Minimize2, RotateCw, Search, Shrink, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { screenShareDebug } from "./screenShareDiagnostics";
import { clamp, constrainScreenSharePan, screenShareVideoStyle, type ScreenShareViewMode } from "./screenShareViewMath";

type PointerPoint = {
  id: number;
  x: number;
  y: number;
};

function distance(a: PointerPoint, b: PointerPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: PointerPoint, b: PointerPoint) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function ScreenShareViewer({
  stream,
  paused,
  status,
  error,
  onClose,
  onToggleMic,
  micMuted,
}: {
  stream: MediaStream | null;
  paused: boolean;
  status: string;
  error: string;
  onClose: () => void;
  onToggleMic: () => void;
  micMuted: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const gestureRef = useRef<{ zoom: number; x: number; y: number; distance: number; center: { x: number; y: number } } | null>(null);
  const lastTapRef = useRef(0);
  const controlsTimerRef = useRef<number>(0);
  const [viewMode, setViewMode] = useState<ScreenShareViewMode>("fit");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => setControlsVisible(false), 3200);
  }, []);

  const constrainPan = useCallback((nextPan: { x: number; y: number }, nextZoom = zoom) => {
    setPan(constrainScreenSharePan(nextPan.x, nextPan.y, nextZoom, containerRef.current?.getBoundingClientRect() ?? null));
  }, [zoom]);

  const setConstrainedZoom = useCallback((nextZoom: number, center?: { x: number; y: number }) => {
    const next = clamp(nextZoom, 1, 5);
    setZoom((current) => {
      if (next <= 1) {
        setPan({ x: 0, y: 0 });
        return 1;
      }
      if (center && containerRef.current) {
        const box = containerRef.current.getBoundingClientRect();
        const dx = center.x - box.left - box.width / 2;
        const dy = center.y - box.top - box.height / 2;
        const ratio = next / current;
        const moved = constrainScreenSharePan(pan.x * ratio - dx * (ratio - 1), pan.y * ratio - dy * (ratio - 1), next, box);
        setPan(moved);
      } else {
        constrainPan(pan, next);
      }
      return next;
    });
  }, [constrainPan, pan]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);
    resetZoom();
    setViewMode("fit");
    setRotation(0);
    showControls();
  }, [resetZoom, stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      const next = { width: video.videoWidth || 0, height: video.videoHeight || 0 };
      setNaturalSize(next);
      screenShareDebug("receiver-video-metadata", {
        videoWidth: next.width,
        videoHeight: next.height,
        objectFit: getComputedStyle(video).objectFit,
        transform,
        zoom,
        viewMode,
      });
    };
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("resize", update);
    stream?.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", resetZoom);
      track.addEventListener("mute", resetZoom);
    });
    update();
    return () => {
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("resize", update);
      stream?.getVideoTracks().forEach((track) => {
        track.removeEventListener("ended", resetZoom);
        track.removeEventListener("mute", resetZoom);
      });
    };
  }, [resetZoom, stream]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      setContainerSize({ width: rect.width, height: rect.height });
      setPan((current) => constrainScreenSharePan(current.x, current.y, zoom, node.getBoundingClientRect()));
      screenShareDebug("receiver-container-resize", {
        containerWidth: rect.width,
        containerHeight: rect.height,
        zoom,
        viewMode,
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [zoom]);

  useEffect(() => {
    const onOrientation = () => {
      setPan((current) => constrainScreenSharePan(current.x, current.y, zoom, containerRef.current?.getBoundingClientRect() ?? null));
    };
    window.addEventListener("orientationchange", onOrientation);
    window.addEventListener("resize", onOrientation);
    return () => {
      window.removeEventListener("orientationchange", onOrientation);
      window.removeEventListener("resize", onOrientation);
    };
  }, [zoom]);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    showControls();
    return () => window.clearTimeout(controlsTimerRef.current);
  }, [showControls]);

  const naturalLabel = naturalSize.width && naturalSize.height ? `${naturalSize.width} x ${naturalSize.height}` : "Waiting";
  const containerLabel = containerSize.width && containerSize.height ? `${Math.round(containerSize.width)} x ${Math.round(containerSize.height)}` : "";

  const videoStyle = useMemo(() => {
    return screenShareVideoStyle(viewMode, naturalSize);
  }, [naturalSize.height, naturalSize.width, viewMode]);

  const transform = `translate3d(${pan.x}px, ${pan.y}px, 0) rotate(${rotation}deg) scale(${zoom})`;

  function pointerFromEvent(event: React.PointerEvent): PointerPoint {
    return { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    showControls();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, pointerFromEvent(event));
    const pointers = [...pointersRef.current.values()];
    const now = Date.now();
    if (pointers.length === 1 && now - lastTapRef.current < 290) {
      if (zoom > 1) resetZoom();
      else setConstrainedZoom(2, { x: event.clientX, y: event.clientY });
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
    if (pointers.length === 2) {
      gestureRef.current = {
        zoom,
        x: pan.x,
        y: pan.y,
        distance: distance(pointers[0], pointers[1]),
        center: midpoint(pointers[0], pointers[1]),
      };
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    showControls();
    if (!pointersRef.current.has(event.pointerId)) return;
    const previous = pointersRef.current.get(event.pointerId)!;
    const nextPoint = pointerFromEvent(event);
    pointersRef.current.set(event.pointerId, nextPoint);
    const pointers = [...pointersRef.current.values()];
    if (pointers.length === 2 && gestureRef.current) {
      const nextDistance = distance(pointers[0], pointers[1]);
      const nextCenter = midpoint(pointers[0], pointers[1]);
      const ratio = nextDistance / Math.max(1, gestureRef.current.distance);
      const nextZoom = clamp(gestureRef.current.zoom * ratio, 1, 5);
      setZoom(nextZoom);
      const moved = constrainScreenSharePan(
        gestureRef.current.x + (nextCenter.x - gestureRef.current.center.x),
        gestureRef.current.y + (nextCenter.y - gestureRef.current.center.y),
        nextZoom,
        containerRef.current?.getBoundingClientRect() ?? null,
      );
      setPan(moved);
      return;
    }
    if (pointers.length === 1 && zoom > 1) {
      constrainPan({ x: pan.x + nextPoint.x - previous.x, y: pan.y + nextPoint.y - previous.y });
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) gestureRef.current = null;
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setConstrainedZoom(zoom + (event.deltaY > 0 ? -0.2 : 0.2), { x: event.clientX, y: event.clientY });
  }

  async function toggleFullscreen() {
    const node = containerRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    await node.requestFullscreen?.().catch(() => undefined);
  }

  return (
    <div
      ref={containerRef}
      className={`ss-screen-viewer ss-screen-viewer-${viewMode}`}
      role="dialog"
      aria-modal="true"
      aria-label="Screen share viewer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    onWheel={handleWheel}
      onMouseMove={showControls}
    >
      {stream ? (
        <div className="ss-screen-stage">
          <div className="ss-screen-transform" style={{ transform }}>
            <video
              ref={videoRef}
              className="ss-viewer-video"
              autoPlay
              playsInline
              style={videoStyle}
              onLoadedMetadata={(event) => {
                setNaturalSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
                void event.currentTarget.play().catch(() => undefined);
              }}
              onResize={(event) => setNaturalSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
            />
          </div>
        </div>
      ) : (
        <div className="ss-viewer-empty"><MonitorIcon /><strong>{status === "reconnecting" ? "Reconnecting..." : "Waiting for screen..."}</strong></div>
      )}

      <header className={`ss-viewer-head ${controlsVisible ? "" : "ss-controls-hidden"}`}>
        <strong>Screen Share</strong>
        <span>{status === "reconnecting" ? "Reconnecting" : status === "failed" ? "Failed" : "Live"}</span>
        <small>{naturalLabel}{containerLabel ? ` in ${containerLabel}` : ""}</small>
      </header>

      <div
        className={`ss-viewer-toolbar ${controlsVisible ? "" : "ss-controls-hidden"}`}
        role="toolbar"
        aria-label="Screen share view controls"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
      >
        <button type="button" className={viewMode === "fit" ? "active" : ""} onClick={() => setViewMode("fit")}>Fit</button>
        <button type="button" className={viewMode === "fill" ? "active" : ""} onClick={() => setViewMode("fill")}>Fill</button>
        <button type="button" className={viewMode === "actual" ? "active" : ""} onClick={() => setViewMode("actual")}>100%</button>
        <button type="button" onClick={() => setConstrainedZoom(zoom + 0.25)} aria-label="Zoom in"><ZoomIn size={16} /></button>
        <button type="button" onClick={() => setConstrainedZoom(zoom - 0.25)} aria-label="Zoom out"><ZoomOut size={16} /></button>
        <button type="button" onClick={resetZoom} aria-label="Reset zoom"><Shrink size={16} /></button>
        <button type="button" onClick={() => setRotation((value) => (value + 90) % 360)} aria-label="Rotate view"><RotateCw size={16} /></button>
        <button type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        <span><Search size={14} /> {Math.round(zoom * 100)}%</span>
      </div>

      {paused && <div className="ss-paused">Sharing paused</div>}
      {error && <div className="ss-floating-error">{error}</div>}
      <div
        className={`ss-viewer-controls ${controlsVisible ? "" : "ss-controls-hidden"}`}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
      >
        <button type="button" onClick={onToggleMic} aria-label={micMuted ? "Turn on mic" : "Mute mic"}>{micMuted ? "Mic off" : "Mic on"}</button>
        <button type="button" className="ss-viewer-close" onClick={onClose}><X size={18} /> Close</button>
      </div>
    </div>
  );
}

function MonitorIcon() {
  return <span className="ss-monitor-icon" aria-hidden="true" />;
}
