import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ShellContextValue = {
  isSidebarOpen: boolean;
  isSidebarCollapsed: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
  collapseSidebar: () => void;
  expandSidebar: () => void;
  toggleSidebarCollapsed: () => void;
};

const ShellContext = createContext<ShellContextValue | undefined>(undefined);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const openSidebar = useCallback(() => setIsSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setIsSidebarOpen((current) => !current), []);
  const collapseSidebar = useCallback(() => setIsSidebarCollapsed(true), []);
  const expandSidebar = useCallback(() => setIsSidebarCollapsed(false), []);
  const toggleSidebarCollapsed = useCallback(() => setIsSidebarCollapsed((current) => !current), []);

  const value = useMemo<ShellContextValue>(
    () => ({
      isSidebarOpen,
      isSidebarCollapsed,
      openSidebar,
      closeSidebar,
      toggleSidebar,
      collapseSidebar,
      expandSidebar,
      toggleSidebarCollapsed
    }),
    [
      collapseSidebar,
      closeSidebar,
      expandSidebar,
      isSidebarCollapsed,
      isSidebarOpen,
      openSidebar,
      toggleSidebar,
      toggleSidebarCollapsed
    ]
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell() {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useShell must be used within ShellProvider");
  return context;
}
