import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import gsap from "gsap";
import {
  ArrowRight,
  Brain,
  Check,
  Download,
  FileText,
  MessageSquare,
  Mic,
  Smartphone,
  Zap
} from "lucide-react";
import { APK_DOWNLOAD_URL } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { LogoIcon } from "../brand/LogoIcon";

const features = [
  { icon: <Brain size={18} />, title: "Adaptive memory", body: "Preference, project, and style signals shape future replies without making the assistant feel scripted." },
  { icon: <FileText size={18} />, title: "Document context", body: "PDF, DOCX, TXT, and image context flow into one composer with previews, progress, and recovery states." },
  { icon: <MessageSquare size={18} />, title: "Human conversation", body: "Emotion, tone, humor, and callbacks make each reply feel more like a continuation than a reset." }
];

const capabilities = ["Streaming chat", "Voice input", "Image analysis", "Memory panel", "Search mode", "Regenerate", "Bookmarks", "Prompt editing"];

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

export function LandingPage() {
  const { user } = useAuth();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const qrUrl = typeof window === "undefined" ? APK_DOWNLOAD_URL : new URL(APK_DOWNLOAD_URL, window.location.origin).toString();

  useEffect(() => {
    if (!stageRef.current) return;
    const context = gsap.context(() => {
      gsap.to(".signal-line", {
        backgroundPosition: "220% 0",
        duration: 8,
        ease: "none",
        repeat: -1,
        stagger: 0.35
      });
      gsap.to(".preview-pulse", {
        opacity: 0.35,
        scale: 1.04,
        duration: 1.8,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
        stagger: 0.2
      });
    }, stageRef);
    return () => context.revert();
  }, []);

  return (
    <div ref={stageRef} className="landing-page">
      <header className="landing-nav">
        <Link className="brand-mark" to="/">
          <span className="brand-icon"><LogoIcon /></span>
          Auto-AI
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
          <a href="#features">Features</a>
          <Link to="/download">Android</Link>
          <a href="#pricing">Pricing</a>
          <Link to="/admin/login">Admin</Link>
          <a href="#faq">FAQ</a>
        </nav>
        <Link className="btn-primary" to={user ? "/chat" : "/login"}>
          {user ? "Open app" : "Sign in"}
          <ArrowRight size={16} />
        </Link>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-lighting" aria-hidden="true" />
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55 }}
            className="hero-copy"
          >
            <p className="hero-kicker"><Zap size={14} /> Ultra Premium AI Workspace</p>
            <h1>Auto-AI</h1>
            <p className="hero-subtitle">
              A commercial-grade AI experience with memory, uploads, voice, streaming, and a conversation style that feels alive.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link className="btn-primary h-11 px-5" to={user ? "/chat" : "/register"}>
                Start building
                <ArrowRight size={17} />
              </Link>
              <Link className="btn-secondary h-11 px-5" to={user ? "/chat" : "/login"}>
                View workspace
              </Link>
            </div>
            <div className="mobile-feature-strip">
              <span><MessageSquare size={14} /> Streaming</span>
              <span><Mic size={14} /> Voice</span>
              <span><FileText size={14} /> Files</span>
              <span><Zap size={14} /> Memory</span>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 22, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.08 }}
            className="product-preview"
            aria-label="Auto-AI product preview"
          >
            <div className="preview-sidebar">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-main">
              <div className="signal-line" />
              <div className="preview-message user">Audit the upload flow and make the UI feel premium.</div>
              <div className="preview-message ai">
                <span className="preview-pulse" />
                I found the split upload path. I’ll move documents, images, voice, and send into one composer, then keep memory visible beside the thread.
              </div>
              <div className="preview-composer">
                <Mic size={14} />
                <FileText size={14} />
                <span>Message Auto-AI</span>
                <ArrowRight size={14} />
              </div>
            </div>
          </motion.div>
        </section>

        <section id="features" className="landing-section">
          <div className="section-heading">
            <p className="hero-kicker">Product System</p>
            <h2>Every interaction has weight, motion, and memory.</h2>
          </div>
          <div className="feature-grid">
            {features.map((feature) => (
              <motion.article
                key={feature.title}
                whileHover={{ y: -4 }}
                className="premium-feature"
              >
                <span>{feature.icon}</span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </motion.article>
            ))}
          </div>
        </section>

        <section className="landing-section">
          <div className="android-promo">
            <div>
              <p className="hero-kicker"><Smartphone size={14} /> Android App</p>
              <h2>Install Auto-AI on Android</h2>
              <p>
                Use the same account, backend, memory, chat history, uploads, settings, and source-grounded answers from your phone.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <a className="btn-primary h-11 px-5" href={APK_DOWNLOAD_URL}>
                  <Download size={17} />
                  Download APK
                </a>
                <Link className="btn-secondary h-11 px-5" to="/download">
                  App details
                </Link>
              </div>
            </div>
            <div className="android-preview-wrap">
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
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="capability-band">
            <div>
              <p className="hero-kicker">AI Capabilities</p>
              <h2>One surface for the whole loop.</h2>
            </div>
            <div className="capability-grid">
              {capabilities.map((capability) => (
                <span key={capability}><Check size={14} /> {capability}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="testimonial-grid">
            {testimonials.map((quote) => (
              <figure key={quote}>
                <blockquote>{quote}</blockquote>
                <figcaption>Auto-AI beta user</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section id="pricing" className="landing-section">
          <div className="pricing-grid">
            {["Starter", "Pro", "Studio"].map((plan, index) => (
              <article key={plan} className="pricing-card">
                <p>{plan}</p>
                <h3>{index === 0 ? "$0" : index === 1 ? "$19" : "Custom"}</h3>
                <span>{index === 0 ? "Personal testing" : index === 1 ? "Power users" : "Teams and deployments"}</span>
                <Link className={index === 1 ? "btn-primary" : "btn-secondary"} to={user ? "/chat" : "/register"}>
                  Choose {plan}
                </Link>
              </article>
            ))}
          </div>
        </section>

        <section id="faq" className="landing-section">
          <div className="faq-list">
            {faqs.map(([question, answer]) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span className="brand-mark"><span className="brand-icon"><LogoIcon /></span> Auto-AI</span>
        <p>Premium AI workspace for contextual, human-feeling conversations.</p>
      </footer>
    </div>
  );
}
