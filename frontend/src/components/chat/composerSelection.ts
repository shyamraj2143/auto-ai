import type { AiProvider, ChatMode, SearchMode } from "../../types";

export type ComposerModeOption = {
  value: "normal" | "deep" | "research";
  label: string;
  searchMode: SearchMode;
  chatMode: ChatMode;
};

export const COMPOSER_MODE_OPTIONS: readonly ComposerModeOption[] = [
  { value: "normal", label: "Normal", searchMode: "auto", chatMode: "normal" },
  { value: "deep", label: "Deep", searchMode: "deep", chatMode: "deep_research" },
  { value: "research", label: "Research", searchMode: "research", chatMode: "multi_model" }
];

export function composerModeOption(value: string) {
  return COMPOSER_MODE_OPTIONS.find((option) => option.value === value) ?? COMPOSER_MODE_OPTIONS[0];
}

export function composerModeValue(searchMode: SearchMode, chatMode: ChatMode) {
  return COMPOSER_MODE_OPTIONS.find(
    (option) => option.searchMode === searchMode && option.chatMode === chatMode
  )?.value ?? "normal";
}

export function selectedModelPayload(provider: AiProvider, model: string) {
  return { provider, model };
}
