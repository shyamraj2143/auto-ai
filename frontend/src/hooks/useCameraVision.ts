import { useState, useCallback, useRef } from "react";

export function useCameraVision() {
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("environment");
  const [cameraError, setCameraError] = useState("");
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const startCamera = useCallback(async (facing: "user" | "environment" = "environment", videoElement: HTMLVideoElement | null) => {
    setCameraError("");
    try {
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 640 } },
        audio: false
      });
      cameraStreamRef.current = stream;
      if (videoElement) {
        videoElement.srcObject = stream;
        await videoElement.play().catch((err) => {
          console.warn("Auto-play failed, user gesture might be required:", err);
        });
      }
      setCameraFacing(facing);
      setCameraActive(true);
      return stream;
    } catch (err) {
      console.error("Camera permission error:", err);
      setCameraError("Camera permission is required for Vision Mode.");
      setCameraActive(false);
      throw err;
    }
  }, []);

  const stopCamera = useCallback((videoElement: HTMLVideoElement | null) => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    if (videoElement) {
      videoElement.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  const switchCamera = useCallback(async (videoElement: HTMLVideoElement | null) => {
    const nextFacing = cameraFacing === "user" ? "environment" : "user";
    await startCamera(nextFacing, videoElement);
  }, [cameraFacing, startCamera]);

  const captureFrame = useCallback(async (videoElement: HTMLVideoElement | null): Promise<Blob | null> => {
    if (!videoElement || !videoElement.videoWidth || !videoElement.videoHeight) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.7);
    });
  }, []);

  const captureBase64Frame = useCallback(async (videoElement: HTMLVideoElement | null): Promise<string | null> => {
    if (!videoElement || !videoElement.videoWidth || !videoElement.videoHeight) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  }, []);

  return {
    cameraActive,
    cameraFacing,
    cameraError,
    setCameraError,
    startCamera,
    stopCamera,
    switchCamera,
    captureFrame,
    captureBase64Frame,
  };
}
