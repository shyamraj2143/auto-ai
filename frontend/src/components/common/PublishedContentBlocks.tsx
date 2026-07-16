import { CmsBlockRenderer } from "../admin/cms/CmsBlockRenderer";
import type { CmsBlock } from "../admin/cms/types";

export function PublishedContentBlocks({ blocks }: { blocks?: CmsBlock[] }) {
  const visible = (blocks ?? []).filter((block) => block.is_visible);
  if (!visible.length) return null;
  return (
    <section className="landing-section cms-public-blocks" aria-label="Additional page content">
      {visible.map((block) => <CmsBlockRenderer block={block} key={block.id} />)}
    </section>
  );
}
