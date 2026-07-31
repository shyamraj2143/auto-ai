import type { UserRole } from "../types";

const ADMIN_PANEL_ROLES = new Set<UserRole>([
  "admin",
  "super_admin",
  "administrator",
  "content_admin",
  "content_editor",
  "content_viewer"
]);

export function isAdminPanelRole(role?: string | null): boolean {
  return Boolean(role && ADMIN_PANEL_ROLES.has(role as UserRole));
}

export function isFullAdminRole(role?: string | null): boolean {
  return role === "admin" || role === "super_admin" || role === "administrator";
}
