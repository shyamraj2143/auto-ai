import { useMemo, useState, type ReactNode } from "react";
import { FileClock, FileText, Globe2, History, Image, LayoutTemplate, Megaphone, Plus, Search, Settings2 } from "lucide-react";
import { useAuth } from "../../../contexts/AuthContext";
import type { CmsRole } from "./types";
import { CmsCollectionManager } from "./CmsCollectionManager";
import { CmsPageManager } from "./CmsPageManager";
import { CmsRevisionManager } from "./CmsRevisionManager";
import { VisualWebsiteBuilder } from "./VisualWebsiteBuilder";

export type CmsSection = "pages" | "create" | "global" | "ui" | "announcements" | "faqs" | "media" | "forms" | "theme" | "seo" | "drafts" | "revisions";

const sections: Array<{ id: CmsSection; label: string; icon: ReactNode }> = [
  { id: "pages", label: "All Pages", icon: <LayoutTemplate size={16} /> },
  { id: "create", label: "Create Page", icon: <Plus size={16} /> },
  { id: "global", label: "Global Header", icon: <Globe2 size={16} /> },
  { id: "ui", label: "Global Footer", icon: <Settings2 size={16} /> },
  { id: "forms", label: "Forms", icon: <FileText size={16} /> },
  { id: "media", label: "Media Library", icon: <Image size={16} /> },
  { id: "theme", label: "Theme Settings", icon: <Settings2 size={16} /> },
  { id: "announcements", label: "Reusable Sections", icon: <Megaphone size={16} /> },
  { id: "faqs", label: "Reusable FAQ", icon: <FileText size={16} /> },
  { id: "seo", label: "SEO Settings", icon: <Search size={16} /> },
  { id: "drafts", label: "Drafts", icon: <FileClock size={16} /> },
  { id: "revisions", label: "Revision History", icon: <History size={16} /> }
];

const cmsRoles = new Set<CmsRole>(["admin", "super_admin", "content_admin", "content_editor", "content_viewer"]);

export function ContentManager() {
  const { user } = useAuth();
  const [section, setSection] = useState<CmsSection>("pages");
  const role = user?.role as CmsRole | undefined;
  const permissions = useMemo(() => ({
    canView: Boolean(role && cmsRoles.has(role)),
    canEdit: role !== "content_viewer",
    canPublish: role === "admin" || role === "super_admin" || role === "content_admin"
  }), [role]);

  if (!permissions.canView) {
    return <p className="text-sm text-red-200">Content Manager permission is required.</p>;
  }

  return (
    <div className="cms-shell grid min-h-[640px] gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="cms-nav border-r border-white/10 pr-3" aria-label="Content Manager">
        <div className="mb-4 flex items-center gap-2 px-2">
          <LayoutTemplate size={18} className="text-cyan-200" />
          <div>
            <h2 className="text-sm font-semibold text-white">Website Builder</h2>
            <p className="text-[11px] text-slate-400">Visual draft, preview and publish</p>
          </div>
        </div>
        <nav className="grid gap-1">
          {sections.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "cms-nav-item cms-nav-item-active" : "cms-nav-item"}
              onClick={() => setSection(item.id)}
              type="button"
            >
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="min-w-0">
        {(section === "pages" || section === "create" || section === "seo" || section === "drafts" || section === "forms") && (
          <VisualWebsiteBuilder
            section={section === "create" ? "create-page" : section === "drafts" ? "drafts" : section === "seo" ? "seo" : "all-pages"}
            canEdit={permissions.canEdit}
            canPublish={permissions.canPublish}
          />
        )}
        {(section === "global" || section === "ui" || section === "announcements" || section === "faqs" || section === "media" || section === "theme") && (
          <CmsCollectionManager section={section === "theme" ? "global" : section} canEdit={permissions.canEdit} canPublish={permissions.canPublish} />
        )}
        {section === "revisions" && <CmsRevisionManager canPublish={permissions.canPublish} />}
      </div>
    </div>
  );
}
