import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowRight,
  Brain,
  Check,
  Download,
  FileText,
  Menu,
  MessageSquare,
  Mic,
  X,
  Smartphone,
  Zap
} from "lucide-react";
import { api, resolveApkDownloadUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { ApkRelease, ApkStats, BillingPlan } from "../../types";
import { LogoIcon } from "../brand/LogoIcon";
import { ThemeToggleButton } from "../layout/ThemeToggleButton";
import { AnimatedPage, FlyText, Reveal, StaggerGroup, StaggerItem } from "../../motion/primitives";
import { CrystalAiOrb, CrystalCard, CrystalErrorBoundary } from "../crystal/Crystal";
import { usePublishedFaqs, usePublishedGlobals, usePublishedPage } from "../../hooks/useCmsContent";
import { PublishedContentBlocks } from "../common/PublishedContentBlocks";

const features = [
  { icon: <Brain size={18} />, title: "Adaptive memory", body: "Preference, project, and style signals shape future replies without making the assistant feel scripted." },
  { icon: <FileText size={18} />, title: "Document context", body: "PDF, DOCX, TXT, and image context flow into one composer with previews, progress, and recovery states." },
  { icon: <MessageSquare size={18} />, title: "Human conversation", body: "Emotion, tone, humor, and callbacks make each reply feel more like a continuation than a reset." }
];

const capabilities = ["Streaming chat", "Voice input", "Image analysis", "Memory panel", "Search mode", "Regenerate", "Bookmarks", "Prompt editing"];
const motionWords = ["Think", "Listen", "Recall", "Search", "Write", "Speak"];

const testimonials = [
  "Feels like an AI workspace with a pulse.",
  "The context panel makes long research threads easier to steer.",
  "Uploads, voice, and memory finally live where the conversation happens."
];

const faqs = [
  ["Does Auto-AI remember me?", "Yes. You can inspect, add, and delete user-owned memories from the app."],
  ["Can I chat with files?", "Yes. Attach PDF, DOCX, TXT, or images from the composer and Auto-AI folds the context into the thread."],
  ["Which providers are supported?", "The backend supports OpenAI, Groq, and Bedrock-compatible chat flows."]
];

function money(amountPaise: number, currency = "INR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountPaise / 100);
}

function formatDate(value?: string | null) {
  if (!value) return "Pending release";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function LandingPage() {
  const { user } = useAuth();
  const cmsPage = usePublishedPage("home");
  const globalContent = usePublishedGlobals();
  const publishedFaqs = usePublishedFaqs();
  const [latestApk, setLatestApk] = useState<ApkRelease | null>(null);
  const [apkStats, setApkStats] = useState<ApkStats | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const qrUrl = resolveApkDownloadUrl();
  const cmsBlocks = cmsPage?.blocks ?? [];
  const featureHeading = String(cmsBlocks.find((block) => block.block_type === "heading")?.content.text ?? "Every interaction has weight, motion, and memory.");
  const finalCta = cmsBlocks.find((block) => block.block_type === "call_to_action");
  const extraBlocks = cmsBlocks.filter((block) => !["heading", "feature_grid", "call_to_action"].includes(block.block_type));
  const visibleFaqs = publishedFaqs?.length ? publishedFaqs.map((item) => [item.question, item.answer]) : faqs;
  const navLinks = [
    { label: globalContent?.["header.features"] || "Features", href: "#features" },
    { label: globalContent?.["header.android"] || "Android", to: "/download" },
    { label: globalContent?.["header.pricing"] || "Pricing", to: "/pricing" },
    { label: globalContent?.["header.admin"] || "Admin", to: "/admin/login" },
    { label: globalContent?.["header.faq"] || "FAQ", href: "#faq" }
  ];

  async function downloadLatestApk() {
    let release = latestApk;
    if (release) {
      try {
        const countedRelease = await api.countApkDownload({ id: release.id });
        release = countedRelease;
        setLatestApk(countedRelease);
        setApkStats((current) => current && {
          ...current,
          latest: countedRelease,
          total_downloads: current.total_downloads + 1,
          downloads_by_version: {
            ...current.downloads_by_version,
            [countedRelease.version_name]: countedRelease.download_count
          }
        });
      } catch {
        release = latestApk;
      }
    }
    window.location.href = resolveApkDownloadUrl(release, Boolean(release));
  }

  useEffect(() => {
    let active = true;
    Promise.all([api.latestApk(), api.apkStats()])
      .then(([release, stats]) => {
        if (!active) return;
        setLatestApk(release);
        setApkStats(stats);
      })
      .catch(() => {
        if (active) setLatestApk(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api.paymentPlans()
      .then((nextPlans) => {
        if (!active) return;
        setPlans(nextPlans.filter((plan) => ["free", "pro", "premium", "ultra"].includes(plan.id)));
      })
      .catch(() => {
        if (active) setPlans([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <header className="landing-nav">
        <Link className="brand-mark" to="/">
          <span className="brand-icon"><LogoIcon /></span>
          {globalContent?.["site.name"] || "Auto-AI"}
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
          {navLinks.map((item) =>
            item.to ? (
              <Link key={item.label} to={item.to}>{item.label}</Link>
            ) : (
              <a key={item.label} href={item.href}>{item.label}</a>
            )
          )}
        </nav>
        <div className="nav-actions">
          <Link className="btn-primary" to={user ? "/chat" : "/login"}>
            {user ? "Open app" : globalContent?.["header.sign_in"] || "Sign in"}
            <ArrowRight size={16} />
          </Link>
          <ThemeToggleButton />
          <button
            className="landing-mobile-menu-button"
            type="button"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((current) => !current)}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
        {mobileMenuOpen && (
          <nav className="landing-mobile-menu" aria-label="Mobile navigation">
            {navLinks.map((item) =>
              item.to ? (
                <Link key={item.label} to={item.to} onClick={() => setMobileMenuOpen(false)}>{item.label}</Link>
              ) : (
                <a key={item.label} href={item.href} onClick={() => setMobileMenuOpen(false)}>{item.label}</a>
              )
            )}
          </nav>
        )}
      </header>

      <AnimatedPage className="landing-page">
      <main>
        <section className="landing-hero" data-chapter="Awaken">
          <div className="landing-lighting" aria-hidden="true" />
          <div className="hero-motion-grid" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="hero-copy">
            <Reveal>
              <p className="hero-kicker"><Zap size={14} /> Ultra Premium AI Workspace</p>
            </Reveal>
            <Reveal delay={0.08} x={-26} y={18} scale={0.96} blur={8}>
              <h1 className="neural-sweep-once">{cmsPage?.hero_heading || "Auto-AI"}</h1>
            </Reveal>
            <Reveal delay={0.16} x={-18} y={16} blur={6}>
              <p className="hero-subtitle">
                {cmsPage?.hero_description || "Auto-AI, also known as AutoAI and Auto AI, is a commercial-grade AI experience with memory, uploads, voice, streaming, and a conversation style that feels alive."}
              </p>
            </Reveal>
            <Reveal delay={0.22} x={-14} y={14}>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link className="btn-primary h-11 px-5" to={user ? "/chat" : cmsPage?.buttons?.[0]?.url || "/register"}>
                  {cmsPage?.buttons?.[0]?.label || "Start building"}
                  <ArrowRight size={17} />
                </Link>
                <Link className="btn-secondary h-11 px-5" to={user ? "/chat" : cmsPage?.buttons?.[1]?.url || "/login"}>
                  {cmsPage?.buttons?.[1]?.label || "View workspace"}
                </Link>
              </div>
            </Reveal>
            <div className="mobile-feature-strip">
              <span><MessageSquare size={14} /> Streaming</span>
              <span><Mic size={14} /> Voice</span>
              <span><FileText size={14} /> Files</span>
              <span><Zap size={14} /> Memory</span>
            </div>
          </div>

          <div
            className="product-preview"
            aria-label="Auto-AI product preview"
          >
            <div className="preview-orbit" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="product-neural-core" aria-hidden="true">
              <CrystalErrorBoundary><CrystalAiOrb state="ready" size="lg" /></CrystalErrorBoundary>
            </div>
            <div className="preview-sidebar">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-main">
              <div className="signal-line" />
              <div className="preview-floating-labels" aria-hidden="true">
                <span>Memory sync</span>
                <span>Voice ready</span>
                <span>Files parsed</span>
              </div>
              <div className="preview-message user">Audit the upload flow and make the UI feel premium.</div>
              <div className="preview-message ai">
                <span className="preview-pulse" />
                I found the split upload path. I'll move documents, images, voice, and send into one composer, then keep memory visible beside the thread.
              </div>
              <div className="preview-composer">
                <Mic size={14} />
                <FileText size={14} />
                <span>Message Auto-AI</span>
                <ArrowRight size={14} />
              </div>
            </div>
          </div>
        </section>

        <PublishedContentBlocks blocks={extraBlocks} />

        <section id="features" className="landing-section" data-chapter="Understand">
          <div className="section-heading">
            <p className="hero-kicker">Product System</p>
            <h2><FlyText text={featureHeading} /></h2>
          </div>
          <StaggerGroup className="feature-grid">
            {features.map((feature) => (
              <StaggerItem key={feature.title}>
                <CrystalCard className="premium-feature" data-thread-node>
                  <span>{feature.icon}</span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </CrystalCard>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </section>

        <section className="landing-section motion-showcase-section" data-chapter="Think">
          <div className="motion-showcase">
            <Reveal x={-42} y={18} blur={10} className="motion-showcase-copy">
              <p className="hero-kicker">Scroll Animation</p>
              <h2><FlyText text="Text flies in, panels breathe, and the page keeps moving." /></h2>
            </Reveal>
            <StaggerGroup className="motion-word-grid">
              {motionWords.map((word) => (
                <StaggerItem key={word}>
                  <span>{word}</span>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </div>
        </section>

        <section className="landing-section" data-chapter="Connect">
          <div className="android-promo">
            <Reveal x={-32} y={18} blur={8}>
              <p className="hero-kicker"><Smartphone size={14} /> Mobile Application</p>
              <h2>Install Auto-AI on Android</h2>
              <p>
                Use the same account, backend, memory, chat history, uploads, settings, and source-grounded answers from your phone.
              </p>
              <div className="mobile-release-strip">
                <span>Latest: {latestApk?.version_name ?? "Checking"}</span>
                <span>Code: {latestApk?.version_code ?? 0}</span>
                <span>Released: {formatDate(latestApk?.released_at ?? latestApk?.release_date)}</span>
                <span>Updated: {formatDate(latestApk?.updated_at)}</span>
                <span>Downloads: {(apkStats?.total_downloads ?? latestApk?.download_count ?? 0).toLocaleString()}</span>
              </div>
              {latestApk?.changelog && <p className="mobile-changelog">{latestApk.changelog}</p>}
              <div className="mt-5 flex flex-wrap gap-3">
                <button className="btn-primary h-11 px-5" type="button" onClick={downloadLatestApk}>
                  <Download size={17} />
                  Download APK
                </button>
                <Link className="btn-secondary h-11 px-5" to="/download">
                  App details
                </Link>
              </div>
            </Reveal>
            <Reveal x={32} y={18} blur={8} className="android-preview-wrap">
              <div className="mini-phone">
                <div className="mini-phone-screen">
                  <span className="mini-phone-top"><LogoIcon className="app-logo app-logo-inline" /> Auto-AI</span>
                  <span className="mini-bubble user">Find current sources.</span>
                  <span className="mini-bubble ai">Searching the web...</span>
                  <span className="mini-sources">S1 S2 S3 | 86%</span>
                </div>
              </div>
              <div className="promo-qr">
                <QRCodeSVG value={qrUrl} size={104} bgColor="transparent" fgColor="#e0f2fe" />
                <span>Scan APK</span>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="landing-section" data-chapter="Interact">
          <Reveal className="capability-band">
            <div>
              <p className="hero-kicker">AI Capabilities</p>
              <h2><FlyText text="One surface for the whole loop." /></h2>
            </div>
            <div className="capability-grid">
              {capabilities.map((capability) => (
                <span key={capability}><Check size={14} /> {capability}</span>
              ))}
            </div>
          </Reveal>
        </section>

        <section className="landing-section" data-chapter="Trust">
          <div className="section-heading">
            <p className="hero-kicker">User Feedback</p>
            <h2><FlyText text="Auto-AI feels built for real work." /></h2>
          </div>
          <StaggerGroup className="testimonial-grid">
            {testimonials.map((quote) => (
              <StaggerItem key={quote}>
                <figure>
                  <blockquote>{quote}</blockquote>
                  <figcaption>Auto-AI beta user</figcaption>
                </figure>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </section>

        <section id="pricing" className="landing-section" data-chapter="Act">
          <div className="section-heading">
            <p className="hero-kicker">Plans</p>
            <h2><FlyText text="Start with Auto-AI and scale when you need more." /></h2>
          </div>
          <StaggerGroup className="pricing-grid pricing-grid-four">
            {plans.map((plan) => (
              <StaggerItem key={plan.id}>
                <CrystalCard className="pricing-card">
                  <h3>{plan.label}</h3>
                  <strong className="pricing-price">{money(plan.price_paise, plan.currency)}</strong>
                  <span>{plan.token_quota.toLocaleString()} tokens/month</span>
                  <Link className={plan.id === "premium" ? "btn-primary" : "btn-secondary"} to="/pricing">
                    Choose {plan.label}
                  </Link>
                </CrystalCard>
              </StaggerItem>
            ))}
          </StaggerGroup>
        </section>

        <section className="landing-section final-cta-section" data-chapter="Resolve">
          <Reveal className="final-cta">
            <p className="hero-kicker">Auto-AI</p>
            <h2><FlyText text={String(finalCta?.content.heading ?? "Bring the whole workspace into one conversation.")} /></h2>
            <div className="final-cta-actions">
              <Link className="btn-primary h-11 px-5" to={user ? "/chat" : "/register"}>
                {user ? "Open app" : String(finalCta?.content.button_text ?? globalContent?.["cta.default"] ?? "Create account")}
                <ArrowRight size={17} />
              </Link>
              <Link className="btn-secondary h-11 px-5" to="/download">
                <Download size={17} />
                Android APK
              </Link>
            </div>
          </Reveal>
        </section>

        <section id="faq" className="landing-section" data-chapter="FAQ">
          <div className="section-heading">
            <p className="hero-kicker">FAQ</p>
            <h2><FlyText text="Common Auto-AI questions." /></h2>
          </div>
          <div className="faq-list">
            {visibleFaqs.map(([question, answer]) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span className="brand-mark"><span className="brand-icon"><LogoIcon /></span> {globalContent?.["site.name"] || "Auto-AI"}</span>
        <p>{globalContent?.["footer.description"] || "Premium AI workspace for contextual, human-feeling conversations."}</p>
      </footer>
    </AnimatedPage>
    </>
  );
}
