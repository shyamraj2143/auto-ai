import type { IntelligenceMode } from "../../types";

const CODING = /\b(code|coding|program|debug|bug|exception|stack trace|api|git|github|database|sql|frontend|backend|react|typescript|javascript|python|java|kotlin|swift|rust|golang|docker|kubernetes|css|html|function|class|repository|repo|compile|build|test|refactor)\b/i;
const RESEARCH = /\b(deep research|investigate|systematic review|literature review|compare sources|source-backed|citations?|latest evidence|comprehensive research)\b/i;
const HIGH = /\b(prove|derive|complex|strategy|architecture|analy[sz]e|reasoning|optimi[sz]e|trade-?offs?|root cause|design a system)\b/i;

export function detectPreset(message: string, hasAttachments = false): IntelligenceMode {
  const normalized = message.trim().replace(/\s+/g, " ");
  if (CODING.test(normalized)) return "coding";
  if (RESEARCH.test(normalized)) return "deep_research";
  if (hasAttachments) return "high";
  if (HIGH.test(normalized) || normalized.length > 500) return "high";
  if (normalized.split(/\s+/).filter(Boolean).length <= 8) return "instant";
  return "medium";
}
