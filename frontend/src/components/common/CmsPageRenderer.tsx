import { Download, ExternalLink } from "lucide-react";
import type { FocusEvent, FormEvent, KeyboardEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import { labelCms, lines, namedLines, textValue, type CmsDevice } from "../admin/cms/cmsBlockLibrary";
import type { CmsBlock, CmsPage } from "../admin/cms/types";

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
  const commit = (target: HTMLElement) => {
    const value = target.textContent ?? "";
    if (block.id === "hero-heading") props.onPageFieldChange?.("hero_heading", value);
    else if (block.id === "hero-description") props.onPageFieldChange?.("hero_description", value);
    else props.onInlineChange?.(block.id, key, value);
  };
  return {
    contentEditable: true,
    suppressContentEditableWarning: true,
    "data-cms-editable": "text",
    onInput: (event: FormEvent<HTMLElement>) => commit(event.currentTarget),
    onBlur: (event: FocusEvent<HTMLElement>) => commit(event.currentTarget),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") event.currentTarget.blur();
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.blur();
    }
  };
}

function Shell({ block, props, children }: { block: CmsBlock; props: RendererProps; children: ReactNode }) {
  if (!block.is_visible && !props.editMode) return null;
  return (
    <div
      className={[
        "cms-render-block",
        props.editMode ? "cms-render-editable" : "",
        props.selectedBlockId === block.id ? "cms-render-selected" : "",
        !block.is_visible ? "cms-render-hidden" : ""
      ].filter(Boolean).join(" ")}
      data-cms-block-id={block.id}
      data-cms-block-type={block.block_type}
      data-block-id={block.id}
      data-block-type={block.block_type}
      onClick={(event) => {
        if (!props.editMode) return;
        event.preventDefault();
        event.stopPropagation();
        props.onSelect?.(block.id);
      }}
    >
      {children}
    </div>
  );
}

function SafeLink({ block, className, children, props }: { block: CmsBlock; className: string; children: ReactNode; props: RendererProps }) {
  const url = textValue(block, "url", "href", "target_url");
  if (!url) return <span className={className}>{children}</span>;
  if (props.editMode && !props.previewMode) return <button className={className} type="button">{children}</button>;
  if (url.startsWith("/") || url.startsWith("#")) return <Link className={className} to={url}>{children}</Link>;
  return <a className={className} href={url} rel="noreferrer" target={String(block.content.target) === "new" ? "_blank" : undefined}>{children}</a>;
}

export function CmsPageRenderer(props: RendererProps) {
  const visible = props.blocks ?? [];
  if (props.page && !props.block) {
    return (
      <article className={`cms-render-page cms-render-${props.device ?? "desktop"}`} onClick={() => props.editMode && props.onSelect?.(null)}>
        <section className="cms-render-hero">
          <h1 {...editableProps(props, { id: "hero-heading", block_type: "heading", content: {}, position: -2, is_visible: true }, "hero_heading")}>{props.page.hero_heading}</h1>
          <p {...editableProps(props, { id: "hero-description", block_type: "paragraph", content: {}, position: -1, is_visible: true }, "hero_description")}>{props.page.hero_description}</p>
          <div className="cms-render-actions">
            {props.page.buttons.map((button, index) => (
              props.editMode && !props.previewMode ? (
                <button className={button.style === "secondary" ? "btn-secondary" : "btn-primary"} key={`${button.label}-${index}`} type="button">{button.label}</button>
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

  let content: ReactNode;
  switch (block.block_type) {
    case "hero_section":
      content = <section className="cms-render-section cms-render-hero-block"><h2 {...editableProps(props, block, "heading")}>{textValue(block, "heading")}</h2><p {...editableProps(props, block, "description")}>{textValue(block, "description")}</p><SafeLink block={block} className="btn-primary w-fit" props={props}>{textValue(block, "button_text", "label") || "Open"}</SafeLink></section>;
      break;
    case "page_section":
    case "container":
      content = <section className={`cms-render-section cms-section-${block.content.background ?? "default"}`}><h2 {...editableProps(props, block, "name")}>{title || labelCms(block.block_type)}</h2>{body && <p {...editableProps(props, block, "text")}>{body}</p>}</section>;
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
      content = <SafeLink block={block} className={String(block.content.style) === "secondary" ? "btn-secondary w-fit" : "btn-primary w-fit"} props={props}>{block.block_type === "download_button" && <Download size={15} />} {title || "Open"}</SafeLink>;
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
      content = <article className="cms-render-card"><h3 {...editableProps(props, block, "title")}>{title}</h3><p {...editableProps(props, block, "body")}>{body}</p></article>;
      break;
    case "feature_grid":
    case "pricing_cards":
    case "testimonials":
    case "statistics":
    case "team_section":
      content = <section><h2 {...editableProps(props, block, "title")}>{title || labelCms(block.block_type)}</h2><div className="cms-render-grid">{namedItems.map((item, index) => <article className="cms-render-card" key={`${item.title}-${index}`}><h3>{item.title}</h3>{item.body && <p>{item.body}</p>}</article>)}</div></section>;
      break;
    case "faq":
    case "accordion":
      content = <details open><summary {...editableProps(props, block, "question")}>{title || "Question"}</summary><p {...editableProps(props, block, "answer")}>{body || namedItems[0]?.body}</p></details>;
      break;
    case "call_to_action":
    case "app_download":
    case "contact_section":
    case "announcement_banner":
      content = <section className="cms-render-section cms-render-cta"><h2 {...editableProps(props, block, "heading")}>{title}</h2><p {...editableProps(props, block, "description")}>{body || textValue(block, "email")}</p><SafeLink block={block} className="btn-primary w-fit" props={props}>{textValue(block, "button_text", "action_text") || "Open"}</SafeLink></section>;
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
