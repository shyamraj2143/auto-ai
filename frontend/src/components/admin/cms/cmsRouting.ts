export type CmsSection = "pages" | "create" | "global" | "ui" | "announcements" | "faqs" | "media" | "forms" | "theme" | "seo" | "drafts" | "revisions" | "live";

export function cmsSectionFromPath(pathname: string): CmsSection {
  const path = pathname.replace(/\/+$/, "");
  if (path.startsWith("/admin/live-pages")) return "live";
  if (path.endsWith("/create")) return "create";
  if (path.endsWith("/header")) return "global";
  if (path.endsWith("/footer")) return "ui";
  if (path.endsWith("/forms")) return "forms";
  if (path.endsWith("/media")) return "media";
  if (path.endsWith("/theme")) return "theme";
  if (path.endsWith("/reusable-sections")) return "announcements";
  if (path.endsWith("/faq")) return "faqs";
  if (path.endsWith("/seo")) return "seo";
  if (path.endsWith("/drafts")) return "drafts";
  if (path.endsWith("/history")) return "revisions";
  return "pages";
}
