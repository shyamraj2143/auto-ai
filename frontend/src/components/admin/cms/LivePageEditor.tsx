import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, FileText,
  Hand, History, Layers3, Monitor, MousePointer2, Palette, Plus, Redo2, Save, Search,
  Send, Smartphone, Sparkles, Tablet, Trash2, Undo2, Wifi, WifiOff, X
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiClientError } from "../../../api/client";
import { useAuth } from "../../../contexts/AuthContext";
import { LandingPage } from "../../landing/LandingPage";
import { CmsPageRenderer } from "../../common/CmsPageRenderer";
import {
  cmsBlockDefinitionMap, cmsBlockDefinitions, duplicateLocalBlock, labelCms, makeLocalBlock,
  type CmsDevice
} from "./cmsBlockLibrary";
import { CmsSelectionEngine, type CmsSelectionAction } from "./CmsSelectionEngine";
import { cmsApi } from "./cmsApi";
import { isTypingTarget, selectionKey, type CmsEditorMode, type CmsSelection } from "./cmsSelection";
import { validateCmsPage } from "./cmsValidation";
import type { CmsAiAction, CmsBlock, CmsBlockType, CmsPage } from "./types";

type SaveState = "Saved" | "Unsaved" | "Saving" | "Save failed" | "Publishing" | "Published" | "Publish failed" | "Conflict detected";

const devices: Array<{ id: CmsDevice; label: string; icon: typeof Monitor }> = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "tablet", label: "Tablet", icon: Tablet },
  { id: "mobile", label: "Mobile", icon: Smartphone }
];

const editorModes: Array<{ id: CmsEditorMode; label: string; icon: typeof MousePointer2 }> = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "insert", label: "Insert", icon: Plus },
  { id: "preview", label: "Preview", icon: Eye },
  { id: "pan", label: "Pan", icon: Hand }
];

const styleFields = [
  { key: "text_color", label: "Text colour", options: ["default", "muted", "primary", "accent"] },
  { key: "background", label: "Background", options: ["default", "muted", "accent"] },
  { key: "radius", label: "Radius", options: ["none", "small", "medium", "large"] },
  { key: "shadow", label: "Shadow", options: ["none", "soft", "elevated"] },
  { key: "padding", label: "Padding", options: ["compact", "normal", "large"] },
  { key: "margin", label: "Margin", options: ["none", "small", "normal", "large"] },
  { key: "gap", label: "Gap", options: ["small", "normal", "large"] }
] as const;

const variantOptions: Partial<Record<CmsBlockType, string[]>> = {
  button: ["Filled", "Outlined", "Text"],
  feature_card: ["Flat", "Crystal", "Elevated"],
  hero_section: ["Split", "Centred", "Product Demo"],
  call_to_action: ["Compact", "Full Width"],
  navigation: ["Standard", "Compact"]
};

function clone(page: CmsPage): CmsPage {
  return JSON.parse(JSON.stringify(page)) as CmsPage;
}

function isHomePage(page: CmsPage | null) {
  return page?.slug === "home" || page?.page_key === "home";
}

function uniqueBlockIds(selections: CmsSelection[]) {
  return [...new Set(selections.map((selection) => selection.blockId))];
}

function pageElementKey(blockId: string) {
  return blockId.startsWith("element:") ? blockId.slice("element:".length) : null;
}

function blockSelection(block: CmsBlock): CmsSelection {
  const locked = Boolean(block.content.editor_locked) || ["form", "submit_button"].includes(block.block_type);
  return {
    key: selectionKey(block.id), blockId: block.id, blockType: block.block_type, field: "",
    label: labelCms(block.block_type), editable: "container", global: false, locked,
    protected: ["form", "submit_button"].includes(block.block_type), invalid: false
  };
}

function pageButtonSelection(index: number): CmsSelection {
  return {
    key: selectionKey(`page-button-${index}`, `buttons.${index}.label`),
    blockId: `page-button-${index}`,
    blockType: "button",
    field: `buttons.${index}.label`,
    label: "Button",
    editable: "text",
    global: false,
    locked: false,
    protected: false,
    invalid: false
  };
}

function pageElementSelection(key: string, label: string, blockType = "container", editable: CmsSelection["editable"] = "container"): CmsSelection {
  return {
    key: selectionKey(`element:${key}`, editable === "text" ? "text" : ""),
    blockId: `element:${key}`,
    blockType,
    field: editable === "text" ? "text" : "",
    label,
    editable,
    global: false,
    locked: false,
    protected: false,
    invalid: false
  };
}

function replaceText(value: unknown, search: string, replacement: string): unknown {
  if (typeof value === "string") return value.split(search).join(replacement);
  if (Array.isArray(value)) return value.map((item) => replaceText(item, search, replacement));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceText(child, search, replacement)]));
  }
  return value;
}

export function LivePageEditor({ canEdit, canPublish }: { canEdit: boolean; canPublish: boolean }) {
  const { token } = useAuth();
  const params = useParams();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<CmsPage | null>(null);
  const clipboardRef = useRef<CmsBlock[]>([]);
  const savingRef = useRef(false);
  const layerDragRef = useRef<string | null>(null);
  const [pages, setPages] = useState<CmsPage[]>([]);
  const [page, setPage] = useState<CmsPage | null>(null);
  const [device, setDevice] = useState<CmsDevice>("desktop");
  const [mode, setMode] = useState<CmsEditorMode>("select");
  const [primary, setPrimary] = useState<CmsSelection | null>(null);
  const [selections, setSelections] = useState<CmsSelection[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("Saved");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [error, setError] = useState("");
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<CmsPage[]>([]);
  const [future, setFuture] = useState<CmsPage[]>([]);
  const [layersOpen, setLayersOpen] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [layerQuery, setLayerQuery] = useState("");
  const [insertQuery, setInsertQuery] = useState("");
  const [findText, setFindText] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState("");
  const pageId = params.pageId;
  const selectedBlockId = primary?.blockId ?? null;
  const selectedBlock = page?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const selectedElementKey = primary ? pageElementKey(primary.blockId) : null;
  const selectedElementOverride = selectedElementKey ? page?.element_overrides?.[selectedElementKey] : undefined;
  const hiddenPageElements = Object.entries(page?.element_overrides ?? {}).filter(([, override]) => override.hidden);
  const validationIssues = useMemo(() => page ? validateCmsPage(page) : [], [page]);
  const blockingIssues = validationIssues.filter((issue) => issue.severity === "error");
  const filteredInsertBlocks = useMemo(() => cmsBlockDefinitions.filter((block) => {
    const query = insertQuery.trim().toLowerCase();
    return !query || `${block.label} ${block.category}`.toLowerCase().includes(query);
  }), [insertQuery]);

  const loadPages = useCallback(async () => {
    if (!token) return;
    const result = await cmsApi.pages(token);
    setPages(result.items);
    const target = pageId
      ? result.items.find((item) => item.id === pageId)
      : result.items.find((item) => item.slug === "home") ?? result.items.find((item) => item.status === "published") ?? result.items[0];
    if (!target) return;
    const serverResponse = await cmsApi.page(token, target.id);
    const server = { ...serverResponse, element_overrides: serverResponse.element_overrides ?? {} };
    const recoveryJson = localStorage.getItem(`auto-ai-cms-recovery:${server.id}`);
    let detail = server;
    if (recoveryJson) {
      try {
        const parsedRecovery = JSON.parse(recoveryJson) as CmsPage;
        const recovery = { ...parsedRecovery, element_overrides: parsedRecovery.element_overrides ?? {} };
        if (recovery.id === server.id && recovery.version === server.version) {
          detail = recovery;
          setSaveState("Unsaved");
          setMessage("Recovered unsaved local edits.");
        }
      } catch {
        localStorage.removeItem(`auto-ai-cms-recovery:${server.id}`);
      }
    }
    setPage(detail);
    latestRef.current = detail;
    setPrimary(null);
    setSelections([]);
    setHistory([]);
    setFuture([]);
    if (!pageId) navigate(`/admin/live-pages/${detail.id}`, { replace: true });
  }, [navigate, pageId, token]);

  useEffect(() => {
    void loadPages().catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to load live website"));
  }, [loadPages]);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!["Unsaved", "Save failed", "Conflict detected"].includes(saveState)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [saveState]);

  function mutate(mutator: (current: CmsPage) => CmsPage) {
    if (!canEdit) return;
    setPage((current) => {
      if (!current) return current;
      const next = mutator(clone(current));
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      setHistory((items) => [...items.slice(-49), clone(current)]);
      setFuture([]);
      latestRef.current = next;
      localStorage.setItem(`auto-ai-cms-recovery:${next.id}`, JSON.stringify(next));
      return next;
    });
    setSaveState("Unsaved");
    setMessage("");
    setAiSuggestion("");
  }

  function updatePageField(key: "hero_heading" | "hero_description", value: string) {
    mutate((current) => ({ ...current, [key]: value }));
  }

  function updatePageButton(index: number, patch: Partial<CmsPage["buttons"][number]>) {
    mutate((current) => {
      const buttons = [...current.buttons];
      while (buttons.length <= index) {
        buttons.push({ label: index === 0 ? "Start Chatting" : "Explore Features", url: index === 0 ? "/register" : "#features", style: index === 0 ? "primary" : "secondary" });
      }
      buttons[index] = { ...buttons[index], ...patch };
      return { ...current, buttons };
    });
  }

  function updateElementOverride(blockId: string, patch: { text?: string; href?: string; hidden?: boolean }) {
    const key = pageElementKey(blockId);
    if (!key) return;
    mutate((current) => ({
      ...current,
      element_overrides: {
        ...(current.element_overrides ?? {}),
        [key]: { ...(current.element_overrides?.[key] ?? {}), ...patch }
      }
    }));
  }

  function updateBlockField(blockId: string, key: string, value: string | number | boolean | unknown[] | null) {
    if (blockId === "hero_heading" || blockId === "hero_description") {
      updatePageField(blockId, String(value ?? ""));
      return;
    }
    const buttonMatch = blockId.match(/^page-button-(\d+)$/);
    if (buttonMatch) {
      const field = key.endsWith(".label") ? "label" : key.endsWith(".url") ? "url" : key.endsWith(".style") ? "style" : "label";
      updatePageButton(Number(buttonMatch[1]), { [field]: value } as Partial<CmsPage["buttons"][number]>);
      return;
    }
    mutate((current) => ({
      ...current,
      blocks: current.blocks.map((block) => block.id === blockId ? { ...block, content: { ...block.content, [key]: value } } : block)
    }));
  }

  function updateInline(selection: CmsSelection, value: string) {
    if (selection.locked || selection.global) return;
    if (pageElementKey(selection.blockId)) {
      updateElementOverride(selection.blockId, { text: value });
    } else if (selection.blockId === "hero_heading" || selection.blockId === "hero_description") {
      updatePageField(selection.blockId, value);
    } else if (selection.blockId.startsWith("page-button-")) {
      updateBlockField(selection.blockId, selection.field, value);
    } else if (selection.field) {
      updateBlockField(selection.blockId, selection.field, value);
    }
  }

  function addBlock(blockType: CmsBlockType) {
    mutate((current) => {
      const afterIndex = selectedBlockId ? current.blocks.findIndex((block) => block.id === selectedBlockId) : current.blocks.length - 1;
      const insertAt = afterIndex >= 0 ? afterIndex + 1 : current.blocks.length;
      const block = makeLocalBlock(blockType, insertAt);
      const selection = blockSelection(block);
      setPrimary(selection);
      setSelections([selection]);
      window.setTimeout(() => canvasRef.current?.querySelector<HTMLElement>(`[data-cms-block-id='${block.id}']`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return { ...current, blocks: [...current.blocks.slice(0, insertAt), block, ...current.blocks.slice(insertAt)].map((item, position) => ({ ...item, position })) };
    });
    setMode("select");
  }

  async function saveDraft(): Promise<CmsPage | null> {
    const source = latestRef.current;
    if (!token || !source || !canEdit || savingRef.current || !online) return source;
    savingRef.current = true;
    setSaveState("Saving");
    setError("");
    setErrorExpanded(false);
    try {
      const next = await cmsApi.saveDraft(token, source);
      const localCreated = new Map(
        source.blocks
          .map((block, index) => [block.id, next.blocks[index]?.id] as const)
          .filter(([blockId, savedId]) => blockId.startsWith("local-") && Boolean(savedId))
      );
      const current = latestRef.current;
      if (current && current !== source) {
        const rebased = {
          ...current,
          version: next.version,
          draftVersion: next.draftVersion,
          draft_version: next.draft_version,
          status: next.status,
          updated_at: next.updated_at,
          updated_by: next.updated_by,
          blocks: current.blocks.map((block) => localCreated.has(block.id) ? { ...block, id: localCreated.get(block.id)! } : block)
        };
        setPage(rebased);
        latestRef.current = rebased;
        setSaveState("Unsaved");
        localStorage.setItem(`auto-ai-cms-recovery:${rebased.id}`, JSON.stringify(rebased));
        return null;
      }
      setPage(next);
      latestRef.current = next;
      setPages((items) => items.map((item) => item.id === next.id ? next : item));
      setSaveState("Saved");
      setLastSavedAt(new Date());
      localStorage.removeItem(`auto-ai-cms-recovery:${next.id}`);
      if (primary?.blockId.startsWith("local-")) {
        const mapped = localCreated.get(primary.blockId);
        const mappedBlock = next.blocks.find((block) => block.id === mapped);
        if (mappedBlock) {
          const selection = blockSelection(mappedBlock);
          setPrimary(selection);
          setSelections([selection]);
        }
      }
      return next;
    } catch (requestError) {
      localStorage.setItem(`auto-ai-cms-recovery:${source.id}`, JSON.stringify(source));
      setSaveState(requestError instanceof ApiClientError && requestError.status === 409 ? "Conflict detected" : "Save failed");
      setError(requestError instanceof Error ? requestError.message : "Save failed");
      setErrorExpanded(true);
      return null;
    } finally {
      savingRef.current = false;
    }
  }

  useEffect(() => {
    if (saveState !== "Unsaved" || !online) return;
    const timeout = window.setTimeout(() => void saveDraft(), 2500);
    return () => window.clearTimeout(timeout);
  // saveDraft intentionally reads the current page from latestRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, saveState]);

  async function publish() {
    if (!token || !canPublish || saveState === "Publishing") return;
    if (blockingIssues.length) {
      setError(`Publish blocked: ${blockingIssues[0].message}`);
      setErrorExpanded(true);
      return;
    }
    const saved = ["Unsaved", "Save failed", "Conflict detected"].includes(saveState) ? await saveDraft() : page;
    if (!saved) return;
    setSaveState("Publishing");
    try {
      const next = await cmsApi.publish(token, saved, "Published from Edit Live Website");
      setPage(next);
      latestRef.current = next;
      setSaveState("Published");
      setMessage(`Published version ${next.version} at ${new Date(next.published_at ?? Date.now()).toLocaleString()}.`);
    } catch (requestError) {
      setSaveState("Publish failed");
      setError(requestError instanceof Error ? requestError.message : "Publish failed");
      setErrorExpanded(true);
    }
  }

  function undo() {
    if (!page || !history.length) return;
    const previous = history[history.length - 1];
    setFuture((items) => [clone(page), ...items]);
    setHistory((items) => items.slice(0, -1));
    setPage(previous);
    latestRef.current = previous;
    localStorage.setItem(`auto-ai-cms-recovery:${previous.id}`, JSON.stringify(previous));
    setSaveState("Unsaved");
  }

  function redo() {
    if (!page || !future.length) return;
    const next = future[0];
    setHistory((items) => [...items, clone(page)]);
    setFuture((items) => items.slice(1));
    setPage(next);
    latestRef.current = next;
    localStorage.setItem(`auto-ai-cms-recovery:${next.id}`, JSON.stringify(next));
    setSaveState("Unsaved");
  }

  function moveBlocks(blockIds: string[], direction: -1 | 1) {
    mutate((current) => {
      const ids = new Set(blockIds);
      const blocks = [...current.blocks];
      const indexes = blocks.map((block, index) => ids.has(block.id) ? index : -1).filter((index) => index >= 0);
      if (!indexes.length) return current;
      if (direction < 0) {
        for (const index of indexes) if (index > 0 && !ids.has(blocks[index - 1].id)) [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]];
      } else {
        for (const index of [...indexes].reverse()) if (index < blocks.length - 1 && !ids.has(blocks[index + 1].id)) [blocks[index], blocks[index + 1]] = [blocks[index + 1], blocks[index]];
      }
      return { ...current, blocks: blocks.map((block, position) => ({ ...block, position })) };
    });
  }

  function reorderBlocks(sourceId: string, targetId: string, before: boolean) {
    mutate((current) => {
      const source = current.blocks.find((block) => block.id === sourceId);
      const remaining = current.blocks.filter((block) => block.id !== sourceId);
      const targetIndex = remaining.findIndex((block) => block.id === targetId);
      if (!source || targetIndex < 0) return current;
      const insertAt = targetIndex + (before ? 0 : 1);
      return { ...current, blocks: [...remaining.slice(0, insertAt), source, ...remaining.slice(insertAt)].map((block, position) => ({ ...block, position })) };
    });
  }

  function duplicateBlocks(blockIds: string[]) {
    mutate((current) => {
      const buttonIndexes = blockIds.flatMap((id) => {
        const match = id.match(/^page-button-(\d+)$/);
        return match ? [Number(match[1])] : [];
      }).sort((a, b) => a - b);
      const buttons = [...current.buttons];
      let lastButtonIndex = -1;
      buttonIndexes.forEach((index, offset) => {
        const sourceIndex = index + offset;
        const source = buttons[sourceIndex];
        if (!source) return;
        lastButtonIndex = sourceIndex + 1;
        buttons.splice(lastButtonIndex, 0, { ...source, label: `${source.label} copy` });
      });
      let blocks = [...current.blocks];
      let last: CmsBlock | null = null;
      blockIds.forEach((id) => {
        const index = blocks.findIndex((block) => block.id === id);
        if (index < 0) return;
        const copy = duplicateLocalBlock(blocks[index], index + 1);
        blocks.splice(index + 1, 0, copy);
        last = copy;
      });
      if (last) {
        const selection = blockSelection(last);
        setPrimary(selection);
        setSelections([selection]);
      } else if (lastButtonIndex >= 0) {
        const selection = pageButtonSelection(lastButtonIndex);
        setPrimary(selection);
        setSelections([selection]);
      }
      return { ...current, buttons, blocks: blocks.map((block, position) => ({ ...block, position })) };
    });
  }

  function copyBlocks(blockIds: string[]) {
    if (!page) return;
    clipboardRef.current = page.blocks.filter((block) => blockIds.includes(block.id)).map((block) => clone({ ...page, blocks: [block] }).blocks[0]);
    void navigator.clipboard?.writeText(JSON.stringify({ type: "auto-ai/cms-blocks", blocks: clipboardRef.current })).catch(() => undefined);
    setMessage(`${clipboardRef.current.length} block${clipboardRef.current.length === 1 ? "" : "s"} copied.`);
  }

  function pasteBlocks() {
    if (!clipboardRef.current.length) return;
    mutate((current) => {
      const afterIndex = selectedBlockId ? current.blocks.findIndex((block) => block.id === selectedBlockId) : current.blocks.length - 1;
      const copies = clipboardRef.current.map((block, offset) => duplicateLocalBlock(block, afterIndex + 1 + offset));
      const blocks = [...current.blocks.slice(0, afterIndex + 1), ...copies, ...current.blocks.slice(afterIndex + 1)].map((block, position) => ({ ...block, position }));
      const selection = blockSelection(copies[copies.length - 1]);
      setPrimary(selection);
      setSelections(copies.map(blockSelection));
      return { ...current, blocks };
    });
  }

  function deleteBlocks(blockIds: string[]) {
    if (!blockIds.length || !window.confirm(`Delete ${blockIds.length} selected element${blockIds.length === 1 ? "" : "s"} from this draft?`)) return;
    mutate((current) => {
      const elementKeys = blockIds.map(pageElementKey).filter((key): key is string => Boolean(key));
      const elementOverrides = { ...(current.element_overrides ?? {}) };
      elementKeys.forEach((key) => {
        elementOverrides[key] = { ...(elementOverrides[key] ?? {}), hidden: true };
      });
      const pageButtonIndexes = blockIds.flatMap((id) => {
        const match = id.match(/^page-button-(\d+)$/);
        return match ? [Number(match[1])] : [];
      }).sort((a, b) => b - a);
      const buttons = [...current.buttons];
      pageButtonIndexes.forEach((index) => buttons.splice(index, 1));
      return {
        ...current,
        hero_heading: blockIds.includes("hero_heading") ? "" : current.hero_heading,
        hero_description: blockIds.includes("hero_description") ? "" : current.hero_description,
        buttons,
        element_overrides: elementOverrides,
        blocks: current.blocks.filter((block) => !blockIds.includes(block.id)).map((block, position) => ({ ...block, position }))
      };
    });
    setPrimary(null);
    setSelections([]);
  }

  function handleAction(action: CmsSelectionAction, selected: CmsSelection[]) {
    const ids = uniqueBlockIds(selected);
    if (action === "insert-after") {
      setMode("insert");
      return;
    }
    if (action === "move-up") moveBlocks(ids, -1);
    if (action === "move-down") moveBlocks(ids, 1);
    if (action === "duplicate") duplicateBlocks(ids);
    if (action === "copy") copyBlocks(ids);
    if (action === "hide") mutate((current) => {
      const elementOverrides = { ...(current.element_overrides ?? {}) };
      ids.map(pageElementKey).filter((key): key is string => Boolean(key)).forEach((key) => {
        elementOverrides[key] = { ...(elementOverrides[key] ?? {}), hidden: true };
      });
      return {
        ...current,
        element_overrides: elementOverrides,
        blocks: current.blocks.map((block) => ids.includes(block.id) ? { ...block, is_visible: false } : block)
      };
    });
    if (action === "lock") mutate((current) => ({ ...current, blocks: current.blocks.map((block) => ids.includes(block.id) ? { ...block, content: { ...block.content, editor_locked: !Boolean(block.content.editor_locked) } } : block) }));
    if (action === "delete") deleteBlocks(ids);
  }

  function handleSelect(selection: CmsSelection | null, additive = false) {
    if (!selection) {
      setPrimary(null);
      setSelections([]);
      return;
    }
    if (additive && selections.length && selections.every((item) => item.global === selection.global)) {
      const exists = selections.some((item) => item.key === selection.key);
      const next = exists ? selections.filter((item) => item.key !== selection.key) : [...selections, selection];
      setSelections(next);
      setPrimary(next[next.length - 1] ?? null);
    } else {
      setSelections([selection]);
      setPrimary(selection);
    }
    setAiSuggestion("");
  }

  function selectLayer(selection: CmsSelection) {
    handleSelect(selection);
    window.setTimeout(() => canvasRef.current?.querySelector<HTMLElement>(`[data-cms-block-id='${selection.blockId}']`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (mode === "preview" || isTypingTarget(event.target) || (event.target as Element | null)?.closest("[data-cms-editor-ui]")) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (modifier && key === "d" && primary) {
        event.preventDefault();
        duplicateBlocks(uniqueBlockIds(selections));
      } else if (modifier && key === "c" && primary) {
        event.preventDefault();
        copyBlocks(uniqueBlockIds(selections));
      } else if (modifier && key === "v") {
        event.preventDefault();
        pasteBlocks();
      } else if ((event.key === "Delete" || event.key === "Backspace") && primary && !primary.locked) {
        event.preventDefault();
        deleteBlocks(uniqueBlockIds(selections));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const matches = useMemo(() => {
    if (!page || !findText) return [] as Array<{ blockId: string; label: string }>;
    const query = findText.toLowerCase();
    const found: Array<{ blockId: string; label: string }> = [];
    if (page.hero_heading.toLowerCase().includes(query)) found.push({ blockId: "hero_heading", label: "Hero heading" });
    if (page.hero_description.toLowerCase().includes(query)) found.push({ blockId: "hero_description", label: "Hero paragraph" });
    page.buttons.forEach((button, index) => { if (button.label.toLowerCase().includes(query)) found.push({ blockId: `page-button-${index}`, label: `Button ${index + 1}` }); });
    Object.entries(page.element_overrides ?? {}).forEach(([key, override]) => {
      if (override.text?.toLowerCase().includes(query)) found.push({ blockId: `element:${key}`, label: key.replace(/[._-]/g, " ") });
    });
    page.blocks.forEach((block) => { if (JSON.stringify(block.content).toLowerCase().includes(query)) found.push({ blockId: block.id, label: labelCms(block.block_type) }); });
    return found;
  }, [findText, page]);

  function replaceAll() {
    if (!page || !findText || !matches.length || !window.confirm(`Replace ${matches.length} matching block${matches.length === 1 ? "" : "s"}?`)) return;
    mutate((current) => ({
      ...current,
      hero_heading: current.hero_heading.split(findText).join(replaceWith),
      hero_description: current.hero_description.split(findText).join(replaceWith),
      buttons: current.buttons.map((button) => ({ ...button, label: button.label.split(findText).join(replaceWith) })),
      element_overrides: Object.fromEntries(Object.entries(current.element_overrides ?? {}).map(([key, override]) => [key, {
        ...override,
        text: override.text?.split(findText).join(replaceWith)
      }])),
      blocks: current.blocks.map((block) => ({ ...block, content: replaceText(block.content, findText, replaceWith) as CmsBlock["content"] }))
    }));
  }

  function selectedText() {
    if (!page || !primary) return "";
    if (primary.blockId === "hero_heading") return page.hero_heading;
    if (primary.blockId === "hero_description") return page.hero_description;
    const elementKey = pageElementKey(primary.blockId);
    if (elementKey) return page.element_overrides?.[elementKey]?.text ?? primary.currentValue ?? "";
    const buttonMatch = primary.blockId.match(/^page-button-(\d+)$/);
    if (buttonMatch) return page.buttons[Number(buttonMatch[1])]?.label ?? "";
    const block = page.blocks.find((item) => item.id === primary.blockId);
    return block && primary.field ? String(block.content[primary.field] ?? "") : "";
  }

  async function requestAi(action: CmsAiAction) {
    const text = selectedText();
    if (!token || !primary || !text.trim()) return;
    setAiBusy(true);
    setError("");
    try {
      const response = await cmsApi.aiAssist(token, action, text);
      setAiSuggestion(response.suggestion);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "AI assistance failed");
    } finally {
      setAiBusy(false);
    }
  }

  const canvasWidth = device === "desktop" ? "100%" : device === "tablet" ? "768px" : "390px";
  const publicPath = page ? `/${page.slug === "home" ? "" : page.slug}` : "/";
  const filteredLayers = page?.blocks.filter((block) => !layerQuery || labelCms(block.block_type).toLowerCase().includes(layerQuery.toLowerCase())) ?? [];

  return (
    <section className={`live-site-editor mode-${mode}`} aria-label="Edit live website">
      <header className="live-site-toolbar" data-cms-editor-ui="true">
        <button className="chip-dark" onClick={() => navigate("/admin/website-builder/pages")} type="button"><X size={15} /> Exit</button>
        <select className="model-select-dark" aria-label="Select page" value={page?.id ?? ""} onChange={(event) => navigate(`/admin/live-pages/${event.target.value}`)}>
          {pages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <div className="live-mode-switch" role="group" aria-label="Editor mode">
          {editorModes.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={mode === item.id ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => setMode(item.id)} type="button"><Icon size={15} /> {item.label}</button>;
          })}
        </div>
        <button className="icon-button-dark" disabled={!history.length || mode === "preview"} aria-label="Undo" onClick={undo} type="button"><Undo2 size={15} /></button>
        <button className="icon-button-dark" disabled={!future.length || mode === "preview"} aria-label="Redo" onClick={redo} type="button"><Redo2 size={15} /></button>
        {devices.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} className={device === item.id ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => setDevice(item.id)} type="button"><Icon size={15} /> {item.label}</button>;
        })}
        <details className="live-toolbar-menu">
          <summary className="chip-dark"><Search size={15} /> Find</summary>
          <div className="live-toolbar-menu-panel live-find-panel">
            <input aria-label="Find text" placeholder="Find on page" value={findText} onChange={(event) => setFindText(event.target.value)} />
            <input aria-label="Replacement text" placeholder="Replace with" value={replaceWith} onChange={(event) => setReplaceWith(event.target.value)} />
            <span>{matches.length} matching block{matches.length === 1 ? "" : "s"}</span>
            {matches.slice(0, 5).map((match) => <button key={match.blockId} onClick={() => {
              const block = page?.blocks.find((item) => item.id === match.blockId);
              if (block) selectLayer(blockSelection(block));
              else if (pageElementKey(match.blockId)) selectLayer(pageElementSelection(pageElementKey(match.blockId)!, match.label, "text", "text"));
            }} type="button">{match.label}</button>)}
            <button disabled={!matches.length || !canEdit} onClick={replaceAll} type="button">Replace all</button>
          </div>
        </details>
        <button className="chip-dark" onClick={() => navigate("/admin/website-builder/theme")} type="button"><Palette size={15} /> Theme</button>
        <button className="chip-dark" onClick={() => navigate("/admin/website-builder/history")} type="button"><History size={15} /> History</button>
        {mode === "preview" ? (
          <button className="btn-primary" onClick={() => setMode("select")} type="button"><ChevronLeft size={15} /> Back to Edit</button>
        ) : <>
          {canEdit && <button className="btn-secondary" disabled={saveState === "Saving" || !online} onClick={() => void saveDraft()} type="button"><Save size={15} /> Save Draft</button>}
          {canPublish && <button className="btn-primary" disabled={saveState === "Publishing" || blockingIssues.length > 0 || !online} title={blockingIssues[0]?.message} onClick={() => void publish()} type="button"><Send size={15} /> Publish</button>}
        </>}
        <a className="chip-dark" href={`${publicPath}?cmsFresh=${Date.now()}`} target="_blank" rel="noreferrer"><FileText size={15} /> Open</a>
        <button
          aria-expanded={error ? errorExpanded : undefined}
          className={`live-save-state${!online ? " is-offline" : ""}${error ? " has-error" : ""}`}
          disabled={!error}
          onClick={() => error && setErrorExpanded((open) => !open)}
          type="button"
        >
          {online ? <Wifi size={13} /> : <WifiOff size={13} />}{online ? saveState : "Offline · Unsaved locally"}{lastSavedAt && saveState === "Saved" ? ` · ${lastSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
        </button>
      </header>

      {error && errorExpanded && <div className="live-editor-alert live-editor-alert-error" role="alert"><span>{error}</span>{saveState === "Save failed" && <button className="live-editor-alert-retry" disabled={!online || savingRef.current} onClick={() => void saveDraft()} type="button"><Save size={13} /> Retry</button>}<button aria-label="Dismiss error details" onClick={() => setErrorExpanded(false)} type="button"><X size={14} /></button></div>}
      {message && <div className="live-editor-alert live-editor-alert-success" role="status">{message}<button aria-label="Dismiss message" onClick={() => setMessage("")} type="button"><X size={14} /></button></div>}

      <div className={`live-editor-workspace${layersOpen && mode !== "preview" ? " has-layers" : ""}${propertiesOpen && mode !== "preview" ? " has-properties" : ""}`}>
        {mode !== "preview" && layersOpen && (
          <aside className="live-editor-panel live-layers-panel" data-cms-editor-ui="true" aria-label="Layers">
            <header><strong><Layers3 size={15} /> Layers</strong><button aria-label="Collapse layers" onClick={() => setLayersOpen(false)} type="button"><ChevronLeft size={15} /></button></header>
            <label className="live-panel-search"><Search size={14} /><input aria-label="Search layers" placeholder="Search layers" value={layerQuery} onChange={(event) => setLayerQuery(event.target.value)} /></label>
            <div className="live-layer-tree">
              <button className={selectedBlockId === "element:header" ? "live-layer-row is-selected" : "live-layer-row"} onClick={() => selectLayer(pageElementSelection("header", "Header", "header"))} type="button">Header</button>
              <details open>
                <summary>Page · {page?.title ?? "Loading"}</summary>
                <button className={selectedBlockId === "hero_heading" ? "live-layer-row is-selected" : "live-layer-row"} onClick={() => selectLayer({ key: selectionKey("hero_heading", "hero_heading"), blockId: "hero_heading", blockType: "heading", field: "hero_heading", label: "Heading", editable: "text", global: false, locked: false, protected: false, invalid: false })} type="button">Hero Heading</button>
                <button className={selectedBlockId === "hero_description" ? "live-layer-row is-selected" : "live-layer-row"} onClick={() => selectLayer({ key: selectionKey("hero_description", "hero_description"), blockId: "hero_description", blockType: "paragraph", field: "hero_description", label: "Paragraph", editable: "text", global: false, locked: false, protected: false, invalid: false })} type="button">Hero Paragraph</button>
                {page?.buttons.map((button, index) => <button className={selectedBlockId === `page-button-${index}` ? "live-layer-row is-selected" : "live-layer-row"} key={`${button.label}-${index}`} onClick={() => selectLayer(pageButtonSelection(index))} type="button">Button · {button.label}</button>)}
                {filteredLayers.map((block) => (
                  <div
                    className={selectedBlockId === block.id ? "live-layer-row is-selected" : "live-layer-row"}
                    draggable={!Boolean(block.content.editor_locked)}
                    key={block.id}
                    onDragStart={(event: DragEvent<HTMLDivElement>) => { layerDragRef.current = block.id; event.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { event.preventDefault(); if (layerDragRef.current) reorderBlocks(layerDragRef.current, block.id, true); layerDragRef.current = null; }}
                  >
                    <button onClick={() => selectLayer(blockSelection(block))} type="button">{labelCms(block.block_type)}</button>
                    <button aria-label={block.is_visible ? "Hide layer" : "Show layer"} onClick={() => mutate((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, is_visible: !item.is_visible } : item) }))} type="button">{block.is_visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
                  </div>
                ))}
              </details>
              <button className={selectedBlockId === "element:footer" ? "live-layer-row is-selected" : "live-layer-row"} onClick={() => selectLayer(pageElementSelection("footer", "Footer", "footer"))} type="button">Footer</button>
              {hiddenPageElements.length > 0 && <details open>
                <summary>Deleted elements · {hiddenPageElements.length}</summary>
                {hiddenPageElements.map(([key]) => <div className="live-layer-row is-hidden" key={key}>
                  <button onClick={() => selectLayer(pageElementSelection(key, key.replace(/[._-]/g, " ")))} type="button">{key.replace(/[._-]/g, " ")}</button>
                  <button aria-label={`Restore ${key}`} onClick={() => updateElementOverride(`element:${key}`, { hidden: false })} type="button"><Eye size={13} /></button>
                </div>)}
              </details>}
            </div>
          </aside>
        )}

        {mode !== "preview" && !layersOpen && <button className="live-panel-restore is-left" data-cms-editor-ui="true" onClick={() => setLayersOpen(true)} type="button"><ChevronRight size={14} /> Layers</button>}

        <main className={`live-site-stage live-site-stage-${device}${mode === "pan" ? " is-pan" : ""}`}>
          <div className="live-site-viewport" ref={canvasRef} style={{ width: canvasWidth }}>
            {!page ? (
              <div className="visual-builder-empty">Select a page.</div>
            ) : isHomePage(page) ? (
              <LandingPage editor={{ page, editMode: canEdit, previewMode: mode === "preview", selectedBlockId, onSelect: () => undefined, onPageFieldChange: updatePageField, onBlockFieldChange: updateBlockField }} />
            ) : (
              <CmsPageRenderer page={page} blocks={page.blocks} device={device} editMode={canEdit && mode !== "preview"} previewMode={mode === "preview"} selectedBlockId={selectedBlockId} onSelect={() => undefined} onInlineChange={updateBlockField} onPageFieldChange={updatePageField} />
            )}
          </div>
        </main>

        {mode !== "preview" && propertiesOpen && (
          <aside className="live-editor-panel live-properties-panel" data-cms-editor-ui="true" aria-label="Properties">
            <header><strong>Properties</strong><button aria-label="Collapse properties" onClick={() => setPropertiesOpen(false)} type="button"><ChevronRight size={15} /></button></header>
            {!primary && <div className="live-panel-empty"><MousePointer2 size={22} /><p>Select an element on the page.</p></div>}
            {primary && <>
              <div className="live-selection-summary">
                <strong>{primary.label}</strong>
                <small>Page › {primary.blockType}{primary.field ? ` › ${primary.field}` : ""}</small>
                <div>{primary.global && <span>Global component</span>}{primary.locked && <span>Locked</span>}{selections.length > 1 && <span>{selections.length} selected</span>}</div>
              </div>
              {primary.global && <div className="live-property-warning"><AlertTriangle size={15} /> This component is shared across pages. Edit its draft from Global Content to avoid accidental cross-page changes.</div>}
              {primary.locked && <div className="live-property-warning"><AlertTriangle size={15} /> Functional or protected content cannot be destructively edited.</div>}

              {primary.blockId === "hero_heading" && page && <label className="cms-field"><span>Heading</span><input disabled={!canEdit} value={page.hero_heading} onChange={(event) => updatePageField("hero_heading", event.target.value)} /></label>}
              {primary.blockId === "hero_description" && page && <label className="cms-field"><span>Paragraph</span><textarea disabled={!canEdit} rows={5} value={page.hero_description} onChange={(event) => updatePageField("hero_description", event.target.value)} /></label>}
              {primary.blockId.startsWith("page-button-") && page && (() => {
                const index = Number(primary.blockId.slice("page-button-".length));
                const button = page.buttons[index] ?? { label: "", url: "", style: "primary" as const };
                return <div className="space-y-3"><label className="cms-field"><span>Button text</span><input value={button.label} onChange={(event) => updatePageButton(index, { label: event.target.value })} /></label><label className="cms-field"><span>Link</span><input value={button.url} onChange={(event) => updatePageButton(index, { url: event.target.value })} /></label><label className="cms-field"><span>Style</span><select value={button.style} onChange={(event) => updatePageButton(index, { style: event.target.value as "primary" | "secondary" })}><option value="primary">Filled</option><option value="secondary">Outlined</option></select></label></div>;
              })()}

              {selectedElementKey && <div className="space-y-3">
                {primary.editable === "text" && <label className="cms-field"><span>Text</span><textarea rows={4} value={selectedElementOverride?.text ?? primary.currentValue ?? ""} onChange={(event) => updateElementOverride(primary.blockId, { text: event.target.value })} /></label>}
                {(primary.currentHref !== undefined || ["button", "link"].includes(primary.blockType)) && <label className="cms-field"><span>Link</span><input value={selectedElementOverride?.href ?? primary.currentHref ?? ""} onChange={(event) => updateElementOverride(primary.blockId, { href: event.target.value })} /></label>}
                <label className="cms-check"><input checked={!selectedElementOverride?.hidden} onChange={(event) => updateElementOverride(primary.blockId, { hidden: !event.target.checked })} type="checkbox" /> Visible</label>
                {selectedElementOverride?.hidden && <button className="btn-secondary" onClick={() => updateElementOverride(primary.blockId, { hidden: false })} type="button"><Eye size={14} /> Restore element</button>}
              </div>}

              {selectedBlock && <>
                {(cmsBlockDefinitionMap[selectedBlock.block_type]?.fields ?? []).map((field) => (
                  <label className="cms-field" key={field.key}>
                    <span>{field.label}</span>
                    {field.type === "select" ? <select disabled={!canEdit || primary.locked} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockField(selectedBlock.id, field.key, event.target.value)}>{(field.options ?? []).map((option) => <option key={option} value={option}>{labelCms(option)}</option>)}</select>
                      : field.type === "boolean" ? <input disabled={!canEdit || primary.locked} checked={Boolean(selectedBlock.content[field.key])} onChange={(event) => updateBlockField(selectedBlock.id, field.key, event.target.checked)} type="checkbox" />
                        : field.type === "textarea" ? <textarea disabled={!canEdit || primary.locked} rows={4} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockField(selectedBlock.id, field.key, event.target.value)} />
                          : <input disabled={!canEdit || primary.locked} type={field.type === "number" ? "number" : "text"} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockField(selectedBlock.id, field.key, field.type === "number" ? Number(event.target.value) : event.target.value)} />}
                  </label>
                ))}
                <details className="live-property-group">
                  <summary>Responsive visibility</summary>
                  {devices.map((item) => <label className="cms-check" key={item.id}><input checked={selectedBlock.content[`${item.id}_visible`] !== false} onChange={(event) => updateBlockField(selectedBlock.id, `${item.id}_visible`, event.target.checked)} type="checkbox" /> {item.label}</label>)}
                </details>
                <details className="live-property-group">
                  <summary>Advanced style</summary>
                  {styleFields.map((field) => <label className="cms-field" key={field.key}><span>{field.label}</span><select value={String(selectedBlock.content[field.key] ?? field.options[0])} onChange={(event) => updateBlockField(selectedBlock.id, field.key, event.target.value)}>{field.options.map((option) => <option key={option} value={option}>{labelCms(option)}</option>)}</select></label>)}
                  <label className="cms-field"><span>Width</span><select value={String(selectedBlock.content.width ?? 100)} onChange={(event) => updateBlockField(selectedBlock.id, "width", Number(event.target.value))}>{[25, 33, 50, 67, 75, 100].map((width) => <option key={width} value={width}>{width}%</option>)}</select></label>
                  <button className="chip-dark" onClick={() => mutate((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === selectedBlock.id ? { ...block, content: Object.fromEntries(Object.entries(block.content).filter(([key]) => !styleFields.some((field) => field.key === key) && key !== "width")) } : block) }))} type="button">Reset element style</button>
                </details>
                {variantOptions[selectedBlock.block_type] && <label className="cms-field"><span>Component variant</span><select value={String(selectedBlock.content.variant ?? variantOptions[selectedBlock.block_type]?.[0])} onChange={(event) => updateBlockField(selectedBlock.id, "variant", event.target.value)}>{variantOptions[selectedBlock.block_type]?.map((variant) => <option key={variant} value={variant}>{variant}</option>)}</select></label>}
              </>}

              {primary.editable === "text" && !primary.locked && <details className="live-property-group" open={Boolean(aiSuggestion)}>
                <summary><Sparkles size={14} /> AI assist</summary>
                <div className="live-ai-actions">
                  {(["rewrite", "shorten", "expand", "grammar", "professional", "translate_hindi", "translate_english", "cta", "seo_heading"] as CmsAiAction[]).map((action) => <button disabled={aiBusy} key={action} onClick={() => void requestAi(action)} type="button">{labelCms(action)}</button>)}
                </div>
                {aiSuggestion && <div className="live-ai-suggestion"><strong>Suggestion</strong><p>{aiSuggestion}</p><div><button className="btn-primary" onClick={() => { updateInline(primary, aiSuggestion); setAiSuggestion(""); }} type="button">Apply</button><button className="btn-secondary" onClick={() => setAiSuggestion("")} type="button">Keep original</button></div></div>}
              </details>}

              <details className="live-property-group" open={validationIssues.some((issue) => issue.blockId === primary.blockId)}>
                <summary>Accessibility & links</summary>
                {validationIssues.filter((issue) => issue.blockId === primary.blockId).map((issue) => <button className={`live-validation-issue is-${issue.severity}`} key={issue.id} type="button">{issue.severity === "error" ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}{issue.message}</button>)}
                {!validationIssues.some((issue) => issue.blockId === primary.blockId) && <p className="live-validation-clear"><CheckCircle2 size={14} /> No detected issues.</p>}
              </details>
            </>}
          </aside>
        )}

        {mode !== "preview" && !propertiesOpen && <button className="live-panel-restore is-right" data-cms-editor-ui="true" onClick={() => setPropertiesOpen(true)} type="button">Properties <ChevronLeft size={14} /></button>}
      </div>

      {mode === "insert" && (
        <aside className="live-insert-drawer" data-cms-editor-ui="true" aria-label="Insert blocks">
          <header><strong>Add to page</strong><button aria-label="Close insert panel" onClick={() => setMode("select")} type="button"><X size={15} /></button></header>
          <label className="live-panel-search"><Search size={14} /><input autoFocus aria-label="Search blocks" placeholder="Search blocks" value={insertQuery} onChange={(event) => setInsertQuery(event.target.value)} /></label>
          <div>{filteredInsertBlocks.map((item) => <button key={item.type} onClick={() => addBlock(item.type)} type="button"><Plus size={14} /><span><strong>{item.label}</strong><small>{item.category}</small></span></button>)}</div>
        </aside>
      )}

      <CmsSelectionEngine
        rootRef={canvasRef}
        mode={mode}
        primary={primary}
        selections={selections}
        onSelect={handleSelect}
        onInlineCommit={updateInline}
        onAction={handleAction}
        onReorder={reorderBlocks}
        onResize={(selection, width) => updateBlockField(selection.blockId, "width", width)}
      />
    </section>
  );
}
