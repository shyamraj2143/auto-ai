import { useContext } from "react";
import { ScreenShareContext } from "./ScreenShareContext";

export function useScreenShare() {
  const context = useContext(ScreenShareContext);
  if (!context) throw new Error("useScreenShare must be used within ScreenShareProvider");
  return context;
}
