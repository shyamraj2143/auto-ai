import type { CmsBlock, CmsBlockType } from "./types";

export type CmsDevice = "desktop" | "tablet" | "mobile";
export type CmsFieldType = "text" | "textarea" | "url" | "image" | "select" | "number" | "boolean";

export type CmsBlockField = {
  key: string;
  label: string;
  type: CmsFieldType;
  options?: string[];
};

export type CmsBlockDefinition = {
  type: CmsBlockType;
  label: string;
  category: "Sections" | "Layout" | "Basic" | "Advanced" | "Forms";
  fields: CmsBlockField[];
  defaults: Record<string, unknown>;
};

export const cmsBlockDefinitions: CmsBlockDefinition[] = [
  { type: "hero_section", label: "Hero section", category: "Sections", fields: [{ key: "heading", label: "Heading", type: "text" }, { key: "description", label: "Description", type: "textarea" }, { key: "button_text", label: "Button text", type: "text" }, { key: "url", label: "Button link", type: "url" }], defaults: { heading: "Build faster with Auto-AI", description: "Add a focused value proposition.", button_text: "Get started", url: "/register" } },
  { type: "page_section", label: "Page section", category: "Sections", fields: [{ key: "name", label: "Name", type: "text" }, { key: "background", label: "Background", type: "select", options: ["default", "muted", "accent"] }, { key: "padding", label: "Padding", type: "select", options: ["compact", "normal", "large"] }], defaults: { name: "Section", background: "default", padding: "normal" } },
  { type: "contact_section", label: "Contact section", category: "Sections", fields: [{ key: "heading", label: "Heading", type: "text" }, { key: "email", label: "Email", type: "text" }, { key: "description", label: "Description", type: "textarea" }], defaults: { heading: "Contact us", email: "support@autoai.site.je", description: "Send us a message for support." } },
  { type: "app_download", label: "App download", category: "Sections", fields: [{ key: "heading", label: "Heading", type: "text" }, { key: "description", label: "Description", type: "textarea" }, { key: "url", label: "Download link", type: "url" }], defaults: { heading: "Get the Android app", description: "Use Auto-AI on mobile.", url: "/download" } },
  { type: "container", label: "Container", category: "Layout", fields: [{ key: "name", label: "Name", type: "text" }, { key: "width", label: "Width", type: "select", options: ["narrow", "normal", "wide"] }, { key: "alignment", label: "Alignment", type: "select", options: ["left", "center", "right"] }], defaults: { name: "Container", width: "normal", alignment: "left" } },
  { type: "one_column", label: "One column", category: "Layout", fields: [{ key: "heading", label: "Heading", type: "text" }, { key: "text", label: "Text", type: "textarea" }], defaults: { heading: "One column", text: "Content" } },
  { type: "two_columns", label: "Two columns", category: "Layout", fields: [{ key: "left", label: "Left column", type: "textarea" }, { key: "right", label: "Right column", type: "textarea" }], defaults: { left: "Left content", right: "Right content" } },
  { type: "three_columns", label: "Three columns", category: "Layout", fields: [{ key: "columns", label: "Columns", type: "textarea" }], defaults: { columns: "First\nSecond\nThird" } },
  { type: "grid", label: "Grid", category: "Layout", fields: [{ key: "items", label: "Items", type: "textarea" }, { key: "columns", label: "Desktop columns", type: "number" }], defaults: { items: "Item one\nItem two\nItem three", columns: 3 } },
  { type: "stack", label: "Stack", category: "Layout", fields: [{ key: "items", label: "Items", type: "textarea" }], defaults: { items: "First item\nSecond item" } },
  { type: "tabs", label: "Tabs", category: "Layout", fields: [{ key: "items", label: "Tabs", type: "textarea" }], defaults: { items: "Overview: Add overview content\nDetails: Add details content" } },
  { type: "accordion", label: "Accordion", category: "Layout", fields: [{ key: "items", label: "Items", type: "textarea" }], defaults: { items: "Question: Answer" } },
  { type: "heading", label: "Heading", category: "Basic", fields: [{ key: "text", label: "Text", type: "text" }, { key: "level", label: "Level", type: "select", options: ["h1", "h2", "h3"] }, { key: "align", label: "Alignment", type: "select", options: ["left", "center", "right"] }], defaults: { text: "New heading", level: "h2", align: "left" } },
  { type: "paragraph", label: "Paragraph", category: "Basic", fields: [{ key: "text", label: "Text", type: "textarea" }, { key: "align", label: "Alignment", type: "select", options: ["left", "center", "right"] }], defaults: { text: "New paragraph", align: "left" } },
  { type: "rich_text", label: "Rich text", category: "Basic", fields: [{ key: "text", label: "Text", type: "textarea" }], defaults: { text: "Safe formatted text" } },
  { type: "button", label: "Button", category: "Basic", fields: [{ key: "label", label: "Text", type: "text" }, { key: "url", label: "Link", type: "url" }, { key: "style", label: "Style", type: "select", options: ["primary", "secondary"] }, { key: "target", label: "Open in", type: "select", options: ["same", "new"] }], defaults: { label: "Button", url: "/", style: "primary", target: "same" } },
  { type: "link", label: "Link", category: "Basic", fields: [{ key: "label", label: "Text", type: "text" }, { key: "url", label: "URL", type: "url" }], defaults: { label: "Link", url: "/" } },
  { type: "image", label: "Image", category: "Basic", fields: [{ key: "image_url", label: "Image URL", type: "image" }, { key: "alt", label: "Alt text", type: "text" }, { key: "caption", label: "Caption", type: "text" }], defaults: { image_url: "", alt: "", caption: "" } },
  { type: "video_link", label: "Video embed", category: "Basic", fields: [{ key: "title", label: "Title", type: "text" }, { key: "video_url", label: "Video URL", type: "url" }], defaults: { title: "Video", video_url: "" } },
  { type: "divider", label: "Divider", category: "Basic", fields: [], defaults: {} },
  { type: "spacer", label: "Spacer", category: "Basic", fields: [{ key: "size", label: "Size", type: "select", options: ["small", "medium", "large"] }], defaults: { size: "medium" } },
  { type: "list", label: "List", category: "Basic", fields: [{ key: "items", label: "Items", type: "textarea" }], defaults: { items: "First item\nSecond item\nThird item" } },
  { type: "quote", label: "Quote", category: "Basic", fields: [{ key: "quote", label: "Quote", type: "textarea" }, { key: "author", label: "Author", type: "text" }], defaults: { quote: "Add a quote.", author: "" } },
  { type: "badge", label: "Badge", category: "Basic", fields: [{ key: "text", label: "Text", type: "text" }], defaults: { text: "New" } },
  { type: "feature_card", label: "Feature card", category: "Advanced", fields: [{ key: "title", label: "Title", type: "text" }, { key: "body", label: "Body", type: "textarea" }], defaults: { title: "Feature", body: "Feature description" } },
  { type: "feature_grid", label: "Feature cards", category: "Advanced", fields: [{ key: "title", label: "Title", type: "text" }, { key: "items", label: "Items", type: "textarea" }], defaults: { title: "Features", items: "Fast chat\nFile uploads\nVoice input" } },
  { type: "pricing_cards", label: "Pricing cards", category: "Advanced", fields: [{ key: "items", label: "Plans", type: "textarea" }], defaults: { items: "Free: Start with essentials\nPro: More capacity\nUltra: Maximum performance" } },
  { type: "pricing_description", label: "Pricing text", category: "Advanced", fields: [{ key: "text", label: "Text", type: "textarea" }], defaults: { text: "Flexible plans for every workload." } },
  { type: "testimonial", label: "Testimonial", category: "Advanced", fields: [{ key: "quote", label: "Quote", type: "textarea" }, { key: "author", label: "Author", type: "text" }], defaults: { quote: "Auto-AI helps me move faster.", author: "Customer" } },
  { type: "testimonials", label: "Testimonials", category: "Advanced", fields: [{ key: "items", label: "Items", type: "textarea" }], defaults: { items: "Customer: Auto-AI helps me move faster." } },
  { type: "faq", label: "FAQ", category: "Advanced", fields: [{ key: "question", label: "Question", type: "text" }, { key: "answer", label: "Answer", type: "textarea" }], defaults: { question: "Question?", answer: "Answer" } },
  { type: "statistics", label: "Statistics", category: "Advanced", fields: [{ key: "items", label: "Stats", type: "textarea" }], defaults: { items: "24/7: Availability\n4: Plan options\n1: Unified workspace" } },
  { type: "call_to_action", label: "Call to action", category: "Advanced", fields: [{ key: "heading", label: "Heading", type: "text" }, { key: "description", label: "Description", type: "textarea" }, { key: "button_text", label: "Button text", type: "text" }, { key: "url", label: "URL", type: "url" }], defaults: { heading: "Ready to begin?", description: "Create your workspace.", button_text: "Create account", url: "/register" } },
  { type: "announcement_banner", label: "Announcement", category: "Advanced", fields: [{ key: "title", label: "Title", type: "text" }, { key: "message", label: "Message", type: "textarea" }, { key: "target_url", label: "URL", type: "url" }], defaults: { title: "Announcement", message: "Share an update.", target_url: "/" } },
  { type: "navigation", label: "Navigation", category: "Advanced", fields: [{ key: "items", label: "Links", type: "textarea" }], defaults: { items: "Home:/\nPricing:/pricing\nDownload:/download" } },
  { type: "footer", label: "Footer", category: "Advanced", fields: [{ key: "description", label: "Description", type: "textarea" }, { key: "copyright", label: "Copyright", type: "text" }], defaults: { description: "Auto-AI workspace", copyright: "Copyright Auto-AI. All rights reserved." } },
  { type: "social_links", label: "Social links", category: "Advanced", fields: [{ key: "items", label: "Links", type: "textarea" }], defaults: { items: "Website:https://autoai.site.je" } },
  { type: "team_section", label: "Team section", category: "Advanced", fields: [{ key: "items", label: "Members", type: "textarea" }], defaults: { items: "Team member: Role" } },
  { type: "form", label: "Form shell", category: "Forms", fields: [{ key: "title", label: "Title", type: "text" }, { key: "success_message", label: "Success message", type: "text" }], defaults: { title: "Contact form", success_message: "Thanks. Your message was received." } },
  { type: "text_input", label: "Text input", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }, { key: "required", label: "Required", type: "boolean" }], defaults: { label: "Name", required: true } },
  { type: "email_input", label: "Email input", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }, { key: "required", label: "Required", type: "boolean" }], defaults: { label: "Email", required: true } },
  { type: "phone_input", label: "Phone input", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }], defaults: { label: "Phone" } },
  { type: "text_area", label: "Text area", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }, { key: "required", label: "Required", type: "boolean" }], defaults: { label: "Message", required: true } },
  { type: "radio_group", label: "Radio buttons", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }, { key: "options", label: "Options", type: "textarea" }], defaults: { label: "Choose one", options: "Option one\nOption two" } },
  { type: "checkbox_group", label: "Checkboxes", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }, { key: "options", label: "Options", type: "textarea" }], defaults: { label: "Choose options", options: "Option one\nOption two" } },
  { type: "dropdown", label: "Dropdown", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }, { key: "options", label: "Options", type: "textarea" }], defaults: { label: "Select", options: "Option one\nOption two" } },
  { type: "date_input", label: "Date", category: "Forms", fields: [{ key: "label", label: "Label", type: "text" }], defaults: { label: "Date" } },
  { type: "submit_button", label: "Submit button", category: "Forms", fields: [{ key: "label", label: "Text", type: "text" }], defaults: { label: "Submit" } },
  { type: "success_message", label: "Success message", category: "Forms", fields: [{ key: "text", label: "Text", type: "text" }], defaults: { text: "Success." } },
  { type: "error_message", label: "Error message", category: "Forms", fields: [{ key: "text", label: "Text", type: "text" }], defaults: { text: "Something went wrong." } },
  { type: "icon", label: "Icon", category: "Basic", fields: [{ key: "name", label: "Name", type: "text" }], defaults: { name: "sparkles" } }
];

export const cmsBlockDefinitionMap = Object.fromEntries(cmsBlockDefinitions.map((item) => [item.type, item])) as Record<CmsBlockType, CmsBlockDefinition>;

export function labelCms(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function defaultBlockContent(blockType: CmsBlockType): Record<string, unknown> {
  return { ...(cmsBlockDefinitionMap[blockType]?.defaults ?? { text: "New content" }) };
}

export function makeLocalBlock(blockType: CmsBlockType, position: number): CmsBlock {
  return {
    id: `local-${crypto.randomUUID()}`,
    block_type: blockType,
    content: defaultBlockContent(blockType) as CmsBlock["content"],
    position,
    is_visible: true
  };
}

export function duplicateLocalBlock(block: CmsBlock, position: number): CmsBlock {
  return {
    ...block,
    id: `local-${crypto.randomUUID()}`,
    position,
    content: JSON.parse(JSON.stringify(block.content)) as CmsBlock["content"]
  };
}

export function lines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function namedLines(value: unknown): Array<{ title: string; body: string }> {
  return lines(value).map((line) => {
    const [title, ...rest] = line.split(":");
    return { title: title?.trim() || line, body: rest.join(":").trim() };
  });
}

export function textValue(block: CmsBlock, ...keys: string[]) {
  for (const key of keys) {
    const value = block.content[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}
