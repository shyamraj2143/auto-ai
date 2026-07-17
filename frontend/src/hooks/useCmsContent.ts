import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { CmsAnnouncement, CmsFaq, CmsPage } from "../components/admin/cms/types";
import { isMobileAppRuntime } from "../utils/runtime";

function readCache<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(`auto-ai-published-content:${key}`);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, value: T) {
  try { localStorage.setItem(`auto-ai-published-content:${key}`, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ }
}

function usePublishedResource<T>(key: string, path: string, initial: T | null = null) {
  const [value, setValue] = useState<T | null>(() => readCache<T>(key) ?? initial);
  useEffect(() => {
    let active = true;
    const separator = path.includes("?") ? "&" : "?";
    const freshPath = `${path}${separator}_=${Date.now()}`;
    apiFetch<T>(freshPath, { operation: `content.public.${key}`, timeoutMs: 4000 })
      .then((next) => {
        if (!active) return;
        setValue(next);
        writeCache(key, next);
      })
      .catch(() => {
        // Cached or source-code fallback remains visible when CMS is unavailable.
      });
    return () => { active = false; };
  }, [key, path]);
  return value;
}

export function usePublishedPage(slug: string) {
  return usePublishedResource<CmsPage>(`page:${slug}`, `/content/public/pages/${slug}`);
}

export function usePublishedGlobals() {
  return usePublishedResource<Record<string, string>>("global:en", "/content/public/global?locale=en", {});
}

export function usePublishedFaqs() {
  return usePublishedResource<CmsFaq[]>("faqs", "/content/public/faqs", []);
}

export function usePublishedUiText() {
  return usePublishedResource<Record<string, string>>("ui_text:en", "/content/public/ui-text?locale=en", {});
}

export function usePublishedAnnouncements(audience = "all") {
  const target = isMobileAppRuntime() ? "android" : "website";
  return usePublishedResource<CmsAnnouncement[]>(`announcements:${target}:${audience}`, `/content/public/announcements?target=${target}&audience=${encodeURIComponent(audience)}`, []);
}
