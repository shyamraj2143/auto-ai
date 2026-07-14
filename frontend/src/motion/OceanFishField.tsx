import { useEffect, useRef, useState } from "react";
import { useMotionMode } from "./MotionProvider";
import { fishAnimationChangeEvent, readFishAnimationEnabled } from "./fishSettings";

const compactFishCount = 3;
const fullFishCount = 6;
const compactFrameInterval = 1000 / 30;

const globalFish = [
  "coral",
  "reef",
  "azure",
  "current",
  "tidal",
  "pearl",
  "deep",
  "glow",
  "wave",
  "stream"
] as const;

type FishKey = (typeof globalFish)[number];

type FishMotion = {
  key: FishKey;
  size: number;
  xRatio: number;
  yRatio: number;
  vx: number;
  vy: number;
};

type FishState = FishMotion & {
  x: number;
  y: number;
  width: number;
  height: number;
  collidedUntil: number;
};

const fishMotion: FishMotion[] = [
  { key: "coral", size: 1.18, xRatio: 0.18, yRatio: 0.32, vx: 150, vy: 28 },
  { key: "reef", size: 0.86, xRatio: 0.28, yRatio: 0.42, vx: -118, vy: 64 },
  { key: "azure", size: 0.72, xRatio: 0.52, yRatio: 0.66, vx: 104, vy: -58 },
  { key: "current", size: 1.28, xRatio: 0.76, yRatio: 0.76, vx: -136, vy: -42 },
  { key: "tidal", size: 0.64, xRatio: 0.18, yRatio: 0.14, vx: 126, vy: 36 },
  { key: "pearl", size: 0.96, xRatio: 0.62, yRatio: 0.52, vx: -96, vy: 74 },
  { key: "deep", size: 1.42, xRatio: 0.36, yRatio: 0.88, vx: 86, vy: -68 },
  { key: "glow", size: 0.78, xRatio: 0.34, yRatio: 0.32, vx: -152, vy: -18 },
  { key: "wave", size: 1.08, xRatio: 0.46, yRatio: 0.1, vx: 112, vy: 46 },
  { key: "stream", size: 0.9, xRatio: 0.7, yRatio: 0.84, vx: -124, vy: -62 }
];

const baseFishWidth = 88;
const baseFishHeight = 42;
const collisionFlashMs = 260;

function isCompactFishMode() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const smallViewport = window.matchMedia("(max-width: 900px)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  return smallViewport || coarsePointer || saveData || memory <= 3 || cores <= 3;
}

function createFishState(width: number, height: number, compact: boolean): FishState[] {
  const fishList = fishMotion.slice(0, compact ? compactFishCount : fullFishCount);
  return fishList.map((fish) => {
    const fishWidth = baseFishWidth * fish.size;
    const fishHeight = baseFishHeight * fish.size;
    return {
      ...fish,
      width: fishWidth,
      height: fishHeight,
      x: Math.min(width - fishWidth, Math.max(0, width * fish.xRatio)),
      y: Math.min(height - fishHeight, Math.max(64, height * fish.yRatio)),
      collidedUntil: 0
    };
  });
}

export function OceanFishField() {
  const { visible } = useMotionMode();
  const [enabled, setEnabled] = useState(() => readFishAnimationEnabled());
  const fishRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const update = () => setEnabled(readFishAnimationEnabled());
    window.addEventListener(fishAnimationChangeEvent, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(fishAnimationChangeEvent, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  useEffect(() => {
    if (!visible || !enabled) return;

    let frame = 0;
    let last = performance.now();
    let compact = isCompactFishMode();
    let fish = createFishState(window.innerWidth, window.innerHeight, compact);

    const resize = () => {
      compact = isCompactFishMode();
      fish = createFishState(window.innerWidth, window.innerHeight, compact);
    };

    const markCollision = (first: FishState, second?: FishState) => {
      const until = performance.now() + collisionFlashMs;
      first.collidedUntil = until;
      if (second) second.collidedUntil = until;
    };

    const tick = (now: number) => {
      if (compact && now - last < compactFrameInterval) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      const width = window.innerWidth;
      const height = window.innerHeight;
      const delta = Math.min(0.032, (now - last) / 1000);
      last = now;

      for (const item of fish) {
        item.x += item.vx * delta;
        item.y += item.vy * delta;

        const minY = Math.min(64, Math.max(8, height - item.height));
        const maxX = Math.max(0, width - item.width);
        const maxY = Math.max(minY, height - item.height - 8);

        if (item.x <= 0) {
          item.x = 0;
          item.vx = Math.abs(item.vx);
          markCollision(item);
        } else if (item.x >= maxX) {
          item.x = maxX;
          item.vx = -Math.abs(item.vx);
          markCollision(item);
        }

        if (item.y <= minY) {
          item.y = minY;
          item.vy = Math.abs(item.vy);
          markCollision(item);
        } else if (item.y >= maxY) {
          item.y = maxY;
          item.vy = -Math.abs(item.vy);
          markCollision(item);
        }
      }

      if (!compact) {
        for (let index = 0; index < fish.length; index += 1) {
          for (let nextIndex = index + 1; nextIndex < fish.length; nextIndex += 1) {
            const first = fish[index];
            const second = fish[nextIndex];
            const firstRadius = Math.max(first.width, first.height) * 0.44;
            const secondRadius = Math.max(second.width, second.height) * 0.44;
            const firstCenterX = first.x + first.width / 2;
            const firstCenterY = first.y + first.height / 2;
            const secondCenterX = second.x + second.width / 2;
            const secondCenterY = second.y + second.height / 2;
            const dx = secondCenterX - firstCenterX;
            const dy = secondCenterY - firstCenterY;
            const distance = Math.hypot(dx, dy) || 1;
            const overlap = firstRadius + secondRadius - distance;

            if (overlap <= 0) continue;

            const nx = dx / distance;
            const ny = dy / distance;
            const relativeVelocity = (first.vx - second.vx) * nx + (first.vy - second.vy) * ny;
            first.x -= nx * overlap * 0.5;
            first.y -= ny * overlap * 0.5;
            second.x += nx * overlap * 0.5;
            second.y += ny * overlap * 0.5;

            if (relativeVelocity > 0) {
              first.vx -= relativeVelocity * nx;
              first.vy -= relativeVelocity * ny;
              second.vx += relativeVelocity * nx;
              second.vy += relativeVelocity * ny;
            } else {
              [first.vx, second.vx] = [second.vx, first.vx];
              [first.vy, second.vy] = [second.vy, first.vy];
            }

            markCollision(first, second);
          }
        }
      }

      fish.forEach((item, index) => {
        const element = fishRefs.current[index];
        if (!element) return;

        const direction = item.vx >= 0 ? -1 : 1;
        const tilt = Math.max(-10, Math.min(10, item.vy * 0.08));
        element.style.transform = `translate3d(${item.x}px, ${item.y}px, 0) scaleX(${direction}) rotate(${tilt}deg)`;
        element.classList.toggle("is-colliding", item.collidedUntil > now);
      });

      frame = window.requestAnimationFrame(tick);
    };

    window.addEventListener("resize", resize);
    frame = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(frame);
    };
  }, [enabled, visible]);

  if (!enabled) return null;

  const renderedFish = isCompactFishMode() ? globalFish.slice(0, compactFishCount) : globalFish.slice(0, fullFishCount);

  return (
    <div className="ocean-fish-field global-ocean-fish-field" aria-hidden="true">
      {renderedFish.map((fish, index) => (
        <div
          className={`ocean-fish global-ocean-fish global-ocean-fish-${fish}`}
          key={fish}
          ref={(element) => {
            fishRefs.current[index] = element;
          }}
        >
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
