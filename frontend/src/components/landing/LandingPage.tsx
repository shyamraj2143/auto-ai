import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  AudioLines,
  BrainCircuit,
  Check,
  Command,
  Copy,
  Download,
  Eye,
  FileText,
  Layers3,
  LockKeyhole,
  Menu,
  MessageSquare,
  Network,
  PhoneCall,
  QrCode,
  Search,
  ShieldCheck,
  ScreenShare,
  Smartphone,
  Sparkles,
  X,
  Zap,
  Wifi,
  WifiOff
} from "lucide-react";
import { api, resolveApkDownloadUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { ApkRelease, ApkStats, BillingPlan } from "../../types";
import { LogoIcon } from "../brand/LogoIcon";
import { ThemeToggleButton } from "../layout/ThemeToggleButton";
import {
  PrismBadge,
  PrismButton,
  PrismCard,
  PrismDialog,
  PrismEmptyState,
  PrismIconButton,
  PrismInput,
  PrismNavigation,
  PrismReveal,
  PrismStatusChip,
  PrismSurface,
  PrismTabs,
  PrismTooltip
} from "../prism/Prism";
import { usePublishedFaqs, usePublishedGlobals, usePublishedPage } from "../../hooks/useCmsContent";
import { PublishedContentBlocks } from "../common/PublishedContentBlocks";
import { useScreenShare } from "../../features/screenShare/useScreenShare";
import type { CmsPage } from "../admin/cms/types";
import { useKineticReveal } from "../../hooks/useKineticReveal";
import { useLuxuryCinematic } from "../../hooks/useLuxuryCinematic";
import { alternatingDiagonal, alternatingFlight, LANDING_KINETIC_MAP } from "../../motion/kineticRevealConfig";
import { KineticSplitText } from "../motion/KineticSplitText";
import { LuxuryLoader } from "../motion/LuxuryLoader";
import "../../styles/kineticReveal.css";
import "../../styles/luxuryCinematic.css";

const LazyQRCode = lazy(async () => {
  const module = await import("qrcode.react");
  return { default: module.QRCodeSVG };
});

type PreviewMode = "chat" | "research" | "vision";
type CommandItem = { label: string; detail: string; to?: string; section?: string };
type DemoMessage = { id: string; role: "user" | "assistant"; text: string };
type DemoThreads = Record<PreviewMode, DemoMessage[]>;

function LuxuryWordLine({ text }: { text: string }) {
  return text.split(/(\s+)/).map((token, index) => token.trim() ? (
    <span className="luxury-word" data-luxury-word key={`${token}-${index}`}>{token}</span>
  ) : token);
}

export type LandingPageEditorSession = {
  page: CmsPage;
  editMode: boolean;
  previewMode?: boolean;
  selectedBlockId?: string | null;
  onSelect?: (blockId: string | null) => void;
  onPageFieldChange?: (key: "hero_heading" | "hero_description", value: string) => void;
  onBlockFieldChange?: (blockId: string, key: string, value: string) => void;
};

const DEMO_CHAT_LIMIT = 5;
const DEMO_SESSION_STORAGE_KEY = "auto-ai-prism-demo-session";

const previewModes: ReadonlyArray<{ id: PreviewMode; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "research", label: "Research" },
  { id: "vision", label: "Vision" }
];

const previewContent: Record<PreviewMode, { prompt: string; answer: string }> = {
  chat: {
    prompt: "Turn these project notes into a clear launch plan.",
    answer: "I mapped the decisions, grouped the risks, and prepared a focused sequence your team can start today."
  },
  research: {
    prompt: "Compare the strongest evidence across current sources.",
    answer: "I checked the claims against multiple sources and separated verified findings from open questions."
  },
  vision: {
    prompt: "Review this interface and identify usability issues.",
    answer: "The main actions are clear. I found two mobile spacing issues and one low-contrast state to correct."
  }
};

function createInitialDemoThreads(): DemoThreads {
  return {
    chat: [
      { id: "chat-user-initial", role: "user", text: previewContent.chat.prompt },
      { id: "chat-ai-initial", role: "assistant", text: previewContent.chat.answer }
    ],
    research: [
      { id: "research-user-initial", role: "user", text: previewContent.research.prompt },
      { id: "research-ai-initial", role: "assistant", text: previewContent.research.answer }
    ],
    vision: [
      { id: "vision-user-initial", role: "user", text: previewContent.vision.prompt },
      { id: "vision-ai-initial", role: "assistant", text: previewContent.vision.answer }
    ]
  };
}

function readOrCreateDemoSessionId() {
  try {
    const stored = localStorage.getItem(DEMO_SESSION_STORAGE_KEY);
    if (stored && /^[A-Za-z0-9_-]{16,80}$/.test(stored)) return stored;
    const next = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEMO_SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  }
}

const bentoFeatures: Array<{
  title: string;
  body: string;
  icon: ReactNode;
  accent: string;
  size: "wide" | "tall" | "standard";
  signal: string;
}> = [
  {
    title: "AI Chat",
    body: "A fast, context-aware conversation workspace for ideas, documents, decisions, and follow-up work.",
    icon: <MessageSquare size={20} />,
    accent: "cyan",
    size: "wide",
    signal: "Streaming"
  },
  {
    title: "Voice Mode",
    body: "Speak naturally, listen to clear answers, and stay in the flow without reaching for the keyboard.",
    icon: <AudioLines size={20} />,
    accent: "pink",
    size: "tall",
    signal: "Listening"
  },
  {
    title: "Vision",
    body: "Bring screenshots and images into the same conversation for precise visual understanding.",
    icon: <Eye size={20} />,
    accent: "blue",
    size: "standard",
    signal: "Visual context"
  },
  {
    title: "Screen Sharing",
    body: "Share with a secure 8-digit code and work across phone and laptop without installing viewer software.",
    icon: <Layers3 size={20} />,
    accent: "violet",
    size: "wide",
    signal: "WebRTC"
  },
  {
    title: "Audio & Video Calls",
    body: "Move from messages to a direct conversation with clear connection and call states.",
    icon: <PhoneCall size={20} />,
    accent: "pink",
    size: "standard",
    signal: "Connected"
  },
  {
    title: "Deep Research",
    body: "Build source-grounded answers while keeping evidence and uncertainty visible.",
    icon: <Search size={20} />,
    accent: "cyan",
    size: "standard",
    signal: "Source aware"
  },
  {
    title: "Multi-model Routing",
    body: "Match each task to the right intelligence path while keeping one consistent workspace.",
    icon: <Network size={20} />,
    accent: "blue",
    size: "wide",
    signal: "Adaptive"
  },
  {
    title: "Secure Conversations",
    body: "Private sessions, visible permissions, and user-controlled data keep every interaction intentional.",
    icon: <ShieldCheck size={20} />,
    accent: "violet",
    size: "standard",
    signal: "Protected"
  }
];

const capabilities = ["Streaming chat", "Voice input", "Image analysis", "Memory panel", "Search mode", "File context", "Screen sharing", "Secure calls"];

const testimonials = [
  "The workspace stays clear even when the project gets complicated.",
  "Research, uploads, and conversation finally feel like one continuous thought.",
  "It is quick enough for daily work and calm enough for long sessions."
];

const fallbackFaqs = [
  ["Does Auto-AI remember me?", "Yes. You can inspect, add, and delete user-owned memories from the app."],
  ["Can I chat with files?", "Yes. Attach PDF, DOCX, TXT, or images and Auto-AI brings their context into the thread."],
  ["Can I use Auto-AI on mobile?", "Yes. The Android app uses the same account, chats, calls, settings, and screen-sharing system."]
];

function money(amountPaise: number, currency = "INR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountPaise / 100);
}

function formatDate(value?: string | null) {
  if (!value) return "Pending release";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit"
  }).format(new Date(value));
}

function useOnlineStatus() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let active = true;
    let checking = false;
    const update = async () => {
      if (checking) return;
      checking = true;
      try {
        await api.health();
        if (active) setOnline(true);
      } catch {
        if (active) setOnline(false);
      } finally {
        checking = false;
      }
    };
    void update();
    const intervalId = window.setInterval(() => void update(), 30_000);
    const retry = () => void update();
    window.addEventListener("online", retry);
    window.addEventListener("offline", retry);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("online", retry);
      window.removeEventListener("offline", retry);
    };
  }, []);
  return online;
}

function demoProviderLabel(provider: "bedrock" | "groq" | "openai") {
  if (provider === "groq") return "Groq";
  if (provider === "openai") return "OpenAI";
  return "Bedrock";
}

export function LandingPage({ editor }: { editor?: LandingPageEditorSession }) {
  const { user } = useAuth();
  const screenShare = useScreenShare();
  const online = useOnlineStatus();
  const publishedCmsPage = usePublishedPage("home", !editor);
  const cmsPage = editor?.page ?? publishedCmsPage;
  const globalContent = usePublishedGlobals();
  const publishedFaqs = usePublishedFaqs();
  const [latestApk, setLatestApk] = useState<ApkRelease | null>(null);
  const [apkStats, setApkStats] = useState<ApkStats | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [activeSection, setActiveSection] = useState("overview");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("chat");
  const [demoThreads, setDemoThreads] = useState<DemoThreads>(createInitialDemoThreads);
  const [demoDraft, setDemoDraft] = useState("");
  const [demoTurns, setDemoTurns] = useState(0);
  const [demoLimit, setDemoLimit] = useState(DEMO_CHAT_LIMIT);
  const [demoEnabled, setDemoEnabled] = useState(true);
  const [demoProvider, setDemoProvider] = useState<"bedrock" | "groq" | "openai">("bedrock");
  const [demoModel, setDemoModel] = useState("Amazon Bedrock");
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoSessionId] = useState(readOrCreateDemoSessionId);
  const [pendingDemoMode, setPendingDemoMode] = useState<PreviewMode | null>(null);
  const [copied, setCopied] = useState(false);
  const demoMessagesRef = useRef<HTMLDivElement>(null);
  const kineticRevealRootRef = useRef<HTMLDivElement>(null);
  const editorIsInteractive = Boolean(editor?.editMode && !editor.previewMode);
  useKineticReveal(kineticRevealRootRef, { disabled: editorIsInteractive });
  useLuxuryCinematic(kineticRevealRootRef, { disabled: editorIsInteractive });
  const qrUrl = resolveApkDownloadUrl();
  const cmsBlocks = cmsPage?.blocks ?? [];
  const featureHeadingBlock = cmsBlocks.find((block) => block.block_type === "heading");
  const featureHeading = String(featureHeadingBlock?.content.text ?? "One intelligence layer. Every way you work.");
  const finalCta = cmsBlocks.find((block) => block.block_type === "call_to_action");
  const extraBlocks = cmsBlocks.filter((block) => !["heading", "feature_grid", "call_to_action"].includes(block.block_type));
  const visibleFaqs = publishedFaqs?.length ? publishedFaqs.map((item) => [item.question, item.answer]) : fallbackFaqs;
  const currentDemoMessages = demoThreads[previewMode];
  const demoRemaining = Math.max(0, demoLimit - demoTurns);
  const primaryHeroButton = cmsPage ? cmsPage.buttons[0] : { label: "Start Chatting", url: "/register", style: "primary" as const };
  const secondaryHeroButton = cmsPage ? cmsPage.buttons[1] : { label: "Explore Features", url: "#features", style: "secondary" as const };
  const elementOverrides = cmsPage?.element_overrides ?? {};
  const elementText = (key: string, fallback: string) => elementOverrides[key]?.text ?? fallback;
  const elementVisible = (key: string) => elementOverrides[key]?.hidden !== true;
  const elementStyle = (key: string) => elementVisible(key) ? undefined : { display: "none" };
  const elementHref = (key: string, fallback: string) => {
    const candidate = elementOverrides[key]?.href ?? fallback;
    if ((candidate.startsWith("/") && !candidate.startsWith("//")) || candidate.startsWith("#")) return candidate;
    try {
      return ["https:", "http:", "mailto:", "tel:"].includes(new URL(candidate).protocol) ? candidate : fallback;
    } catch {
      return fallback;
    }
  };

  const navLinks = useMemo(() => [
    { id: "features", label: globalContent?.["header.features"] || "Features" },
    { id: "android", label: globalContent?.["header.android"] || "Android" },
    { id: "pricing", label: globalContent?.["header.pricing"] || "Pricing" },
    { id: "faq", label: globalContent?.["header.faq"] || "FAQ" }
  ], [globalContent]);

  const commandItems = useMemo<CommandItem[]>(() => [
    { label: "Start a conversation", detail: "Open the Auto-AI chat workspace", to: user ? "/chat" : "/register" },
    { label: "Explore features", detail: "See chat, voice, vision, calls, and sharing", section: "features" },
    { label: "Download Android app", detail: "View the current APK release", to: "/download" },
    { label: "Compare plans", detail: "Review available Auto-AI plans", to: "/pricing" },
    { label: "Sign in", detail: "Continue with your Auto-AI account", to: "/login" }
  ].filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(commandQuery.trim().toLowerCase())), [commandQuery, user]);

  const closeCommand = useCallback(() => {
    setCommandOpen(false);
    setCommandQuery("");
  }, []);

  const editorProps = useCallback((
    blockId: string,
    blockType: string,
    field = "",
    options: { editable?: "text" | "container" | "none"; global?: boolean; locked?: boolean; protected?: boolean; label?: string; currentValue?: string; currentHref?: string } = {}
  ) => {
    if (!editor?.editMode || editor.previewMode) return {};
    return {
      "data-cms-block-id": blockId,
      "data-cms-block-type": blockType,
      "data-cms-field": field,
      "data-cms-editable": options.editable ?? (field ? "text" : "container"),
      "data-cms-global": String(Boolean(options.global)),
      "data-cms-locked": String(Boolean(options.locked)),
      "data-cms-protected": String(Boolean(options.protected)),
      "data-cms-value": options.currentValue,
      "data-cms-href": options.currentHref,
      "data-cms-label": options.label ?? blockType.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    };
  }, [editor?.editMode, editor?.previewMode]);

  const editableElementProps = (
    key: string,
    blockType: string,
    label: string,
    currentValue?: string,
    currentHref?: string
  ) => editorProps(
    `element:${key}`,
    blockType,
    currentValue === undefined ? "" : "text",
    { editable: currentValue === undefined ? "container" : "text", label, currentValue, currentHref }
  );

  const editablePageProps = useCallback((field: "hero_heading" | "hero_description") => editorProps(
    field,
    field === "hero_heading" ? "heading" : "paragraph",
    field,
    { editable: "text", label: field === "hero_heading" ? "Heading" : "Paragraph" }
  ), [editorProps]);

  useEffect(() => {
    if (editor?.editMode) {
      document.body.classList.remove("prism-public-page");
      return;
    }
    document.body.classList.add("prism-public-page");
    return () => {
      document.body.classList.remove("prism-public-page");
    };
  }, [editor?.editMode]);

  const scrollToSection = useCallback((sectionId: string) => {
    setMobileMenuOpen(false);
    closeCommand();
    const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    document.getElementById(sectionId)?.scrollIntoView({ behavior, block: "start" });
  }, [closeCommand]);

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
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const container = demoMessagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [currentDemoMessages.length, demoError, pendingDemoMode, previewMode]);

  useEffect(() => {
    let active = true;
    api.demoChatConfig()
      .then((config) => {
        if (!active) return;
        setDemoEnabled(config.enabled);
        setDemoLimit(config.limit);
        setDemoProvider(config.provider);
        setDemoModel(config.model);
      })
      .catch(() => {
        if (active) setDemoError("AI demo configuration is unavailable.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    api.paymentPlans()
      .then((nextPlans) => {
        if (active) setPlans(nextPlans.filter((plan) => ["free", "pro", "premium", "ultra"].includes(plan.id)));
      })
      .catch(() => {
        if (active) setPlans([]);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const sections = ["overview", "features", "android", "pricing", "faq"]
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => Boolean(section));
    if (!("IntersectionObserver" in window) || !sections.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target.id) setActiveSection(visible.target.id);
    }, { rootMargin: "-24% 0px -60%", threshold: [0.05, 0.25, 0.5] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  async function copyWebsiteLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  async function sendDemoMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = demoDraft.trim();
    if (!message || !demoEnabled || demoRemaining <= 0 || pendingDemoMode) return;

    const mode = previewMode;
    const userMessage: DemoMessage = { id: `${mode}-user-${Date.now()}`, role: "user", text: message };
    setDemoThreads((current) => ({ ...current, [mode]: [...current[mode], userMessage] }));
    setDemoDraft("");
    setDemoError(null);
    setPendingDemoMode(mode);

    try {
      const result = await api.demoChat({
        session_id: demoSessionId,
        message,
        mode,
        history: currentDemoMessages.slice(-10).map((item) => ({ role: item.role, content: item.text }))
      });
      const assistantMessage: DemoMessage = {
        id: `${mode}-assistant-${Date.now()}`,
        role: "assistant",
        text: result.content
      };
      setDemoThreads((current) => ({ ...current, [mode]: [...current[mode], assistantMessage] }));
      setDemoTurns(result.messages_used);
      setDemoLimit(result.messages_used + result.remaining);
      setDemoProvider(result.provider);
      setDemoModel(result.model);
    } catch (error) {
      setDemoThreads((current) => ({
        ...current,
        [mode]: current[mode].filter((item) => item.id !== userMessage.id)
      }));
      setDemoDraft(message);
      setDemoError(error instanceof Error ? error.message : "Bedrock could not answer. Please try again.");
    } finally {
      setPendingDemoMode(null);
    }
  }

  return (
    <div
      ref={kineticRevealRootRef}
      className={editor?.editMode ? "prism-landing route-transition-stage cms-live-public-canvas" : "prism-landing route-transition-stage"}
    >
      {!editorIsInteractive && <LuxuryLoader />}
      <header className="prism-landing-nav" style={elementStyle("header")} {...editableElementProps("header", "header", "Header")}>
        <Link className="prism-brand" to="/" aria-label="Auto-AI home">
          <span className="prism-brand-icon"><LogoIcon /></span>
          <span style={elementStyle("header.brand")} {...editableElementProps("header.brand", "text", "Brand", elementText("header.brand", "Auto-AI"))}>{elementText("header.brand", "Auto-AI")}</span>
          <small style={elementStyle("header.tagline")} {...editableElementProps("header.tagline", "text", "Brand Tagline", elementText("header.tagline", "Prism Intelligence"))}>{elementText("header.tagline", "Prism Intelligence")}</small>
        </Link>

        <PrismNavigation aria-label="Primary navigation">
          {navLinks.map((item) => (
            <button key={item.id} style={elementStyle(`header.nav.${item.id}`)} type="button" onClick={() => scrollToSection(item.id)} aria-current={activeSection === item.id ? "location" : undefined} {...editableElementProps(`header.nav.${item.id}`, "button", "Navigation Item", elementText(`header.nav.${item.id}`, item.label))}>
              {elementText(`header.nav.${item.id}`, item.label)}
            </button>
          ))}
        </PrismNavigation>

        <div className="prism-nav-actions">
          <PrismStatusChip
            className="prism-nav-status"
            tone={online ? "success" : "offline"}
            icon={online ? <Wifi size={13} /> : <WifiOff size={13} />}
          >
            <span style={elementStyle("header.status")}>{online ? "Online" : "Offline"}</span>
          </PrismStatusChip>
          <PrismTooltip label="Quick navigation">
            <PrismIconButton type="button" style={elementStyle("header.quick-navigation")} onClick={() => setCommandOpen(true)} aria-label="Open quick navigation" {...editableElementProps("header.quick-navigation", "button", "Quick Navigation")}>
              <Search size={17} />
              <span className="prism-command-key">Ctrl K</span>
            </PrismIconButton>
          </PrismTooltip>
          <button
            className="prism-button prism-screen-share-nav"
            type="button"
            onClick={screenShare.requestInviteShare}
            style={elementStyle("header.screen-share")}
            {...editableElementProps("header.screen-share", "button", "Screen Share", elementText("header.screen-share", "Screen Share"))}
          >
            <ScreenShare size={16} />
            <span>{elementText("header.screen-share", "Screen Share")}</span>
          </button>
          <Link className="prism-button prism-nav-cta" style={elementStyle("header.sign-in")} to={elementHref("header.sign-in", user ? "/chat" : "/login")} {...editableElementProps("header.sign-in", "button", "Sign In", elementText("header.sign-in", user ? "Open app" : globalContent?.["header.sign_in"] || "Sign in"), elementHref("header.sign-in", user ? "/chat" : "/login"))}>
            {elementText("header.sign-in", user ? "Open app" : globalContent?.["header.sign_in"] || "Sign in")}
          </Link>
          <span className="cms-editable-control" style={elementStyle("header.theme")} {...editableElementProps("header.theme", "button", "Theme Toggle")}><ThemeToggleButton /></span>
          <PrismIconButton
            className="prism-mobile-menu-button"
            style={elementStyle("header.mobile-menu")}
            type="button"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((current) => !current)}
            {...editableElementProps("header.mobile-menu", "button", "Mobile Menu")}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </PrismIconButton>
        </div>

        {mobileMenuOpen && (
          <PrismNavigation className="prism-mobile-menu" aria-label="Mobile navigation">
            {navLinks.map((item) => (
              <button key={item.id} type="button" onClick={() => scrollToSection(item.id)}>{item.label}</button>
            ))}
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                screenShare.requestInviteShare();
              }}
            >
              <ScreenShare size={16} /> Screen Share
            </button>
            <Link to={user ? "/chat" : "/login"} onClick={() => setMobileMenuOpen(false)}>
              {user ? "Open app" : "Sign in"}
            </Link>
          </PrismNavigation>
        )}
      </header>

      <main>
        <section id="overview" className="prism-hero" style={elementStyle("hero")} aria-labelledby="prism-hero-title" {...editableElementProps("hero", "hero_section", "Hero Section")}>
          <div className="prism-hero-copy">
            <PrismBadge><Sparkles size={14} /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("hero.badge")} {...editableElementProps("hero.badge", "badge", "Hero Badge", elementText("hero.badge", "AutoAI Prism Intelligence"))}>{elementText("hero.badge", "AutoAI Prism Intelligence")}</span></PrismBadge>
            <h1 id="prism-hero-title" data-luxury-heading>
              <span className="luxury-line-mask"><span className="luxury-line" data-luxury-line {...editablePageProps("hero_heading")}><LuxuryWordLine text={cmsPage?.hero_heading ?? "Auto-AI"} /></span></span>
              <span className="luxury-line-mask"><span className="luxury-line" data-luxury-line style={elementStyle("hero.heading-suffix")} {...editableElementProps("hero.heading-suffix", "heading", "Heading", elementText("hero.heading-suffix", "Intelligence that stays in your flow."))}><LuxuryWordLine text={elementText("hero.heading-suffix", "Intelligence that stays in your flow.")} /></span></span>
            </h1>
            <p data-kinetic-reveal={LANDING_KINETIC_MAP.heroParagraph} {...editablePageProps("hero_description")}>
              {cmsPage?.hero_description ?? "Chat, speak, research, share, and build with one adaptive AI workspace designed to keep context clear."}
            </p>
            <div className="prism-hero-actions">
              {primaryHeroButton && <Link className="prism-button prism-button-primary" to={user ? "/chat" : primaryHeroButton.url} {...editorProps("page-button-0", "button", "buttons.0.label", { editable: "text", label: "Button", currentValue: primaryHeroButton.label, currentHref: primaryHeroButton.url })}>
                {primaryHeroButton.label} <ArrowRight size={17} />
              </Link>}
              {secondaryHeroButton && <button className="prism-button prism-button-secondary" type="button" onClick={() => scrollToSection("features")} {...editorProps("page-button-1", "button", "buttons.1.label", { editable: "text", label: "Button", currentValue: secondaryHeroButton.label, currentHref: secondaryHeroButton.url })}>
                {secondaryHeroButton.label}
              </button>}
            </div>
            <div className="prism-trust-row" aria-label="Product assurances" style={elementStyle("hero.assurances")} {...editableElementProps("hero.assurances", "container", "Product Assurances")}>
              <span data-kinetic-reveal={alternatingDiagonal(0)} style={elementStyle("hero.assurance.private")} {...editableElementProps("hero.assurance.private", "text", "Assurance", elementText("hero.assurance.private", "Private by design"))}><ShieldCheck size={14} /> {elementText("hero.assurance.private", "Private by design")}</span>
              <span data-kinetic-reveal={alternatingDiagonal(1)} style={elementStyle("hero.assurance.streaming")} {...editableElementProps("hero.assurance.streaming", "text", "Assurance", elementText("hero.assurance.streaming", "Responsive streaming"))}><Zap size={14} /> {elementText("hero.assurance.streaming", "Responsive streaming")}</span>
              <span data-kinetic-reveal={alternatingDiagonal(2)} style={elementStyle("hero.assurance.sharing")} {...editableElementProps("hero.assurance.sharing", "text", "Assurance", elementText("hero.assurance.sharing", "User-controlled sharing"))}><LockKeyhole size={14} /> {elementText("hero.assurance.sharing", "User-controlled sharing")}</span>
            </div>
          </div>

          <PrismSurface className="prism-product-preview" data-luxury-media="hero" style={elementStyle("hero.product-preview")} aria-label="Auto-AI workspace preview" {...editableElementProps("hero.product-preview", "product_preview", "Product Preview")}>
            <div className="prism-preview-topbar">
              <span className="prism-preview-brand" style={elementStyle("preview.brand")} {...editableElementProps("preview.brand", "text", "Preview Brand", elementText("preview.brand", "Auto-AI"))}><LogoIcon /> {elementText("preview.brand", "Auto-AI")}</span>
              <div className="prism-preview-statuses">
                <PrismStatusChip tone="active"><span style={elementStyle("preview.remaining")}>{demoRemaining} demo chats left</span></PrismStatusChip>
                <PrismStatusChip className="prism-bedrock-chip" tone="success" icon={<span className="prism-live-dot" />}>
                  <span style={elementStyle("preview.provider")}>{demoProviderLabel(demoProvider)}</span> <span style={elementStyle("preview.model")}>{demoModel}</span>
                </PrismStatusChip>
              </div>
            </div>
            <PrismTabs label="Preview mode" items={previewModes} active={previewMode} onChange={setPreviewMode} />
            <div className="prism-preview-workspace" data-luxury-parallax>
              <div className="prism-preview-rail" aria-hidden="true">
                <span /><span /><span /><span />
              </div>
              <div className="prism-preview-thread">
                <div className="prism-preview-context">
                  <BrainCircuit size={16} />
                  <span style={elementStyle("preview.context")} {...editableElementProps("preview.context", "text", "Preview Context", elementText("preview.context", "Bedrock context"))}>{elementText("preview.context", "Bedrock context")}</span>
                  <small style={elementStyle("preview.storage")} {...editableElementProps("preview.storage", "text", "Storage Status", elementText("preview.storage", "No chat stored"))}>{elementText("preview.storage", "No chat stored")}</small>
                </div>
                <div className="prism-preview-messages" ref={demoMessagesRef} aria-live="polite">
                  {currentDemoMessages.map((message, index) => (
                    <p key={message.id} className={`prism-preview-message is-${message.role === "assistant" ? "ai" : "user"}`} style={elementStyle(`preview.${previewMode}.message.${index}`)} {...editableElementProps(`preview.${previewMode}.message.${index}`, "paragraph", "Preview Message", elementText(`preview.${previewMode}.message.${index}`, message.text))}>
                      {message.role === "assistant" && <span className="prism-answer-mark"><Sparkles size={14} /></span>}
                      {elementText(`preview.${previewMode}.message.${index}`, message.text)}
                    </p>
                  ))}
                  {pendingDemoMode === previewMode && (
                    <div className="prism-demo-thinking" role="status" aria-label="Auto-AI demo is thinking"><span /><span /><span /></div>
                  )}
                  {demoError && <div className="prism-demo-error" role="alert">{demoError}</div>}
                </div>
                <form className="prism-preview-composer" onSubmit={sendDemoMessage}>
                  <FileText size={15} />
                  <input
                    aria-label="Demo message"
                    value={demoDraft}
                    maxLength={300}
                    disabled={!demoEnabled || demoRemaining <= 0 || Boolean(pendingDemoMode)}
                    placeholder={!demoEnabled ? "AI demo unavailable" : demoRemaining > 0 ? "Message the AI demo" : "Demo limit reached"}
                    onChange={(event) => setDemoDraft(event.target.value)}
                  />
                  <button type="submit" disabled={!demoDraft.trim() || !demoEnabled || demoRemaining <= 0 || Boolean(pendingDemoMode)} aria-label="Send demo message">
                    <ArrowRight size={15} />
                  </button>
                </form>
              </div>
              <div className="prism-preview-intelligence" aria-hidden="true">
                <div className="prism-crystal-object">
                  <span className="facet-one" />
                  <span className="facet-two" />
                </div>
                <span style={elementStyle("preview.model-label")}>{demoProviderLabel(demoProvider)} model</span>
                <small style={elementStyle("preview.model-name")}>{demoModel}</small>
              </div>
            </div>
          </PrismSurface>
        </section>

        <div className="prism-proof-band" style={elementStyle("proof")} aria-label="Auto-AI status" {...editableElementProps("proof", "container", "Proof Band")}>
          {["8 connected capabilities", "1 continuous workspace", "0 silent screen capture"].map((fallback, index) => <span data-kinetic-reveal={alternatingFlight(index)} key={fallback} style={elementStyle(`proof.item.${index}`)} {...editableElementProps(`proof.item.${index}`, "text", "Proof Item", elementText(`proof.item.${index}`, fallback))}>{elementText(`proof.item.${index}`, fallback)}</span>)}
          <PrismStatusChip tone={online ? "active" : "offline"}><span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("proof.status")} {...editableElementProps("proof.status", "text", "System Status", elementText("proof.status", online ? "Systems ready" : "Connection unavailable"))}>{elementText("proof.status", online ? "Systems ready" : "Connection unavailable")}</span></PrismStatusChip>
        </div>

        {extraBlocks.length > 0 && (
          <PrismReveal className="prism-public-section prism-cms-section" data-kinetic-reveal="container-drop">
            <PublishedContentBlocks
              blocks={extraBlocks}
              editMode={editor?.editMode && !editor.previewMode}
              selectedBlockId={editor?.selectedBlockId}
              onSelect={editor?.onSelect}
              onInlineChange={editor?.onBlockFieldChange}
            />
          </PrismReveal>
        )}

        <section id="features" className="prism-public-section prism-feature-section" style={elementStyle("features")} aria-labelledby="features-heading" {...editableElementProps("features", "page_section", "Features Section")}>
          <PrismReveal data-kinetic-reveal="left-flight">
            <div className="prism-section-heading">
              <PrismBadge><BrainCircuit size={14} /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("features.badge")} {...editableElementProps("features.badge", "badge", "Features Badge", elementText("features.badge", "Connected intelligence"))}>{elementText("features.badge", "Connected intelligence")}</span></PrismBadge>
              <h2 id="features-heading" data-kinetic-reveal={LANDING_KINETIC_MAP.sectionOneHeading} {...(featureHeadingBlock ? editorProps(featureHeadingBlock.id, "heading", "text", { editable: "text", label: "Heading", currentValue: featureHeading }) : editableElementProps("features.heading", "heading", "Heading", elementText("features.heading", featureHeading)))}>{featureHeadingBlock ? featureHeading : elementText("features.heading", featureHeading)}</h2>
              <p data-kinetic-reveal={LANDING_KINETIC_MAP.supportingText} style={elementStyle("features.description")} {...editableElementProps("features.description", "paragraph", "Description", elementText("features.description", "Each capability is useful on its own. Together, they keep context moving without forcing you to rebuild it."))}>{elementText("features.description", "Each capability is useful on its own. Together, they keep context moving without forcing you to rebuild it.")}</p>
            </div>
            <div className="prism-bento-grid">
              {bentoFeatures.map((feature, index) => (
                <PrismCard
                  key={feature.title}
                  className={`prism-feature-card is-${feature.size} accent-${feature.accent}`}
                  data-kinetic-reveal={alternatingFlight(index)}
                  data-kinetic-group
                  style={elementStyle(`features.card.${index}`)}
                  {...editableElementProps(`features.card.${index}`, "feature_card", "Feature Card")}
                >
                  <div className="prism-feature-card-head" data-kinetic-inner="meta">
                    <span className="prism-feature-icon">{feature.icon}</span>
                    <PrismStatusChip tone="idle"><span style={elementStyle(`features.card.${index}.signal`)} {...editableElementProps(`features.card.${index}.signal`, "text", "Feature Signal", elementText(`features.card.${index}.signal`, feature.signal))}>{elementText(`features.card.${index}.signal`, feature.signal)}</span></PrismStatusChip>
                  </div>
                  <div>
                    <h3 data-kinetic-inner="heading" style={elementStyle(`features.card.${index}.title`)} {...editableElementProps(`features.card.${index}.title`, "heading", "Feature Title", elementText(`features.card.${index}.title`, feature.title))}>{elementText(`features.card.${index}.title`, feature.title)}</h3>
                    <p data-kinetic-inner="body" style={elementStyle(`features.card.${index}.body`)} {...editableElementProps(`features.card.${index}.body`, "paragraph", "Feature Description", elementText(`features.card.${index}.body`, feature.body))}>{elementText(`features.card.${index}.body`, feature.body)}</p>
                  </div>
                  <span className="prism-card-edge" aria-hidden="true" />
                </PrismCard>
              ))}
            </div>
          </PrismReveal>
        </section>

        <section className="prism-public-section prism-loop-section" style={elementStyle("workflow")} aria-labelledby="loop-heading" {...editableElementProps("workflow", "page_section", "Workflow Section")}>
          <PrismReveal data-kinetic-reveal="right-flight">
            <PrismSurface className="prism-loop-band">
              <div>
                <PrismBadge><Network size={14} /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("workflow.badge")} {...editableElementProps("workflow.badge", "badge", "Workflow Badge", elementText("workflow.badge", "One workspace"))}>{elementText("workflow.badge", "One workspace")}</span></PrismBadge>
                <h2 id="loop-heading" aria-label={elementText("workflow.heading", "From first thought to finished answer.")} data-kinetic-reveal={LANDING_KINETIC_MAP.sectionTwoHeading} style={elementStyle("workflow.heading")} {...editableElementProps("workflow.heading", "heading", "Workflow Heading", elementText("workflow.heading", "From first thought to finished answer."))}><KineticSplitText disabled={editorIsInteractive} text={elementText("workflow.heading", "From first thought to finished answer.")} /></h2>
                <p data-kinetic-reveal={LANDING_KINETIC_MAP.supportingText} style={elementStyle("workflow.description")} {...editableElementProps("workflow.description", "paragraph", "Workflow Description", elementText("workflow.description", "Keep the conversation, supporting files, voice, visual context, and next action in one readable place."))}>{elementText("workflow.description", "Keep the conversation, supporting files, voice, visual context, and next action in one readable place.")}</p>
              </div>
              <div className="prism-capability-list">
                {capabilities.map((capability, index) => <span data-kinetic-reveal={alternatingDiagonal(index)} key={capability} style={elementStyle(`workflow.capability.${index}`)} {...editableElementProps(`workflow.capability.${index}`, "text", "Capability", elementText(`workflow.capability.${index}`, capability))}><Check size={14} /> {elementText(`workflow.capability.${index}`, capability)}</span>)}
              </div>
            </PrismSurface>
          </PrismReveal>
        </section>

        <section id="android" className="prism-public-section" style={elementStyle("android")} aria-labelledby="android-heading" {...editableElementProps("android", "page_section", "Android Section")}>
          <PrismReveal data-kinetic-reveal="diagonal-prism-left">
            <div className="prism-android-layout">
              <div className="prism-android-copy">
                <PrismBadge><Smartphone size={14} /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("android.badge")} {...editableElementProps("android.badge", "badge", "Android Badge", elementText("android.badge", "Android application"))}>{elementText("android.badge", "Android application")}</span></PrismBadge>
                <h2 id="android-heading" data-kinetic-reveal={LANDING_KINETIC_MAP.sectionThreeHeading} style={elementStyle("android.heading")} {...editableElementProps("android.heading", "heading", "Android Heading", elementText("android.heading", "Your Auto-AI workspace, ready to move."))}>{elementText("android.heading", "Your Auto-AI workspace, ready to move.")}</h2>
                <p data-kinetic-reveal={LANDING_KINETIC_MAP.supportingText} style={elementStyle("android.description")} {...editableElementProps("android.description", "paragraph", "Android Description", elementText("android.description", "Use the same account, chat history, calls, screen sharing, uploads, settings, and AI context from your phone."))}>{elementText("android.description", "Use the same account, chat history, calls, screen sharing, uploads, settings, and AI context from your phone.")}</p>
                <div className="prism-release-grid">
                  <span data-kinetic-reveal={alternatingFlight(0)} style={elementStyle("android.release.latest")} {...editableElementProps("android.release.latest", "text", "Latest Version", elementText("android.release.latest", `Latest ${latestApk?.version_name ?? "Checking"}`))}>{elementText("android.release.latest", `Latest ${latestApk?.version_name ?? "Checking"}`)}</span>
                  <span data-kinetic-reveal={alternatingFlight(1)} style={elementStyle("android.release.date")} {...editableElementProps("android.release.date", "text", "Release Date", elementText("android.release.date", `Released ${formatDate(latestApk?.released_at ?? latestApk?.release_date)}`))}>{elementText("android.release.date", `Released ${formatDate(latestApk?.released_at ?? latestApk?.release_date)}`)}</span>
                  <span data-kinetic-reveal={alternatingFlight(2)} style={elementStyle("android.release.downloads")} {...editableElementProps("android.release.downloads", "text", "Downloads", elementText("android.release.downloads", `Downloads ${(apkStats?.total_downloads ?? latestApk?.download_count ?? 0).toLocaleString()}`))}>{elementText("android.release.downloads", `Downloads ${(apkStats?.total_downloads ?? latestApk?.download_count ?? 0).toLocaleString()}`)}</span>
                </div>
                {latestApk?.changelog && <p className="prism-changelog" data-kinetic-reveal={LANDING_KINETIC_MAP.supportingText} style={elementStyle("android.changelog")} {...editableElementProps("android.changelog", "paragraph", "Android Changelog", elementText("android.changelog", latestApk.changelog))}>{elementText("android.changelog", latestApk.changelog)}</p>}
                <div className="prism-android-actions">
                  <PrismButton className="prism-button-primary" style={elementStyle("android.download")} type="button" onClick={() => {
                    const customHref = elementOverrides["android.download"]?.href;
                    if (customHref) window.location.href = elementHref("android.download", qrUrl);
                    else void downloadLatestApk();
                  }} {...editableElementProps("android.download", "button", "Download Button", elementText("android.download", "Download APK"), elementHref("android.download", qrUrl))}>
                    <Download size={17} /> {elementText("android.download", "Download APK")}
                  </PrismButton>
                  <Link className="prism-button prism-button-secondary" style={elementStyle("android.details")} to={elementHref("android.details", "/download")} {...editableElementProps("android.details", "button", "App Details", elementText("android.details", "App details"), elementHref("android.details", "/download"))}>{elementText("android.details", "App details")}</Link>
                </div>
              </div>
              <div className="prism-device-stage" data-luxury-media="scroll">
                <div className="prism-phone" data-luxury-parallax aria-label="Auto-AI Android preview">
                  <div className="prism-phone-screen">
                    <span className="prism-phone-status" style={elementStyle("android.phone.status")} {...editableElementProps("android.phone.status", "text", "Phone Status", elementText("android.phone.status", "9:41"))}>{elementText("android.phone.status", "9:41")} <Wifi size={12} /></span>
                    <span className="prism-phone-brand" style={elementStyle("android.phone.brand")} {...editableElementProps("android.phone.brand", "text", "Phone Brand", elementText("android.phone.brand", "Auto-AI"))}><LogoIcon /> {elementText("android.phone.brand", "Auto-AI")}</span>
                    <span className="prism-phone-copy is-user" style={elementStyle("android.phone.user")} {...editableElementProps("android.phone.user", "text", "Phone Message", elementText("android.phone.user", "Share the latest screen."))}>{elementText("android.phone.user", "Share the latest screen.")}</span>
                    <span className="prism-phone-copy is-ai" style={elementStyle("android.phone.ai")} {...editableElementProps("android.phone.ai", "text", "Phone Answer", elementText("android.phone.ai", "Your secure code is ready."))}>{elementText("android.phone.ai", "Your secure code is ready.")}</span>
                    <span className="prism-phone-share" style={elementStyle("android.phone.share")} {...editableElementProps("android.phone.share", "text", "Screen Share", elementText("android.phone.share", "8-digit screen share"))}><Layers3 size={18} /> {elementText("android.phone.share", "8-digit screen share")}</span>
                  </div>
                </div>
                <div className="prism-qr-panel" data-luxury-parallax>
                  <Suspense fallback={<QrCode size={88} aria-label="QR code loading" />}>
                    <LazyQRCode value={qrUrl} size={104} bgColor="transparent" fgColor="#f7fbff" />
                  </Suspense>
                  <span style={elementStyle("android.qr-label")} {...editableElementProps("android.qr-label", "text", "QR Label", elementText("android.qr-label", "Scan for Android"))}>{elementText("android.qr-label", "Scan for Android")}</span>
                </div>
              </div>
            </div>
          </PrismReveal>
        </section>

        <section className="prism-public-section" style={elementStyle("testimonials")} aria-labelledby="trust-heading" {...editableElementProps("testimonials", "page_section", "Testimonials Section")}>
          <PrismReveal data-kinetic-reveal="diagonal-prism-right">
            <div className="prism-section-heading prism-section-heading-left">
              <PrismBadge><Sparkles size={14} /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("testimonials.badge")} {...editableElementProps("testimonials.badge", "badge", "Testimonials Badge", elementText("testimonials.badge", "Built for real work"))}>{elementText("testimonials.badge", "Built for real work")}</span></PrismBadge>
              <h2 id="trust-heading" data-kinetic-reveal={LANDING_KINETIC_MAP.sectionOneHeading} style={elementStyle("testimonials.heading")} {...editableElementProps("testimonials.heading", "heading", "Testimonials Heading", elementText("testimonials.heading", "Clear enough for every day. Capable enough for the hard days."))}>{elementText("testimonials.heading", "Clear enough for every day. Capable enough for the hard days.")}</h2>
            </div>
            <div className="prism-testimonial-grid">
              {testimonials.map((quote, index) => (
                <PrismCard key={quote} className="prism-quote-card" data-kinetic-reveal={alternatingFlight(index)} data-kinetic-group style={elementStyle(`testimonials.card.${index}`)} {...editableElementProps(`testimonials.card.${index}`, "testimonial", "Testimonial")}>
                  <blockquote data-kinetic-inner="body" style={elementStyle(`testimonials.card.${index}.quote`)} {...editableElementProps(`testimonials.card.${index}.quote`, "quote", "Quote", elementText(`testimonials.card.${index}.quote`, quote))}>{elementText(`testimonials.card.${index}.quote`, quote)}</blockquote>
                  <footer data-kinetic-inner="meta"><span style={elementStyle(`testimonials.card.${index}.author`)} {...editableElementProps(`testimonials.card.${index}.author`, "text", "Author", elementText(`testimonials.card.${index}.author`, "Verified user"))}>{elementText(`testimonials.card.${index}.author`, "Verified user")}</span><PrismStatusChip tone="success"><span style={elementStyle(`testimonials.card.${index}.status`)} {...editableElementProps(`testimonials.card.${index}.status`, "text", "Status", elementText(`testimonials.card.${index}.status`, "Active workspace"))}>{elementText(`testimonials.card.${index}.status`, "Active workspace")}</span></PrismStatusChip></footer>
                </PrismCard>
              ))}
            </div>
          </PrismReveal>
        </section>

        <section id="pricing" className="prism-public-section" style={elementStyle("pricing")} aria-labelledby="pricing-heading" {...editableElementProps("pricing", "page_section", "Pricing Section")}>
          <PrismReveal data-kinetic-reveal="depth-landing">
            <div className="prism-section-heading">
              <PrismBadge><Zap size={14} /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("pricing.badge")} {...editableElementProps("pricing.badge", "badge", "Pricing Badge", elementText("pricing.badge", "Flexible plans"))}>{elementText("pricing.badge", "Flexible plans")}</span></PrismBadge>
              <h2 id="pricing-heading" aria-label={elementText("pricing.heading", "Start focused. Scale when the work grows.")} data-kinetic-reveal={LANDING_KINETIC_MAP.pricingHeading} style={elementStyle("pricing.heading")} {...editableElementProps("pricing.heading", "heading", "Pricing Heading", elementText("pricing.heading", "Start focused. Scale when the work grows."))}><KineticSplitText disabled={editorIsInteractive} text={elementText("pricing.heading", "Start focused. Scale when the work grows.")} /></h2>
              <p data-kinetic-reveal={LANDING_KINETIC_MAP.supportingText} style={elementStyle("pricing.description")} {...editableElementProps("pricing.description", "paragraph", "Pricing Description", elementText("pricing.description", "Choose the workspace capacity that fits today and move up when you need more."))}>{elementText("pricing.description", "Choose the workspace capacity that fits today and move up when you need more.")}</p>
            </div>
            {plans.length ? (
              <div className="prism-pricing-grid">
                {plans.map((plan, index) => (
                  <PrismCard key={plan.id} className={plan.id === "premium" ? "prism-plan-card is-featured" : "prism-plan-card"} data-kinetic-reveal={alternatingFlight(index)} data-kinetic-group style={elementStyle(`pricing.plan.${plan.id}`)} {...editableElementProps(`pricing.plan.${plan.id}`, "pricing_card", "Pricing Card")}>
                    <div className="prism-plan-heading">
                      <h3 data-kinetic-inner="heading" style={elementStyle(`pricing.plan.${plan.id}.name`)} {...editableElementProps(`pricing.plan.${plan.id}.name`, "heading", "Plan Name", elementText(`pricing.plan.${plan.id}.name`, plan.label))}>{elementText(`pricing.plan.${plan.id}.name`, plan.label)}</h3>
                      {plan.id === "premium" && <PrismBadge><span style={elementStyle("pricing.plan.premium.badge")} {...editableElementProps("pricing.plan.premium.badge", "badge", "Plan Badge", elementText("pricing.plan.premium.badge", "Recommended"))}>{elementText("pricing.plan.premium.badge", "Recommended")}</span></PrismBadge>}
                    </div>
                    <strong data-kinetic-inner="body" style={elementStyle(`pricing.plan.${plan.id}.price`)} {...editableElementProps(`pricing.plan.${plan.id}.price`, "text", "Plan Price", elementText(`pricing.plan.${plan.id}.price`, money(plan.price_paise, plan.currency)))}>{elementText(`pricing.plan.${plan.id}.price`, money(plan.price_paise, plan.currency))}</strong>
                    <span data-kinetic-inner="meta" style={elementStyle(`pricing.plan.${plan.id}.quota`)} {...editableElementProps(`pricing.plan.${plan.id}.quota`, "text", "Plan Quota", elementText(`pricing.plan.${plan.id}.quota`, `${plan.token_quota.toLocaleString()} tokens / month`))}>{elementText(`pricing.plan.${plan.id}.quota`, `${plan.token_quota.toLocaleString()} tokens / month`)}</span>
                    <Link className={plan.id === "premium" ? "prism-button prism-button-primary" : "prism-button prism-button-secondary"} style={elementStyle(`pricing.plan.${plan.id}.button`)} to={elementHref(`pricing.plan.${plan.id}.button`, "/pricing")} {...editableElementProps(`pricing.plan.${plan.id}.button`, "button", "Choose Plan", elementText(`pricing.plan.${plan.id}.button`, `Choose ${plan.label}`), elementHref(`pricing.plan.${plan.id}.button`, "/pricing"))}>
                      {elementText(`pricing.plan.${plan.id}.button`, `Choose ${plan.label}`)}
                    </Link>
                  </PrismCard>
                ))}
              </div>
            ) : (
              <PrismEmptyState icon={<Zap size={22} />} title="Plans are syncing" description="Current plan details will appear when the pricing service is available." />
            )}
          </PrismReveal>
        </section>

        <section className="prism-public-section prism-cta-section" style={finalCta ? undefined : elementStyle("cta")} aria-labelledby="cta-heading" {...(finalCta ? editorProps(finalCta.id, "call_to_action", "", { editable: "container", label: "Call To Action" }) : editableElementProps("cta", "call_to_action", "Call To Action"))}>
          <PrismReveal data-kinetic-reveal="container-drop">
            <div className="prism-final-cta">
              <div>
                <PrismBadge><LogoIcon /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("cta.badge")} {...editableElementProps("cta.badge", "badge", "CTA Badge", elementText("cta.badge", "Auto-AI"))}>{elementText("cta.badge", "Auto-AI")}</span></PrismBadge>
                <h2 id="cta-heading" data-kinetic-reveal={LANDING_KINETIC_MAP.importantCta} {...(finalCta ? editorProps(finalCta.id, "call_to_action", "heading", { editable: "text", label: "Heading", currentValue: String(finalCta.content.heading ?? "") }) : editableElementProps("cta.heading", "heading", "CTA Heading", elementText("cta.heading", "Bring the whole workspace into one conversation.")))}>{finalCta ? String(finalCta.content.heading ?? "") : elementText("cta.heading", "Bring the whole workspace into one conversation.")}</h2>
              </div>
              <div className="prism-final-actions">
                <Link className="prism-button prism-button-primary" style={elementStyle("cta.primary")} to={elementHref("cta.primary", user ? "/chat" : "/register")} {...editableElementProps("cta.primary", "button", "CTA Button", elementText("cta.primary", user ? "Open app" : String(finalCta?.content.button_text ?? globalContent?.["cta.default"] ?? "Create account")), elementHref("cta.primary", user ? "/chat" : "/register"))}>
                  {elementText("cta.primary", user ? "Open app" : String(finalCta?.content.button_text ?? globalContent?.["cta.default"] ?? "Create account"))}
                  <ArrowRight size={17} />
                </Link>
                <PrismButton className={copied ? "prism-button-success" : "prism-button-secondary"} style={elementStyle("cta.copy")} type="button" onClick={copyWebsiteLink} {...editableElementProps("cta.copy", "button", "Copy Link", elementText("cta.copy", copied ? "Link copied" : "Copy link"))}>
                  {copied ? <Check size={17} /> : <Copy size={17} />}
                  {elementText("cta.copy", copied ? "Link copied" : "Copy link")}
                </PrismButton>
              </div>
            </div>
          </PrismReveal>
        </section>

        <section id="faq" className="prism-public-section prism-faq-section" style={elementStyle("faq")} aria-labelledby="faq-heading" {...editableElementProps("faq", "page_section", "FAQ Section")}>
          <PrismReveal data-kinetic-reveal="sky-drop">
            <div className="prism-section-heading">
              <PrismBadge><MessageSquare size={14} /> <span data-kinetic-reveal={LANDING_KINETIC_MAP.label} style={elementStyle("faq.badge")} {...editableElementProps("faq.badge", "badge", "FAQ Badge", elementText("faq.badge", "FAQ"))}>{elementText("faq.badge", "FAQ")}</span></PrismBadge>
              <h2 id="faq-heading" data-kinetic-reveal={LANDING_KINETIC_MAP.faqHeading} style={elementStyle("faq.heading")} {...editableElementProps("faq.heading", "heading", "FAQ Heading", elementText("faq.heading", "A few useful answers before you begin."))}>{elementText("faq.heading", "A few useful answers before you begin.")}</h2>
            </div>
            <div className="prism-faq-list">
              {visibleFaqs.map(([question, answer], index) => (
                <details key={`${question}-${index}`} data-kinetic-reveal={alternatingFlight(index)} data-kinetic-group style={elementStyle(`faq.item.${index}`)} {...editableElementProps(`faq.item.${index}`, "faq", "FAQ Item")}>
                  <summary data-kinetic-inner="heading" style={elementStyle(`faq.item.${index}.question`)} {...editableElementProps(`faq.item.${index}.question`, "heading", "FAQ Question", elementText(`faq.item.${index}.question`, question))}>{elementText(`faq.item.${index}.question`, question)}</summary>
                  <p data-kinetic-inner="body" style={elementStyle(`faq.item.${index}.answer`)} {...editableElementProps(`faq.item.${index}.answer`, "paragraph", "FAQ Answer", elementText(`faq.item.${index}.answer`, answer))}>{elementText(`faq.item.${index}.answer`, answer)}</p>
                </details>
              ))}
            </div>
          </PrismReveal>
        </section>
      </main>

      <footer className="prism-footer" style={elementStyle("footer")} {...editableElementProps("footer", "footer", "Footer")}>
        <Link className="prism-brand" to={elementHref("footer.brand", "/")}><span className="prism-brand-icon"><LogoIcon /></span><span style={elementStyle("footer.brand")} {...editableElementProps("footer.brand", "link", "Footer Brand", elementText("footer.brand", "Auto-AI"), elementHref("footer.brand", "/"))}>{elementText("footer.brand", "Auto-AI")}</span></Link>
        <p data-kinetic-reveal={LANDING_KINETIC_MAP.footerText} style={elementStyle("footer.description")} {...editableElementProps("footer.description", "paragraph", "Footer Description", elementText("footer.description", globalContent?.["footer.description"] || "A connected AI workspace for thoughtful, secure, human-feeling work."))}>{elementText("footer.description", globalContent?.["footer.description"] || "A connected AI workspace for thoughtful, secure, human-feeling work.")}</p>
        <PrismStatusChip tone={online ? "success" : "offline"} icon={online ? <Wifi size={13} /> : <WifiOff size={13} />}>
          <span style={elementStyle("footer.status")}>{online ? "Connected" : "Offline"}</span>
        </PrismStatusChip>
      </footer>

      <PrismDialog
        open={commandOpen}
        title="Quick navigation"
        description="Find a page or action in Auto-AI."
        onClose={closeCommand}
      >
        <PrismInput
          autoFocus
          label="Search"
          placeholder="Search Auto-AI"
          value={commandQuery}
          onChange={(event) => setCommandQuery(event.target.value)}
        />
        <div className="prism-command-results">
          {commandItems.map((item) => item.to ? (
            <Link key={item.label} to={item.to} onClick={closeCommand}>
              <span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={16} />
            </Link>
          ) : (
            <button key={item.label} type="button" onClick={() => item.section && scrollToSection(item.section)}>
              <span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowRight size={16} />
            </button>
          ))}
          {!commandItems.length && <PrismEmptyState icon={<Command size={20} />} title="No match" description="Try a shorter search term." />}
        </div>
      </PrismDialog>
    </div>
  );
}
