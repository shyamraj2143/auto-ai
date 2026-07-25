export type CmsEditorMode = "select" | "insert" | "preview" | "pan";

export type CmsSelection = {
  key: string;
  blockId: string;
  blockType: string;
  field: string;
  label: string;
  editable: "text" | "container" | "none";
  global: boolean;
  locked: boolean;
  protected: boolean;
  invalid: boolean;
  currentValue?: string;
  currentHref?: string;
};

export const CMS_ELEMENT_SELECTOR = "[data-cms-block-id]";

function enabled(value: string | undefined) {
  return value === "true" || value === "1";
}

export function selectionKey(blockId: string, field = "") {
  return `${blockId}::${field}`;
}

export function selectionFromElement(element: Element): CmsSelection | null {
  if (!(element instanceof HTMLElement) || !element.dataset.cmsBlockId) return null;
  const blockId = element.dataset.cmsBlockId;
  const field = element.dataset.cmsField ?? "";
  const blockType = element.dataset.cmsBlockType || "block";
  const editable = element.dataset.cmsEditable === "text"
    ? "text"
    : element.dataset.cmsEditable === "container"
      ? "container"
      : "none";
  return {
    key: selectionKey(blockId, field),
    blockId,
    blockType,
    field,
    label: element.dataset.cmsLabel || blockType.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    editable,
    global: enabled(element.dataset.cmsGlobal),
    locked: enabled(element.dataset.cmsLocked),
    protected: enabled(element.dataset.cmsProtected),
    invalid: enabled(element.dataset.cmsInvalid),
    currentValue: element.dataset.cmsValue,
    currentHref: element.dataset.cmsHref
  };
}

export function closestCmsElement(target: EventTarget | null, root: HTMLElement, parent = false): HTMLElement | null {
  if (!(target instanceof Element) || target.closest("[data-cms-editor-ui]")) return null;
  let element = target.closest<HTMLElement>(CMS_ELEMENT_SELECTOR);
  if (parent && element) element = element.parentElement?.closest<HTMLElement>(CMS_ELEMENT_SELECTOR) ?? null;
  return element && root.contains(element) ? element : null;
}

export function findCmsElement(root: HTMLElement, selection: CmsSelection): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>(CMS_ELEMENT_SELECTOR)).find((element) => {
    return element.dataset.cmsBlockId === selection.blockId && (element.dataset.cmsField ?? "") === selection.field;
  }) ?? null;
}

export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function cleanInlineText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").trim();
}

export function isSafeCmsUrl(value: unknown) {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url) return false;
  if ((url.startsWith("/") && !url.startsWith("//")) || url.startsWith("#")) return true;
  try {
    const parsed = new URL(url);
    return ["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}
