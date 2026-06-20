import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import gsap from "gsap";
import {
  ArrowRight,
  Brain,
  Check,
  FileText,
  Lock,
  MessageSquare,
  Mic,
  Sparkles,
  Zap
} from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

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
          <span className="brand-icon"><Sparkles size={18} /></span>
          Auto-AI
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
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
        <span className="brand-mark"><span className="brand-icon"><Lock size={16} /></span> Auto-AI</span>
        <p>Premium AI workspace for contextual, human-feeling conversations.</p>
      </footer>
    </div>
  );
}
