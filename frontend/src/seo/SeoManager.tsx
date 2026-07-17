import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import seoData from "./seo-data.json";
import { apiFetch } from "../api/client";
import type { CmsPage } from "../components/admin/cms/types";

type SeoRoute = {
  path: string;
  public: boolean;
  sitemap: boolean;
  title: string;
  description: string;
  canonicalPath: string;
  ogType: string;
};

const routes = seoData.routes as SeoRoute[];
const siteUrl = seoData.siteUrl.replace(/\/$/, "");
const defaultImageUrl = absoluteUrl(seoData.defaultImage);

function absoluteUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${seoData.siteUrl.replace(/\/$/, "")}${normalized}`;
}

function routeForPath(pathname: string) {
  return routes.find((route) => route.path === pathname);
}

function upsertMeta(selector: string, attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
}

function upsertLink(rel: string, href: string) {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement("link");
    element.rel = rel;
    document.head.appendChild(element);
  }
  element.href = href;
}

function upsertJsonLd(id: string, data: Record<string, unknown>) {
  let element = document.getElementById(id) as HTMLScriptElement | null;
  if (!element) {
    element = document.createElement("script");
    element.id = id;
    element.type = "application/ld+json";
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(data);
}

function applyStructuredData() {
  const organizationId = `${siteUrl}/#organization`;

  upsertJsonLd("ld-json-organization", {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": organizationId,
    name: seoData.organization.name,
    alternateName: seoData.alternateNames,
    url: siteUrl,
    logo: defaultImageUrl,
    description: seoData.organization.description
  });

  upsertJsonLd("ld-json-website", {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteUrl}/#website`,
    name: seoData.siteName,
    alternateName: seoData.alternateNames,
    url: siteUrl,
    description: seoData.description,
    publisher: { "@id": organizationId }
  });

  upsertJsonLd("ld-json-software-application", {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${siteUrl}/#software`,
    name: seoData.application.name,
    alternateName: seoData.alternateNames,
    applicationCategory: seoData.application.category,
    operatingSystem: seoData.application.operatingSystem,
    url: siteUrl,
    image: defaultImageUrl,
    description: seoData.application.description,
    publisher: { "@id": organizationId },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD"
    }
  });
}

export function SeoManager() {
  const location = useLocation();

  useEffect(() => {
    const route = routeForPath(location.pathname);
    const title = route?.title ?? "Auto-AI | Secure AI Workspace";
    const description = route?.description ?? seoData.description;
    const canonicalUrl = absoluteUrl(route?.canonicalPath ?? location.pathname);
    const pageUrl = absoluteUrl(location.pathname);
    const robots = route?.public ? "index,follow" : "noindex,nofollow";

    document.title = title;
    upsertMeta('meta[name="description"]', "name", "description", description);
    upsertMeta('meta[name="robots"]', "name", "robots", robots);
    upsertMeta('meta[name="theme-color"]', "name", "theme-color", seoData.themeColor);
    upsertLink("canonical", canonicalUrl);

    upsertMeta('meta[property="og:site_name"]', "property", "og:site_name", seoData.siteName);
    upsertMeta('meta[property="og:title"]', "property", "og:title", title);
    upsertMeta('meta[property="og:description"]', "property", "og:description", description);
    upsertMeta('meta[property="og:url"]', "property", "og:url", pageUrl);
    upsertMeta('meta[property="og:type"]', "property", "og:type", route?.ogType ?? "website");
    upsertMeta('meta[property="og:image"]', "property", "og:image", defaultImageUrl);
    upsertMeta('meta[property="og:image:alt"]', "property", "og:image:alt", "Auto-AI app logo and brand mark");

    upsertMeta('meta[name="twitter:card"]', "name", "twitter:card", "summary_large_image");
    upsertMeta('meta[name="twitter:title"]', "name", "twitter:title", title);
    upsertMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
    upsertMeta('meta[name="twitter:image"]', "name", "twitter:image", defaultImageUrl);
    upsertMeta('meta[name="twitter:image:alt"]', "name", "twitter:image:alt", "Auto-AI app logo and brand mark");

    applyStructuredData();

    const cmsSlug = location.pathname === "/" ? "home" : location.pathname.replace(/^\/+|\/+$/g, "");
    if (!cmsSlug) return;
    let active = true;
    const applyCmsSeo = (page: CmsPage) => {
      if (!active || !page.seo) return;
      const cmsTitle = page.seo.title || page.title;
      const cmsDescription = page.seo.description || page.hero_description;
      const cmsCanonical = page.seo.canonical_url || absoluteUrl(location.pathname);
      const cmsImage = page.seo.og_image ? absoluteUrl(page.seo.og_image) : defaultImageUrl;
      document.title = cmsTitle;
      upsertMeta('meta[name="description"]', "name", "description", cmsDescription);
      upsertMeta('meta[name="robots"]', "name", "robots", page.seo.robots_index ? "index,follow" : "noindex,nofollow");
      upsertLink("canonical", cmsCanonical);
      upsertMeta('meta[property="og:title"]', "property", "og:title", page.seo.og_title || cmsTitle);
      upsertMeta('meta[property="og:description"]', "property", "og:description", page.seo.og_description || cmsDescription);
      upsertMeta('meta[property="og:image"]', "property", "og:image", cmsImage);
      upsertMeta('meta[name="twitter:title"]', "name", "twitter:title", page.seo.og_title || cmsTitle);
      upsertMeta('meta[name="twitter:description"]', "name", "twitter:description", page.seo.og_description || cmsDescription);
      upsertMeta('meta[name="twitter:image"]', "name", "twitter:image", cmsImage);
    };
    try {
      const cached = localStorage.getItem(`auto-ai-published-content:page:${cmsSlug}`);
      if (cached) applyCmsSeo(JSON.parse(cached) as CmsPage);
    } catch { /* Static SEO remains active. */ }
    void apiFetch<CmsPage>(`/content/public/pages/${cmsSlug}`, { operation: "content.public.seo", timeoutMs: 4000 })
      .then(applyCmsSeo)
      .catch(() => undefined);
    return () => { active = false; };
  }, [location.pathname]);

  return null;
}
