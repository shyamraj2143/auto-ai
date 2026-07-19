import { useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { usePublishedPage } from "../../hooks/useCmsContent";
import { useKineticReveal } from "../../hooks/useKineticReveal";
import { LANDING_KINETIC_MAP } from "../../motion/kineticRevealConfig";
import { CmsPageRenderer } from "./CmsPageRenderer";

const fallbackBySlug: Record<string, { title: string; description: string }> = {
  about: { title: "About Auto-AI", description: "Auto-AI brings chat, memory, voice, file context and mobile access into one workspace." },
  features: { title: "Auto-AI Features", description: "Everything you need for useful AI conversations, research, uploads and mobile continuity." },
  contact: { title: "Contact Auto-AI", description: "Reach the Auto-AI team for support, billing and product questions." },
  help: { title: "Auto-AI Help", description: "Find answers about accounts, chat, billing, Android and content features." },
  "privacy-policy": { title: "Privacy Policy", description: "How Auto-AI handles account, content and usage information." },
  "terms-and-conditions": { title: "Terms and Conditions", description: "Terms governing use of Auto-AI services." }
};

export function PublicCmsPage() {
  const location = useLocation();
  const slug = location.pathname.replace(/^\/+|\/+$/g, "") || "home";
  const page = usePublishedPage(slug);
  const fallback = fallbackBySlug[slug];
  const revealRootRef = useRef<HTMLDivElement>(null);
  useKineticReveal(revealRootRef);

  return (
    <div className="public-kinetic-reveal-scope" ref={revealRootRef}>
      {page ? (
        <CmsPageRenderer page={page} blocks={page.blocks?.filter((block) => block.is_visible)} />
      ) : fallback ? (
        <main className="cms-render-page">
          <section className="cms-render-hero">
            <h1 data-kinetic-reveal={LANDING_KINETIC_MAP.heroHeading}>{fallback.title}</h1>
            <p data-kinetic-reveal={LANDING_KINETIC_MAP.heroParagraph}>{fallback.description}</p>
            <div className="cms-render-actions"><Link className="btn-primary" to="/">Home</Link></div>
          </section>
        </main>
      ) : (
        <main className="cms-render-page"><section className="cms-render-hero"><h1>Page unavailable</h1><p>The published page could not be loaded.</p></section></main>
      )}
    </div>
  );
}
