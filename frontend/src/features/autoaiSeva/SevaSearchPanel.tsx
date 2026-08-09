import { ArrowRight, Bot, CheckCircle2, LoaderCircle, Search, Sparkles, UsersRound } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { ServiceTaskView } from "../../types";
import { sevaApi } from "./sevaApi";

const THINKING_STAGES = [
  "Understanding what you want to apply for",
  "Matching verified services and portal adapters",
  "Checking form fields and document requirements",
  "Preparing a resumable application workspace",
];

const SUGGESTIONS = [
  "मुझे बिहार का आय प्रमाण पत्र बनवाना है",
  "Scholarship के लिए apply करना है",
  "Government hospital appointment book करना है",
  "Admission form भरना है",
];

export function SevaSearchPanel({
  token,
  onStarted,
}: {
  token: string;
  onStarted: (task: ServiceTaskView, fallbackToEmployee: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");
  const [resultMessage, setResultMessage] = useState("");

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
    setResultMessage("");
    try {
      const result = await sevaApi.startRequest(token, value);
      setResultMessage(result.message);
      onStarted(result.task, result.fallback_to_employee);
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
            {working ? "Preparing" : "Start application"}
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
      {resultMessage ? <p className="seva-search-result"><CheckCircle2 size={16} />{resultMessage}</p> : null}
      {error ? <p className="seva-error" role="alert">{error}</p> : null}
      <div className="seva-search-fallback"><UsersRound size={17} /><span><strong>No automatic adapter?</strong> Complete the structured form once; submission automatically creates and assigns the agent task.</span></div>
    </section>
  );
}
