import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function useSettingsNavigation() {
  const navigate = useNavigate();

  return useCallback(() => {
    try {
      const result = navigate("/settings") as void | Promise<void>;
      if (result && typeof result.catch === "function") {
        void result.catch((error: unknown) => {
          console.error("[Auto-AI Navigation] Failed to open settings.", error);
        });
      }
    } catch (error) {
      console.error("[Auto-AI Navigation] Failed to open settings.", error);
    }
  }, [navigate]);
}
