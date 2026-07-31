import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Chat, ChatListItem, ChatMode, IntelligenceMode } from "../types";

type PresetState = {
  chatMode: ChatMode;
  presetMode: "auto" | "manual";
  selectedPreset: IntelligenceMode;
  manualPresetLocked: boolean;
};

type ChatUpdatePayload = {
  title?: string;
  system_prompt?: string;
  model?: string;
  mode?: ChatMode;
  presetMode?: "auto" | "manual";
  selectedPreset?: IntelligenceMode;
  manualPresetLocked?: boolean;
  clear_messages?: boolean;
};
import { useAuth } from "./AuthContext";

type ChatContextValue = {
  chats: ChatListItem[];
  activeChat: Chat | null;
  loadingChats: boolean;
  refreshChats: () => Promise<void>;
  openChat: (id: string) => Promise<void>;
  createChat: (title?: string, preset?: PresetState) => Promise<Chat>;
  updateChat: (id: string, payload: ChatUpdatePayload) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  setActiveChat: React.Dispatch<React.SetStateAction<Chat | null>>;
};

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [loadingChats, setLoadingChats] = useState(false);

  const refreshChats = useCallback(async () => {
    if (!token) return;
    setLoadingChats(true);
    try {
      setChats(await api.listChats(token));
    } finally {
      setLoadingChats(false);
    }
  }, [token]);

  const openChat = useCallback(
    async (id: string) => {
      if (!token) return;
      const chat = await api.getChat(token, id);
      setActiveChat(chat);
    },
    [token]
  );

  const createChat = useCallback(
    async (title = "New chat", preset?: PresetState) => {
      if (!token) throw new Error("Not authenticated");
      const chat = await api.createChat(token, {
        title,
        mode: preset?.chatMode,
        presetMode: preset?.presetMode,
        selectedPreset: preset?.selectedPreset,
        manualPresetLocked: preset?.manualPresetLocked
      });
      setActiveChat(chat);
      await refreshChats();
      return chat;
    },
    [refreshChats, token]
  );

  const updateChat = useCallback(
    async (id: string, payload: ChatUpdatePayload) => {
      if (!token) return;
      const updated = await api.updateChat(token, id, payload);
      setActiveChat((current) => (current?.id === id ? updated : current));
      await refreshChats();
    },
    [refreshChats, token]
  );

  const deleteChat = useCallback(
    async (id: string) => {
      if (!token) return;
      await api.deleteChat(token, id);
      setActiveChat((current) => (current?.id === id ? null : current));
      await refreshChats();
    },
    [refreshChats, token]
  );

  useEffect(() => {
    if (token) {
      refreshChats();
    } else {
      setChats([]);
      setActiveChat(null);
    }
  }, [refreshChats, token]);

  const value = useMemo(
    () => ({
      chats,
      activeChat,
      loadingChats,
      refreshChats,
      openChat,
      createChat,
      updateChat,
      deleteChat,
      setActiveChat
    }),
    [activeChat, chats, createChat, deleteChat, loadingChats, openChat, refreshChats, updateChat]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error("useChat must be used within ChatProvider");
  return context;
}
