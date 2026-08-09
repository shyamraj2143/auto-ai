import { ArrowRight, Bot, Building2, CheckCircle2, Clock3, FileText, LoaderCircle, Search, Sparkles, UsersRound } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { sevaApi, type SevaDiscovery, type SevaService } from "./sevaApi";

const THINKING_STAGES = [
  "Understanding what you want to apply for",
  "Matching verified services and portal adapters",
  "Checking form fields and document requirements",
  "Preparing service details for your confirmation",
];

const SUGGESTIONS = [
  "मुझे बिहार का आय प्रमाण पत्र बनवाना है",
  "Scholarship के लिए apply करना है",
  "Government hospital appointment book करना है",
  "Admission form भरना है",
];

export function SevaSearchPanel({
  token,
  onServiceSelected,
}: {
  token: string;
  onServiceSelected: (service: SevaService, query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");
  const [discovery, setDiscovery] = useState<SevaDiscovery | null>(null);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setStage((value) => Math.min(THINKING_STAGES.length - 1, value + 1)), 900);
    return () => window.clearInterval(timer);
  }, [working]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (!value || working) return;
    setWorking(true);
    setStage(0);
    setError("");
    setDiscovery(null);
    try {
      setDiscovery(await sevaApi.discoverServices(token, value));
      setWorking(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AutoAI could not prepare this application.");
      setWorking(false);
    }
  }

  return (
    <section className="seva-search-panel" aria-label="Search a service to apply for">
      <div className="seva-search-copy">
        <span><Sparkles size={16} /> Tell AutoAI what you want to apply for</span>
        <h2>Search any form, certificate, scholarship or service.</h2>
        <p>Known services open their exact verified form. Unknown services open a structured agent-assisted request without losing your progress.</p>
      </div>
      <form onSubmit={submit} className="seva-search-form">
        <div className="seva-search-input">
          <Search size={20} />
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Example: मुझे income certificate apply करना है"
            rows={3}
            maxLength={1000}
            disabled={working}
          />
          <button type="submit" disabled={working || query.trim().length < 3}>
            {working ? <LoaderCircle className="spin" size={19} /> : <ArrowRight size={19} />}
            {working ? "Searching" : "Find services"}
          </button>
        </div>
        <div className="seva-search-suggestions">
          {SUGGESTIONS.map((item) => (
            <button key={item} type="button" disabled={working} onClick={() => setQuery(item)}>{item}</button>
          ))}
        </div>
      </form>
      {working ? (
        <div className="seva-thinking-panel" aria-live="polite">
          <span className="seva-thinking-core"><Bot size={22} /></span>
          <div>
            <strong>AutoAI is working</strong>
            {THINKING_STAGES.map((item, index) => (
              <p key={item} className={index < stage ? "done" : index === stage ? "active" : "pending"}>
                {index < stage ? <CheckCircle2 size={15} /> : index === stage ? <LoaderCircle className="spin" size={15} /> : <span />}
                {item}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {discovery ? (
        <div className="seva-service-matches" aria-live="polite">
          <header>
            <span><CheckCircle2 size={17} /> Service matches</span>
            <p>Review the details and confirm the correct service before an application is created.</p>
          </header>
          {(discovery.candidates.length ? discovery.candidates : discovery.fallback ? [discovery.fallback] : []).map((service) => (
            <article key={service.id}>
              <div className="seva-service-match-title">
                <span><FileText size={18} /></span>
                <div><strong>{service.name}</strong><small>{service.provider}</small></div>
                {service.confidence ? <b>{Math.round(service.confidence * 100)}% match</b> : <b>Agent assisted</b>}
              </div>
              <div className="seva-service-match-facts">
                <span><Building2 size={14} />{service.department}</span>
                <span><Clock3 size={14} />{service.expected_timeline}</span>
                <span>{service.documents.filter((item) => item.required !== false).length} required documents</span>
              </div>
              <p>{service.description}</p>
              <button type="button" onClick={() => onServiceSelected(service, discovery.query)}>
                View details and confirm <ArrowRight size={16} />
              </button>
            </article>
          ))}
        </div>
      ) : null}
      {error ? <p className="seva-error" role="alert">{error}</p> : null}
      <div className="seva-search-fallback"><UsersRound size={17} /><span><strong>No automatic adapter?</strong> Complete the structured form once; submission automatically creates and assigns the agent task.</span></div>
    </section>
  );
}
