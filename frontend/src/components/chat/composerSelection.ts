import type { AiProvider, ChatMode, SearchMode } from "../../types";

export type ComposerModeOption = {
  value: "instant" | "medium" | "high" | "deep_research";
  label: string;
  searchMode: SearchMode;
  chatMode: ChatMode;
};

export const COMPOSER_MODE_OPTIONS: readonly ComposerModeOption[] = [
  { value: "instant", label: "Instant", searchMode: "auto", chatMode: "instant" },
  { value: "medium", label: "Medium", searchMode: "auto", chatMode: "medium" },
  { value: "high", label: "High", searchMode: "auto", chatMode: "high" },
  { value: "deep_research", label: "Deep Research", searchMode: "deep", chatMode: "deep_research" }
];

export function composerModeOption(value: string) {
  const aliases: Record<string, ComposerModeOption["value"]> = {
    normal: "instant",
    research: "medium",
    multi_model: "medium",
    deep: "deep_research"
  };
  const canonical = aliases[value] ?? value;
  return COMPOSER_MODE_OPTIONS.find((option) => option.value === canonical) ?? COMPOSER_MODE_OPTIONS[0];
}

export function composerModeValue(searchMode: SearchMode, chatMode: ChatMode) {
  return COMPOSER_MODE_OPTIONS.find(
    (option) => option.searchMode === searchMode && option.chatMode === chatMode
  )?.value ?? composerModeOption(chatMode).value;
}

export function selectedModelPayload(provider: AiProvider, model: string) {
  return { provider, model };
}
