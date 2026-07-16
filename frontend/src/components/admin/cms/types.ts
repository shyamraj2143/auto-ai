export type CmsStatus = "draft" | "published" | "scheduled" | "archived";
export type CmsRole = "admin" | "super_admin" | "content_admin" | "content_editor" | "content_viewer";
export type CmsBlockType =
  | "page_section" | "container" | "one_column" | "two_columns" | "three_columns" | "grid" | "stack" | "tabs" | "accordion"
  | "heading" | "paragraph" | "rich_text" | "button" | "link" | "image" | "video_link" | "icon" | "divider" | "spacer"
  | "list" | "quote" | "badge" | "feature_card" | "feature_grid" | "pricing_description" | "pricing_cards" | "testimonial"
  | "testimonials" | "faq" | "statistics" | "call_to_action" | "download_button" | "app_download" | "contact_section"
  | "team_section" | "announcement_banner" | "navigation" | "footer" | "social_links" | "form" | "text_input"
  | "email_input" | "phone_input" | "text_area" | "radio_group" | "checkbox_group" | "dropdown" | "date_input"
  | "submit_button" | "success_message" | "error_message" | "hero_section";

export type CmsSeo = {
  title: string;
  description: string;
  canonical_url: string;
  og_title: string;
  og_description: string;
  og_image: string;
  robots_index: boolean;
  sitemap: boolean;
};

export type CmsButton = { label: string; url: string; style: "primary" | "secondary" };
export type CmsBlock = {
  id: string;
  block_type: CmsBlockType;
  content: Record<string, string | number | boolean | null | unknown[]>;
  position: number;
  is_visible: boolean;
};

export type CmsPage = {
  id: string;
  page_key: string;
  title: string;
  slug: string;
  status: CmsStatus;
  hero_heading: string;
  hero_description: string;
  buttons: CmsButton[];
  seo: CmsSeo;
  blocks: CmsBlock[];
  deleted_blocks?: CmsBlock[];
  version: number;
  scheduled_at?: string | null;
  published_at?: string | null;
  created_at: string;
  updated_at: string;
  updated_by?: string | null;
};

export type CmsTextEntry = {
  id: string;
  key: string;
  group: string;
  locale: string;
  default_value: string;
  draft_value: string;
  published_value?: string | null;
  status: CmsStatus;
  version: number;
  mandatory: boolean;
  updated_at: string;
};

export type CmsFaq = {
  id: string;
  question: string;
  answer: string;
  category: string;
  position: number;
  enabled: boolean;
  status: CmsStatus;
  version: number;
  updated_at: string;
};

export type CmsAnnouncement = {
  id: string;
  title: string;
  message: string;
  action_text: string;
  target_url: string;
  start_at?: string | null;
  end_at?: string | null;
  status: CmsStatus;
  targets: "website" | "android" | "both";
  audience: "all" | "free" | "paid" | "admin";
  dismissible: boolean;
  version: number;
  updated_at: string;
};

export type CmsMedia = {
  id: string;
  filename: string;
  url: string;
  mime_type: string;
  file_size: number;
  alt_text: string;
  caption: string;
  checksum_sha256: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
};

export type CmsRevision = {
  id: string;
  content_type: string;
  content_id: string;
  action: string;
  status: CmsStatus;
  version: number;
  change_summary: string;
  snapshot: Record<string, unknown>;
  changes: Record<string, { previous: unknown; new: unknown }>;
  created_by?: string | null;
  administrator: string;
  created_at: string;
};

export type CmsAudit = {
  id: string;
  administrator: string;
  action: string;
  content_type: string;
  content_id: string;
  summary: string;
  created_at: string;
};

export type CmsPageResult<T> = { items: T[]; total: number; page: number; page_size: number };
