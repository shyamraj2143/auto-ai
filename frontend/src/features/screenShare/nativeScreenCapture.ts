import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { screenShareDebug } from "./screenShareDiagnostics";

type NativeScreenFrame = {
  data: string;
  width: number;
  height: number;
  timestamp: number;
};

interface NativeScreenCapturePlugin {
  isAvailable(): Promise<{ available: boolean }>;
  startCapture(options: { frameRate: number; maxLongEdge: number; jpegQuality: number }): Promise<void>;
  stopCapture(): Promise<void>;
  addListener(eventName: "frame", listener: (frame: NativeScreenFrame) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "captureStarted", listener: (event: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "captureResize", listener: (event: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "captureEnded", listener: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "captureError", listener: (error: { message: string }) => void): Promise<PluginListenerHandle>;
}

const NativeScreenCapture = registerPlugin<NativeScreenCapturePlugin>("ScreenCapture");

export function isNativeScreenCapturePlatform() {
  return Capacitor.getPlatform() === "android";
}

export async function startNativeScreenCaptureStream(options: { frameRate: number; maxLongEdge: number; jpegQuality: number }) {
  if (!isNativeScreenCapturePlatform()) throw new Error("Native screen capture is unavailable.");
  const availability = await NativeScreenCapture.isAvailable();
  if (!availability.available) throw new Error("Native screen capture is unavailable.");

  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 1280;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || !canvas.captureStream) throw new Error("Screen stream rendering is unavailable.");

  const stream = canvas.captureStream(options.frameRate);
  const videoTrack = stream.getVideoTracks()[0];
  let stopped = false;
  const listeners: PluginListenerHandle[] = [];

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    videoTrack?.stop();
    await NativeScreenCapture.stopCapture().catch(() => undefined);
    await Promise.all(listeners.map((listener) => listener.remove().catch(() => undefined)));
  };

  listeners.push(
    await NativeScreenCapture.addListener("frame", (frame) => {
      if (stopped || !frame.data) return;
      const image = new Image();
      image.onload = () => {
        if (stopped) return;
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width;
          canvas.height = frame.height;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      };
      image.src = `data:image/jpeg;base64,${frame.data}`;
    }),
    await NativeScreenCapture.addListener("captureStarted", (event) => {
      screenShareDebug("android-capture-started", event);
    }),
    await NativeScreenCapture.addListener("captureResize", (event) => {
      screenShareDebug("android-capture-resize", event);
    }),
    await NativeScreenCapture.addListener("captureEnded", () => {
      void stop();
    }),
    await NativeScreenCapture.addListener("captureError", (error) => {
      console.warn(error.message);
    }),
  );

  await NativeScreenCapture.startCapture(options);
  return { stream, stop };
}
