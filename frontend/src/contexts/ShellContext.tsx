import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ShellContextValue = {
  isSidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
};

const ShellContext = createContext<ShellContextValue | undefined>(undefined);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const openSidebar = useCallback(() => setIsSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setIsSidebarOpen((current) => !current), []);

  const value = useMemo<ShellContextValue>(
    () => ({
      isSidebarOpen,
      openSidebar,
      closeSidebar,
      toggleSidebar
    }),
    [
      closeSidebar,
      isSidebarOpen,
      openSidebar,
      toggleSidebar
    ]
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell() {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useShell must be used within ShellProvider");
  return context;
}
