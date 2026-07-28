const INTENTIONAL_FULL_BLEED = "[data-allow-full-bleed], .landing-lighting, .call-orbit-bg, .incoming-call-backdrop";

export type OverflowFinding = { selector: string; left: number; right: number; route: string };

function selectorFor(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const classes = Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join("");
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

export function findFunctionalOverflow(root: ParentNode = document): OverflowFinding[] {
  const viewportWidth = document.documentElement.clientWidth;
  return Array.from(root.querySelectorAll<HTMLElement>("body *"))
    .filter((element) => {
      if (element.matches(INTENTIONAL_FULL_BLEED) || element.closest("[data-allow-full-bleed]")) return false;
      if (element.closest("[aria-hidden='true'],[data-open='false']")) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return rect.left < -1 || rect.right > viewportWidth + 1;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { selector: selectorFor(element), left: Math.round(rect.left), right: Math.round(rect.right), route: location.pathname + location.search };
    });
}

export function installResponsiveDiagnostics(): void {
  if (!import.meta.env.DEV) return;
  let frame = 0;
  const inspect = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const finding of findFunctionalOverflow()) console.warn("RESPONSIVE_OVERFLOW", finding);
    });
  };
  window.addEventListener("resize", inspect);
  new MutationObserver(inspect).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  window.setTimeout(inspect, 500);
}

export function installFunctionalDialogDiagnostics(): void {
  if (!import.meta.env.DEV) return;
  const logDialog = (component: Element | null, label: string) => {
    const logoNodes = component?.querySelectorAll(".app-logo,.brand-logo,[data-brand-logo],img[src*='logo'],img[src*='ic_launcher']").length ?? 0;
    console.info("FUNCTIONAL_DIALOG_OPENED", { component: component?.className || label, route: location.pathname + location.search, logoNodes });
  };
  const originalConfirm = window.confirm.bind(window);
  window.confirm = (message?: string) => {
    if (/clear|clean|delete|reset|remove|history|cache/i.test(message || "")) logDialog(null, "native-confirm");
    return originalConfirm(message);
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) {
      if (!(node instanceof Element)) continue;
      const dialog = node.matches("[role='dialog'],.functional-dialog") ? node : node.querySelector("[role='dialog'],.functional-dialog");
      if (dialog) logDialog(dialog, "dialog");
    }
  }).observe(document.body, { childList: true, subtree: true });
}
