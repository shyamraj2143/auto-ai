import { Download, ExternalLink } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import { labelCms, lines, namedLines, textValue, type CmsDevice } from "../admin/cms/cmsBlockLibrary";
import type { CmsBlock, CmsPage } from "../admin/cms/types";
import { cmsKineticRevealVariant, isCmsKineticRevealEnabled, LANDING_KINETIC_MAP } from "../../motion/kineticRevealConfig";

type RendererProps = {
  page?: CmsPage;
  block?: CmsBlock;
  blocks?: CmsBlock[];
  device?: CmsDevice;
  editMode?: boolean;
  previewMode?: boolean;
  selectedBlockId?: string | null;
  onSelect?: (blockId: string | null) => void;
  onInlineChange?: (blockId: string, key: string, value: string) => void;
  onPageFieldChange?: (key: "hero_heading" | "hero_description", value: string) => void;
};

function editableProps(props: RendererProps, block: CmsBlock, key: string) {
  if (!props.editMode) return {};
  return {
    "data-cms-editable": "text",
    "data-cms-block-id": block.id,
    "data-cms-block-type": block.block_type,
    "data-cms-field": key,
    "data-cms-global": "false",
    "data-cms-locked": String(Boolean(block.content.editor_locked)),
    "data-cms-label": key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  };
}

function Shell({ block, props, children }: { block: CmsBlock; props: RendererProps; children: ReactNode }) {
  const breakpointVisible = block.content[`${props.device ?? "desktop"}_visible`] !== false;
  if ((!block.is_visible || !breakpointVisible) && !props.editMode) return null;
  const locked = Boolean(block.content.editor_locked);
  const protectedBlock = ["form", "submit_button"].includes(block.block_type);
  const width = [25, 33, 50, 67, 75, 100].includes(Number(block.content.width)) ? Number(block.content.width) : 100;
  const style = width < 100 ? { width: `${width}%` } as CSSProperties : undefined;
  const tokenValues: Record<string, string[]> = {
    text_color: ["default", "muted", "primary", "accent"], background: ["default", "muted", "accent"],
    radius: ["none", "small", "medium", "large"], shadow: ["none", "soft", "elevated"],
    padding: ["compact", "normal", "large"], margin: ["none", "small", "normal", "large"], gap: ["small", "normal", "large"]
  };
  const styleClasses = Object.entries(tokenValues).flatMap(([key, allowed]) => {
    const value = String(block.content[key] ?? "");
    return allowed.includes(value) ? [`cms-style-${key.replace("_", "-")}-${value}`] : [];
  });
  const variant = String(block.content.variant ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const editorMetadata = props.editMode ? {
    "data-cms-block-id": block.id,
    "data-cms-block-type": block.block_type,
    "data-cms-field": "",
    "data-cms-editable": "container",
    "data-cms-global": String(false),
    "data-cms-locked": String(locked || protectedBlock),
    "data-cms-protected": String(protectedBlock),
    "data-cms-label": labelCms(block.block_type),
    draggable: !locked && !protectedBlock
  } : {};
  const kineticRevealVariant = isCmsKineticRevealEnabled(props.editMode, props.previewMode) ? cmsKineticRevealVariant(block.block_type) : undefined;
  const kineticGroup = ["page_section", "container", "feature_card", "feature_grid", "testimonials", "statistics", "team_section"].includes(block.block_type);
  return (
    <div
      className={[
        "cms-render-block",
        ...styleClasses,
        variant ? `cms-variant-${variant}` : "",
        props.editMode ? "cms-render-editable" : "",
        props.selectedBlockId === block.id ? "cms-render-selected" : "",
        !block.is_visible || !breakpointVisible ? "cms-render-hidden" : ""
      ].filter(Boolean).join(" ")}
      style={style}
      data-kinetic-reveal={kineticRevealVariant}
      data-kinetic-group={kineticGroup || undefined}
      {...editorMetadata}
    >
      {children}
    </div>
  );
}

function SafeLink({ block, className, children, props, textField = "label" }: { block: CmsBlock; className: string; children: ReactNode; props: RendererProps; textField?: string }) {
  const url = textValue(block, "url", "href", "target_url");
  const metadata = editableProps(props, block, textField);
  if (!url) return <span className={className} {...metadata}>{children}</span>;
  if (props.editMode && !props.previewMode) return <button className={className} {...metadata} type="button">{children}</button>;
  if (url.startsWith("/") || url.startsWith("#")) return <Link className={className} {...metadata} to={url}>{children}</Link>;
  return <a className={className} {...metadata} href={url} rel="noreferrer" target={String(block.content.target) === "new" ? "_blank" : undefined}>{children}</a>;
}

export function CmsPageRenderer(props: RendererProps) {
  const visible = props.blocks ?? [];
  if (props.page && !props.block) {
    return (
      <article className={`cms-render-page cms-render-${props.device ?? "desktop"}`}>
        <section className="cms-render-hero">
          <h1 data-kinetic-reveal={isCmsKineticRevealEnabled(props.editMode, props.previewMode) ? LANDING_KINETIC_MAP.heroHeading : undefined} {...editableProps(props, { id: "hero_heading", block_type: "heading", content: {}, position: -2, is_visible: true }, "hero_heading")}>{props.page.hero_heading}</h1>
          <p data-kinetic-reveal={isCmsKineticRevealEnabled(props.editMode, props.previewMode) ? LANDING_KINETIC_MAP.heroParagraph : undefined} {...editableProps(props, { id: "hero_description", block_type: "paragraph", content: {}, position: -1, is_visible: true }, "hero_description")}>{props.page.hero_description}</p>
          <div className="cms-render-actions">
            {props.page.buttons.map((button, index) => (
              props.editMode && !props.previewMode ? (
                <button className={button.style === "secondary" ? "btn-secondary" : "btn-primary"} key={`${button.label}-${index}`} type="button" {...editableProps(props, { id: `page-button-${index}`, block_type: "button", content: {}, position: -1, is_visible: true }, `buttons.${index}.label`)}>{button.label}</button>
              ) : (
                <Link className={button.style === "secondary" ? "btn-secondary" : "btn-primary"} key={`${button.label}-${index}`} to={button.url}>{button.label}</Link>
              )
            ))}
          </div>
        </section>
        <div className="cms-render-body">
          {visible.map((block) => <CmsPageRenderer {...props} block={block} key={block.id} />)}
        </div>
      </article>
    );
  }

  const block = props.block;
  if (!block) return null;
  const title = textValue(block, "heading", "title", "question", "label", "text");
  const body = textValue(block, "text", "description", "body", "answer", "quote", "message");
  const items = lines(block.content.items ?? block.content.columns ?? block.content.options);
  const namedItems = namedLines(block.content.items ?? block.content.columns ?? block.content.options);
  const textRevealEnabled = isCmsKineticRevealEnabled(props.editMode, props.previewMode);

  let content: ReactNode;
  switch (block.block_type) {
    case "hero_section":
      content = <section className="cms-render-section cms-render-hero-block"><h2 data-kinetic-reveal={textRevealEnabled ? LANDING_KINETIC_MAP.sectionOneHeading : undefined} {...editableProps(props, block, "heading")}>{textValue(block, "heading")}</h2><p data-kinetic-reveal={textRevealEnabled ? LANDING_KINETIC_MAP.supportingText : undefined} {...editableProps(props, block, "description")}>{textValue(block, "description")}</p><SafeLink block={block} className="btn-primary w-fit" props={props} textField="button_text">{textValue(block, "button_text", "label") || "Open"}</SafeLink></section>;
      break;
    case "page_section":
    case "container":
      content = <section className={`cms-render-section cms-section-${block.content.background ?? "default"}`}><h2 data-kinetic-inner="heading" {...editableProps(props, block, "name")}>{title || labelCms(block.block_type)}</h2>{body && <p data-kinetic-inner="body" {...editableProps(props, block, "text")}>{body}</p>}</section>;
      break;
    case "heading":
      content = String(block.content.level) === "h1" ? <h1 className={`text-${block.content.align ?? "left"}`} {...editableProps(props, block, "text")}>{title}</h1> : String(block.content.level) === "h3" ? <h3 className={`text-${block.content.align ?? "left"}`} {...editableProps(props, block, "text")}>{title}</h3> : <h2 className={`text-${block.content.align ?? "left"}`} {...editableProps(props, block, "text")}>{title}</h2>;
      break;
    case "paragraph":
    case "rich_text":
      content = <p className={`cms-render-copy text-${block.content.align ?? "left"}`} {...editableProps(props, block, "text")}>{body}</p>;
      break;
    case "button":
    case "download_button":
      content = <SafeLink block={block} className={String(block.content.style) === "secondary" || String(block.content.variant) === "Outlined" ? "btn-secondary w-fit" : "btn-primary w-fit"} props={props}>{block.block_type === "download_button" && <Download size={15} />} {title || "Open"}</SafeLink>;
      break;
    case "link":
    case "video_link":
      content = <SafeLink block={block} className="cms-render-link" props={props}>{block.block_type === "video_link" && <ExternalLink size={15} />} {title || "Open link"}</SafeLink>;
      break;
    case "image": {
      const url = textValue(block, "image_url", "url");
      content = url ? <figure><img src={resolveApiAssetUrl(url)} alt={textValue(block, "alt")} />{textValue(block, "caption") && <figcaption {...editableProps(props, block, "caption")}>{textValue(block, "caption")}</figcaption>}</figure> : <div className="cms-render-empty">Select an image in properties.</div>;
      break;
    }
    case "divider":
      content = <hr />;
      break;
    case "spacer":
      content = <div className={`cms-render-spacer cms-render-spacer-${block.content.size ?? "medium"}`} aria-hidden="true" />;
      break;
    case "list":
      content = <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
      break;
    case "quote":
    case "testimonial":
      content = <blockquote><p {...editableProps(props, block, "quote")}>{body}</p>{textValue(block, "author") && <cite {...editableProps(props, block, "author")}>{textValue(block, "author")}</cite>}</blockquote>;
      break;
    case "badge":
    case "icon":
      content = <span className="cms-render-badge" {...editableProps(props, block, "text")}>{title || textValue(block, "name")}</span>;
      break;
    case "feature_card":
      content = <article className="cms-render-card"><h3 data-kinetic-inner="heading" {...editableProps(props, block, "title")}>{title}</h3><p data-kinetic-inner="body" {...editableProps(props, block, "body")}>{body}</p></article>;
      break;
    case "feature_grid":
    case "pricing_cards":
    case "testimonials":
    case "statistics":
    case "team_section":
      content = <section><h2 data-kinetic-inner="heading" {...editableProps(props, block, "title")}>{title || labelCms(block.block_type)}</h2><div className="cms-render-grid" data-kinetic-inner="body">{namedItems.map((item, index) => <article className="cms-render-card" key={`${item.title}-${index}`}><h3>{item.title}</h3>{item.body && <p>{item.body}</p>}</article>)}</div></section>;
      break;
    case "faq":
    case "accordion":
      content = <details open><summary {...editableProps(props, block, "question")}>{title || "Question"}</summary><p {...editableProps(props, block, "answer")}>{body || namedItems[0]?.body}</p></details>;
      break;
    case "call_to_action":
    case "app_download":
    case "contact_section":
    case "announcement_banner":
      content = <section className="cms-render-section cms-render-cta"><h2 data-kinetic-reveal={textRevealEnabled ? LANDING_KINETIC_MAP.importantCta : undefined} {...editableProps(props, block, "heading")}>{title}</h2><p data-kinetic-reveal={textRevealEnabled ? LANDING_KINETIC_MAP.supportingText : undefined} {...editableProps(props, block, "description")}>{body || textValue(block, "email")}</p><SafeLink block={block} className="btn-primary w-fit" props={props} textField="button_text">{textValue(block, "button_text", "action_text") || "Open"}</SafeLink></section>;
      break;
    case "two_columns":
      content = <div className="cms-render-columns cms-render-columns-2"><p {...editableProps(props, block, "left")}>{textValue(block, "left")}</p><p {...editableProps(props, block, "right")}>{textValue(block, "right")}</p></div>;
      break;
    case "three_columns":
    case "grid":
      content = <div className="cms-render-columns cms-render-columns-3">{items.map((item) => <p key={item}>{item}</p>)}</div>;
      break;
    case "one_column":
    case "stack":
    case "tabs":
      content = <div className="cms-render-stack">{title && <h2>{title}</h2>}{(items.length ? items : [body]).map((item) => <p key={item}>{item}</p>)}</div>;
      break;
    case "navigation":
    case "footer":
    case "social_links":
      content = <nav className="cms-render-nav">{namedItems.map((item) => <SafeLink block={{ ...block, content: { ...block.content, label: item.title, url: item.body || "/" } }} className="cms-render-link" key={item.title} props={props}>{item.title}</SafeLink>)}</nav>;
      break;
    case "form":
      content = <form className="cms-render-form" onSubmit={(event) => event.preventDefault()}><h2>{title}</h2><p>{textValue(block, "success_message")}</p></form>;
      break;
    case "text_input":
    case "email_input":
    case "phone_input":
    case "date_input":
    case "text_area":
    case "dropdown":
    case "radio_group":
    case "checkbox_group":
      content = <label className="cms-render-field"><span>{title}</span><input disabled placeholder={title} /></label>;
      break;
    case "submit_button":
      content = <button className="btn-primary w-fit" type="button">{title}</button>;
      break;
    case "success_message":
    case "error_message":
      content = <p className={block.block_type === "error_message" ? "cms-render-error" : "cms-render-success"}>{title}</p>;
      break;
    default:
      content = <article className="cms-render-card"><h3>{labelCms(block.block_type)}</h3>{body && <p>{body}</p>}</article>;
  }

  return <Shell block={block} props={props}>{content}</Shell>;
}
