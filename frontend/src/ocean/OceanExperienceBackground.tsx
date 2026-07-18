import { useEffect, useRef } from "react";
import { OCEAN_DIVE_TIMING, rangeProgress, timelineProgress } from "./oceanDiveTimeline";
import { logOceanDebugSnapshot, updateOceanDebug } from "./oceanDebug";
import { isOceanDivePhase, type OceanPhase, type OceanRoute } from "./oceanStateMachine";
import { OCEAN_FRAGMENT_SHADER, OCEAN_VERTEX_SHADER } from "./oceanShaders";

type OceanExperienceBackgroundProps = {
  phase: OceanPhase;
  route: Exclude<OceanRoute, "none">;
  transitionStartedAt: number | null;
  debug: boolean;
  onReady: () => void;
  onFailure: (error?: unknown) => void;
  onInteractionChange: (active: boolean) => void;
  onQualityChange: (quality: string) => void;
};

type NavigatorWithMemory = Navigator & { deviceMemory?: number };

type Uniforms = {
  resolution: WebGLUniformLocation | null;
  pointer: WebGLUniformLocation | null;
  center: WebGLUniformLocation | null;
  radius: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  diveProgress: WebGLUniformLocation | null;
  expansionProgress: WebGLUniformLocation | null;
  surfaceCrossProgress: WebGLUniformLocation | null;
  depth: WebGLUniformLocation | null;
  mode: WebGLUniformLocation | null;
  reactivity: WebGLUniformLocation | null;
  quality: WebGLUniformLocation | null;
  deepColor: WebGLUniformLocation | null;
  midColor: WebGLUniformLocation | null;
  cyanColor: WebGLUniformLocation | null;
  violetColor: WebGLUniformLocation | null;
};

type ParallelShaderCompileExtension = {
  COMPLETION_STATUS_KHR: number;
};

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate an ocean shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function waitForParallelCompilation(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  extension: ParallelShaderCompileExtension
) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = performance.now();
    const check = () => {
      if (gl.getProgramParameter(program, extension.COMPLETION_STATUS_KHR)) {
        resolve();
        return;
      }
      if (performance.now() - startedAt > 3000) {
        reject(new Error("Ocean shader compilation timed out."));
        return;
      }
      window.setTimeout(check, 16);
    };
    check();
  });
}

async function createProgram(gl: WebGL2RenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, OCEAN_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, OCEAN_FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("Unable to allocate the ocean shader program.");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  const parallelCompile = gl.getExtension("KHR_parallel_shader_compile") as ParallelShaderCompileExtension | null;
  if (parallelCompile) await waitForParallelCompilation(gl, program, parallelCompile);

  const vertexReady = gl.getShaderParameter(vertex, gl.COMPILE_STATUS);
  const fragmentReady = gl.getShaderParameter(fragment, gl.COMPILE_STATUS);
  const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (!vertexReady || !fragmentReady || !linked) {
    const details = gl.getShaderInfoLog(vertex)
      || gl.getShaderInfoLog(fragment)
      || gl.getProgramInfoLog(program)
      || "Unknown ocean shader compilation error.";
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    gl.deleteProgram(program);
    throw new Error(details);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}

function parseHexColor(value: string, fallback: [number, number, number]): [number, number, number] {
  const match = value.trim().match(/^#([\da-f]{6})$/i);
  if (!match) return fallback;
  const packed = Number.parseInt(match[1], 16);
  return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255];
}

export function OceanExperienceBackground({
  phase,
  route,
  transitionStartedAt,
  debug,
  onReady,
  onFailure,
  onInteractionChange,
  onQualityChange
}: OceanExperienceBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  const routeRef = useRef(route);
  const transitionStartedAtRef = useRef(transitionStartedAt);

  useEffect(() => {
    phaseRef.current = phase;
    routeRef.current = route;
    transitionStartedAtRef.current = transitionStartedAt;
  }, [phase, route, transitionStartedAt]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const memory = (navigator as NavigatorWithMemory).deviceMemory ?? 4;
    const cores = navigator.hardwareConcurrency || 4;
    const mobile = coarsePointer || window.innerWidth < 820;
    const weakDevice = !debug && (cores <= 4 || memory <= 4);
    const maximumDpr = mobile ? (weakDevice ? 1 : 1.2) : 1.5;
    const baseDpr = Math.min(window.devicePixelRatio || 1, maximumDpr);
    let renderScale = debug ? 1 : weakDevice ? 0.7 : mobile ? 0.8 : 0.82;
    let shaderQuality = debug ? 1 : weakDevice ? 0.62 : mobile ? 0.78 : 1;
    let qualityName = debug ? "debug" : weakDevice ? "low" : mobile ? "mobile" : "smooth";
    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let uniforms: Uniforms | null = null;
    let rafId = 0;
    let resizeTimer = 0;
    let pointerIdleTimer = 0;
    let running = false;
    let contextLost = false;
    let disposed = false;
    let resourceGeneration = 0;
    let elapsedTime = 0;
    let previousFrame = performance.now();
    let sampledFrames = 0;
    let sampledDuration = 0;
    let frameCount = 0;
    let cssWidth = 0;
    let cssHeight = 0;
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
    let palette = {
      deep: [0.02, 0.03, 0.09] as [number, number, number],
      mid: [0.04, 0.08, 0.18] as [number, number, number],
      cyan: [0.21, 0.89, 0.97] as [number, number, number],
      violet: [0.55, 0.49, 1] as [number, number, number]
    };

    const initialBounds = canvas.getBoundingClientRect();
    updateOceanDebug({
      canvasSize: { width: Math.round(initialBounds.width), height: Math.round(initialBounds.height) },
      canvasBoundsValid: initialBounds.width >= window.innerWidth - 1 && initialBounds.height >= window.innerHeight - 1
    });

    const reportFailure = (error?: unknown) => {
      running = false;
      window.cancelAnimationFrame(rafId);
      if (import.meta.env.DEV && error) {
        console.error("[Abyssal Prism Current] WebGL renderer failed; using the CSS fallback.", error);
      }
      updateOceanDebug({
        renderer: "fallback",
        shaderStatus: "failure",
        lastError: error instanceof Error ? error.message : String(error ?? "Renderer failed.")
      });
      logOceanDebugSnapshot();
      onFailure(error);
    };

    const syncPalette = () => {
      const styles = window.getComputedStyle(document.documentElement);
      palette = {
        deep: parseHexColor(styles.getPropertyValue("--prism-ink"), [0.02, 0.03, 0.09]),
        mid: parseHexColor(styles.getPropertyValue("--prism-navy"), [0.04, 0.08, 0.18]),
        cyan: parseHexColor(styles.getPropertyValue("--prism-cyan"), [0.21, 0.89, 0.97]),
        violet: parseHexColor(styles.getPropertyValue("--prism-violet"), [0.55, 0.49, 1])
      };
    };

    const destroyResources = () => {
      if (!gl || contextLost) return;
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      buffer = null;
      program = null;
      uniforms = null;
    };

    const resize = (force = false) => {
      if (!gl) return;
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      const keyboardResize = routeRef.current === "auth" && Math.abs(width - cssWidth) < 2 && Math.abs(height - cssHeight) < cssHeight * 0.34;
      if (!force && keyboardResize) return;
      cssWidth = width;
      cssHeight = height;
      const effectiveDpr = baseDpr * renderScale;
      const targetWidth = Math.max(1, Math.round(width * effectiveDpr));
      const targetHeight = Math.max(1, Math.round(height * effectiveDpr));
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      const bounds = canvas.getBoundingClientRect();
      updateOceanDebug({
        canvasSize: { width: canvas.width, height: canvas.height },
        canvasBoundsValid: bounds.width >= width - 1 && bounds.height >= height - 1
      });
    };

    const scheduleResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => resize(), 140);
    };

    const diveUniforms = (now: number) => {
      const startedAt = transitionStartedAtRef.current;
      if (startedAt === null || !isOceanDivePhase(phaseRef.current)) {
        return { dive: 0, expansion: 0, surface: 0, depth: 0 };
      }
      const dive = timelineProgress(now, startedAt);
      return {
        dive,
        expansion: rangeProgress(
          dive,
          OCEAN_DIVE_TIMING.expand / OCEAN_DIVE_TIMING.complete,
          OCEAN_DIVE_TIMING.crossSurface / OCEAN_DIVE_TIMING.complete
        ),
        surface: rangeProgress(
          dive,
          OCEAN_DIVE_TIMING.crossSurface / OCEAN_DIVE_TIMING.complete,
          OCEAN_DIVE_TIMING.descend / OCEAN_DIVE_TIMING.complete
        ),
        depth: rangeProgress(
          dive,
          OCEAN_DIVE_TIMING.descend / OCEAN_DIVE_TIMING.complete,
          OCEAN_DIVE_TIMING.settle / OCEAN_DIVE_TIMING.complete
        )
      };
    };

    const renderFrame = (now: number) => {
      if (!gl || !program || !uniforms || !running || document.hidden || phaseRef.current === "paused") return;
      const deltaSeconds = Math.min(0.05, Math.max(0, (now - previousFrame) / 1000));
      previousFrame = now;
      elapsedTime = (elapsedTime + deltaSeconds) % 4096;
      pointer.x += (pointer.targetX - pointer.x) * 0.045;
      pointer.y += (pointer.targetY - pointer.y) * 0.045;

      sampledDuration += deltaSeconds;
      sampledFrames += 1;
      if (sampledFrames >= 90) {
        const averageFrame = sampledDuration / sampledFrames;
        if (averageFrame > 0.018 && renderScale > 0.665) {
          renderScale = Math.max(0.66, renderScale * 0.82);
          shaderQuality = Math.max(0.52, shaderQuality * 0.84);
          qualityName = "adaptive";
          onQualityChange(qualityName);
          resize(true);
        }
        sampledFrames = 0;
        sampledDuration = 0;
      }

      const authMode = routeRef.current === "auth";
      const mobileLayout = cssWidth < 820;
      const timeline = diveUniforms(now);
      const authBlend = timeline.dive > 0
        ? rangeProgress(timeline.dive, 0.76, 1)
        : authMode ? 1 : 0;
      const homeCenterX = mobileLayout ? 0.50 : 0.53;
      const authCenterX = mobileLayout ? 0.5 : 0.47;
      const homeCenterY = mobileLayout ? 0.58 : 0.54;
      const homeRadius = mobileLayout ? 0.76 : 0.98;
      const centerX = homeCenterX + (authCenterX - homeCenterX) * authBlend;
      const centerY = homeCenterY + (0.68 - homeCenterY) * authBlend;
      const radius = homeRadius + (1.16 - homeRadius) * authBlend;

      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
      gl.uniform2f(uniforms.center, centerX, centerY);
      gl.uniform1f(uniforms.radius, radius);
      gl.uniform1f(uniforms.time, elapsedTime);
      gl.uniform1f(uniforms.diveProgress, timeline.dive);
      gl.uniform1f(uniforms.expansionProgress, timeline.expansion);
      gl.uniform1f(uniforms.surfaceCrossProgress, timeline.surface);
      gl.uniform1f(uniforms.depth, timeline.depth);
      gl.uniform1f(uniforms.mode, authBlend);
      gl.uniform1f(uniforms.reactivity, phaseRef.current === "home-reactive" ? 1 : 0);
      gl.uniform1f(uniforms.quality, shaderQuality);
      gl.uniform3fv(uniforms.deepColor, palette.deep);
      gl.uniform3fv(uniforms.midColor, palette.mid);
      gl.uniform3fv(uniforms.cyanColor, palette.cyan);
      gl.uniform3fv(uniforms.violetColor, palette.violet);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frameCount += 1;
      if (debug && (frameCount === 1 || frameCount % 30 === 0)) {
        updateOceanDebug({ frameCount });
        if (frameCount === 1) logOceanDebugSnapshot();
      }
      rafId = window.requestAnimationFrame(renderFrame);
    };

    const start = () => {
      if (running || document.hidden || contextLost) return;
      running = true;
      previousFrame = performance.now();
      rafId = window.requestAnimationFrame(renderFrame);
    };

    const stop = () => {
      running = false;
      window.cancelAnimationFrame(rafId);
    };

    const initializeResources = async () => {
      if (!gl) return;
      const generation = ++resourceGeneration;
      destroyResources();
      let nextProgram: WebGLProgram;
      try {
        nextProgram = await createProgram(gl);
      } catch (error) {
        if (disposed || generation !== resourceGeneration) return;
        throw error;
      }
      if (disposed || contextLost || generation !== resourceGeneration || !gl) {
        gl?.deleteProgram(nextProgram);
        return;
      }
      program = nextProgram;
      buffer = gl.createBuffer();
      if (!buffer) throw new Error("Unable to allocate the ocean geometry buffer.");
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(program);
      uniforms = {
        resolution: gl.getUniformLocation(program, "u_resolution"),
        pointer: gl.getUniformLocation(program, "u_pointer"),
        center: gl.getUniformLocation(program, "u_center"),
        radius: gl.getUniformLocation(program, "u_radius"),
        time: gl.getUniformLocation(program, "u_time"),
        diveProgress: gl.getUniformLocation(program, "u_dive_progress"),
        expansionProgress: gl.getUniformLocation(program, "u_expansion_progress"),
        surfaceCrossProgress: gl.getUniformLocation(program, "u_surface_cross_progress"),
        depth: gl.getUniformLocation(program, "u_depth"),
        mode: gl.getUniformLocation(program, "u_mode"),
        reactivity: gl.getUniformLocation(program, "u_reactivity"),
        quality: gl.getUniformLocation(program, "u_quality"),
        deepColor: gl.getUniformLocation(program, "u_deep_color"),
        midColor: gl.getUniformLocation(program, "u_mid_color"),
        cyanColor: gl.getUniformLocation(program, "u_cyan_color"),
        violetColor: gl.getUniformLocation(program, "u_violet_color")
      };
      syncPalette();
      resize(true);
      updateOceanDebug({ shaderStatus: "success", lastError: null });
      onQualityChange(qualityName);
    };

    const handleVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const strength = 0.018;
      pointer.targetX = ((event.clientX / Math.max(window.innerWidth, 1)) - 0.5) * strength;
      pointer.targetY = (0.5 - event.clientY / Math.max(window.innerHeight, 1)) * strength;
      onInteractionChange(true);
      window.clearTimeout(pointerIdleTimer);
      pointerIdleTimer = window.setTimeout(() => {
        pointer.targetX = 0;
        pointer.targetY = 0;
        onInteractionChange(false);
      }, 1400);
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      resourceGeneration += 1;
      stop();
      reportFailure(new Error("WebGL context lost."));
    };

    const handleContextRestored = () => {
      contextLost = false;
      void initializeResources()
        .then(() => {
          if (disposed || contextLost) return;
          onReady();
          start();
        })
        .catch(reportFailure);
    };

    const themeObserver = new MutationObserver(syncPalette);
    try {
      gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: !debug,
        powerPreference: weakDevice ? "low-power" : "default"
      });
      if (!gl) throw new Error("WebGL2 is unavailable on this device.");
      canvas.addEventListener("webglcontextlost", handleContextLost);
      canvas.addEventListener("webglcontextrestored", handleContextRestored);
      document.addEventListener("visibilitychange", handleVisibility);
      window.addEventListener("pointermove", handlePointerMove, { passive: true });
      window.addEventListener("resize", scheduleResize, { passive: true });
      window.addEventListener("orientationchange", scheduleResize, { passive: true });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
      void initializeResources()
        .then(() => {
          if (disposed || contextLost) return;
          onReady();
          start();
        })
        .catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }

    return () => {
      disposed = true;
      resourceGeneration += 1;
      stop();
      window.clearTimeout(resizeTimer);
      window.clearTimeout(pointerIdleTimer);
      themeObserver.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("resize", scheduleResize);
      window.removeEventListener("orientationchange", scheduleResize);
      destroyResources();
      gl = null;
    };
  }, [debug, onFailure, onInteractionChange, onQualityChange, onReady]);

  return <canvas ref={canvasRef} aria-hidden="true" className="ocean-experience-canvas" tabIndex={-1} />;
}
