import { useMemo, type ReactNode } from "react";
import { FileClock, FileText, Globe2, History, Image, LayoutTemplate, Megaphone, Plus, Search, Settings2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../../contexts/AuthContext";
import type { CmsRole } from "./types";
import { CmsCollectionManager } from "./CmsCollectionManager";
import { CmsRevisionManager } from "./CmsRevisionManager";
import { VisualWebsiteBuilder } from "./VisualWebsiteBuilder";
import { LivePageEditor } from "./LivePageEditor";
import { cmsSectionFromPath, type CmsSection } from "./cmsRouting";

const sections: Array<{ id: CmsSection; label: string; icon: ReactNode; path: string }> = [
  { id: "pages", label: "All Pages", icon: <LayoutTemplate size={16} />, path: "/admin/website-builder/pages" },
  { id: "create", label: "Create Page", icon: <Plus size={16} />, path: "/admin/website-builder/create" },
  { id: "global", label: "Global Header", icon: <Globe2 size={16} />, path: "/admin/website-builder/header" },
  { id: "ui", label: "Global Footer", icon: <Settings2 size={16} />, path: "/admin/website-builder/footer" },
  { id: "forms", label: "Forms", icon: <FileText size={16} />, path: "/admin/website-builder/forms" },
  { id: "media", label: "Media Library", icon: <Image size={16} />, path: "/admin/website-builder/media" },
  { id: "theme", label: "Theme Settings", icon: <Settings2 size={16} />, path: "/admin/website-builder/theme" },
  { id: "announcements", label: "Reusable Sections", icon: <Megaphone size={16} />, path: "/admin/website-builder/reusable-sections" },
  { id: "faqs", label: "Reusable FAQ", icon: <FileText size={16} />, path: "/admin/website-builder/faq" },
  { id: "seo", label: "SEO Settings", icon: <Search size={16} />, path: "/admin/website-builder/seo" },
  { id: "drafts", label: "Drafts", icon: <FileClock size={16} />, path: "/admin/website-builder/drafts" },
  { id: "revisions", label: "Revision History", icon: <History size={16} />, path: "/admin/website-builder/history" }
];

const cmsRoles = new Set<CmsRole>(["admin", "super_admin", "content_admin", "content_editor", "content_viewer"]);

export function ContentManager() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const section = useMemo<CmsSection>(() => cmsSectionFromPath(location.pathname), [location.pathname]);
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
              onClick={() => navigate(item.path)}
              type="button"
            >
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
          <button
            className={section === "live" ? "cms-nav-item cms-nav-item-active" : "cms-nav-item"}
            onClick={() => navigate("/admin/live-pages")}
            type="button"
          >
            <LayoutTemplate size={16} /><span>Edit Live Pages</span>
          </button>
        </nav>
      </aside>

      <div className="min-w-0">
        {(section === "pages" || section === "create" || section === "seo" || section === "drafts") && (
          <VisualWebsiteBuilder
            section={section === "create" ? "create-page" : section === "drafts" ? "drafts" : section === "seo" ? "seo" : "all-pages"}
            canEdit={permissions.canEdit}
            canPublish={permissions.canPublish}
          />
        )}
        {section === "forms" && <CmsCollectionManager section="forms" canEdit={permissions.canEdit} canPublish={permissions.canPublish} />}
        {(section === "global" || section === "ui" || section === "announcements" || section === "faqs" || section === "media" || section === "theme") && (
          <CmsCollectionManager section={section === "theme" ? "global" : section} canEdit={permissions.canEdit} canPublish={permissions.canPublish} />
        )}
        {section === "revisions" && <CmsRevisionManager canPublish={permissions.canPublish} />}
        {section === "live" && <LivePageEditor canEdit={permissions.canEdit} canPublish={permissions.canPublish} />}
      </div>
    </div>
  );
}
