import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ShellContextValue = {
  activeMode: "ai" | "userMessages";
  activeConversationId: string | null;
  activeUserChatId: string | null;
  isSidebarOpen: boolean;
  isSidebarCollapsed: boolean;
  setActiveAiConversation: (conversationId: string | null) => void;
  setActiveUserMessages: (chatId: string | null) => void;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
  collapseSidebar: () => void;
  expandSidebar: () => void;
  toggleSidebarCollapsed: () => void;
};

const ShellContext = createContext<ShellContextValue | undefined>(undefined);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [activeMode, setActiveMode] = useState<"ai" | "userMessages">("ai");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeUserChatId, setActiveUserChatId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const setActiveAiConversation = useCallback((conversationId: string | null) => {
    setActiveMode("ai");
    setActiveConversationId(conversationId);
  }, []);
  const setActiveUserMessages = useCallback((chatId: string | null) => {
    setActiveMode("userMessages");
    setActiveUserChatId(chatId);
  }, []);
  const openSidebar = useCallback(() => setIsSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);
  const toggleSidebar = useCallback(() => setIsSidebarOpen((current) => !current), []);
  const collapseSidebar = useCallback(() => setIsSidebarCollapsed(true), []);
  const expandSidebar = useCallback(() => setIsSidebarCollapsed(false), []);
  const toggleSidebarCollapsed = useCallback(() => setIsSidebarCollapsed((current) => !current), []);

  const value = useMemo<ShellContextValue>(
    () => ({
      activeMode,
      activeConversationId,
      activeUserChatId,
      isSidebarOpen,
      isSidebarCollapsed,
      setActiveAiConversation,
      setActiveUserMessages,
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
      activeConversationId,
      activeMode,
      activeUserChatId,
      isSidebarCollapsed,
      isSidebarOpen,
      openSidebar,
      setActiveAiConversation,
      setActiveUserMessages,
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
