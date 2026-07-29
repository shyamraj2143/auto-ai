export type FloatingAnchor = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export type FloatingRect = { width: number; height: number };
export type FloatingBounds = FloatingRect & { insetTop?: number; insetRight?: number; insetBottom?: number; insetLeft?: number };

export function constrainFloatingPosition(position: { x: number; y: number }, panel: FloatingRect, bounds: FloatingBounds) {
  const left = bounds.insetLeft ?? 12;
  const top = bounds.insetTop ?? 12;
  const right = bounds.width - panel.width - (bounds.insetRight ?? 12);
  const bottom = bounds.height - panel.height - (bounds.insetBottom ?? 12);
  return { x: Math.max(left, Math.min(Math.max(left, right), position.x)), y: Math.max(top, Math.min(Math.max(top, bottom), position.y)) };
}

export function floatingAnchorPosition(anchor: FloatingAnchor, panel: FloatingRect, bounds: FloatingBounds) {
  const left = bounds.insetLeft ?? 12;
  const top = bounds.insetTop ?? 12;
  const right = bounds.width - panel.width - (bounds.insetRight ?? 12);
  const bottom = bounds.height - panel.height - (bounds.insetBottom ?? 12);
  const centerX = (bounds.width - panel.width) / 2;
  return constrainFloatingPosition({
    x: anchor.endsWith("left") ? left : anchor.endsWith("right") ? right : centerX,
    y: anchor.startsWith("top") ? top : bottom,
  }, panel, bounds);
}

export function nearestFloatingAnchor(position: { x: number; y: number }, panel: FloatingRect, bounds: FloatingBounds, allowCenter = true): FloatingAnchor {
  const anchors: FloatingAnchor[] = allowCenter
    ? ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]
    : ["top-left", "top-right", "bottom-left", "bottom-right"];
  return anchors.reduce((best, anchor) => {
    const point = floatingAnchorPosition(anchor, panel, bounds);
    const bestPoint = floatingAnchorPosition(best, panel, bounds);
    return Math.hypot(point.x - position.x, point.y - position.y) < Math.hypot(bestPoint.x - position.x, bestPoint.y - position.y) ? anchor : best;
  }, anchors[0]);
}
