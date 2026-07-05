import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bot, CreditCard, Eraser, LogOut, MessageSquarePlus, Pencil, Settings, Shield, Trash2, UserCircle2, X } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useShell } from "../../contexts/ShellContext";
import { useSettingsNavigation } from "../../hooks/useSettingsNavigation";
import { LogoIcon } from "../brand/LogoIcon";

export function Sidebar() {
  const { user, logout } = useAuth();
  const { chats, activeChat, createChat, deleteChat, loadingChats, openChat, updateChat } = useChat();
  const { isSidebarOpen, closeSidebar } = useShell();
  const openSettings = useSettingsNavigation();
  const location = useLocation();

  useEffect(() => {
    if (!isSidebarOpen) return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;

    window.history.pushState({ autoAiDrawer: true }, "");
    const handlePopState = () => {
      if (isSidebarOpen) {
        closeSidebar();
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [closeSidebar, isSidebarOpen]);

  async function renameChat(id: string, currentTitle: string) {
    const nextTitle = window.prompt("Rename chat", currentTitle);
    if (nextTitle?.trim()) {
      await updateChat(id, { title: nextTitle.trim() });
    }
  }

  async function removeChat(id: string) {
    if (window.confirm("Delete this chat?")) {
      await deleteChat(id);
    }
  }

  async function openExistingChat(id: string) {
    await openChat(id);
    closeSidebar();
  }

  async function createNewChat() {
    await createChat();
    closeSidebar();
  }

  async function clearCurrentChat() {
    if (!activeChat?.id || !window.confirm("Clear all messages in this chat?")) return;
    await updateChat(activeChat.id, { clear_messages: true });
    closeSidebar();
  }

  return (
    <>
      {isSidebarOpen && <div className="fixed inset-0 z-40 bg-slate-950/65 backdrop-blur-sm md:hidden" onClick={closeSidebar} />}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-50 w-72 shrink-0 border-r border-white/10 bg-slate-950/95 text-white shadow-[18px_0_60px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-transform duration-300 md:static md:z-auto md:flex md:translate-x-0 md:flex-col",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
      >
        <div className="flex h-14 items-center justify-between gap-3 border-b border-white/10 px-4">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg border border-cyan-200/30 bg-cyan-200/15 text-cyan-100">
              <LogoIcon />
            </span>
            <Link className="font-semibold" to="/chat">
              Auto-AI
            </Link>
          </div>
          <button className="icon-button-dark md:hidden" onClick={closeSidebar} title="Close menu" type="button">
            <X size={16} />
          </button>
        </div>
        <div className="p-3">
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-200/20 bg-cyan-200/10 px-3 py-2 text-sm font-medium text-cyan-50 transition hover:bg-cyan-200/15"
            onClick={createNewChat}
            type="button"
          >
            <MessageSquarePlus size={17} />
            New chat
          </button>
        </div>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {loadingChats && <p className="px-2 py-2 text-sm text-white/50">Loading...</p>}
          {chats.map((chat) => (
            <div
              key={chat.id}
              className={clsx(
                "group flex items-center rounded-lg transition",
                activeChat?.id === chat.id && location.pathname === "/chat" ? "bg-white/15" : "hover:bg-white/10"
              )}
            >
              <button className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm" onClick={() => openExistingChat(chat.id)} type="button">
                {chat.title}
              </button>
              <button
                className="mr-1 rounded p-1 text-white/50 opacity-0 hover:text-white group-hover:opacity-100"
                onClick={() => renameChat(chat.id, chat.title)}
                title="Rename chat"
                type="button"
              >
                <Pencil size={15} />
              </button>
              <button
                className="mr-2 rounded p-1 text-white/50 opacity-0 hover:text-red-300 group-hover:opacity-100"
                onClick={() => removeChat(chat.id)}
                title="Delete chat"
                type="button"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3 space-y-2">
          {(user?.role === "admin" || user?.role === "super_admin") && (
            <Link
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-200/20 bg-cyan-200/10 px-3 py-2 text-sm font-medium text-cyan-50 transition hover:bg-cyan-200/15"
              onClick={closeSidebar}
              to="/admin"
            >
              <Shield size={16} />
              Admin Dashboard
            </Link>
          )}
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-white transition hover:border-cyan-200/30 hover:bg-cyan-200/10 md:hidden"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("toggle-context-panel"));
              closeSidebar();
            }}
            type="button"
          >
            <Bot size={16} />
            Context & Memory
          </button>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-white transition hover:border-cyan-200/30 hover:bg-cyan-200/10"
            aria-label="Open account and settings"
            onClick={() => {
              openSettings();
              closeSidebar();
            }}
            type="button"
          >
            <Settings size={16} />
            Account & Settings
          </button>
          {activeChat?.id && (
            <button
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-white transition hover:border-cyan-200/30 hover:bg-cyan-200/10"
              onClick={clearCurrentChat}
              type="button"
            >
              <Eraser size={16} />
              Clear current chat
            </button>
          )}
          <Link
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-white transition hover:border-cyan-200/30 hover:bg-cyan-200/10"
            onClick={closeSidebar}
            to="/pricing"
          >
            <CreditCard size={16} />
            Subscription
          </Link>
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3 text-xs leading-5 text-slate-300">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
              <UserCircle2 size={15} />
              Profile
            </div>
            <p className="truncate text-slate-200">{user?.name ?? "Account"}</p>
            <p className="truncate text-slate-400">{user?.email ?? ""}</p>
          </div>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-100 transition hover:bg-red-500/20"
            onClick={logout}
            type="button"
          >
            <LogOut size={16} />
            Logout
          </button>
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3 text-xs leading-5 text-slate-300">
            <div className="mb-2 flex items-center gap-2 font-medium text-white">
              <Bot size={14} />
              Human mode
            </div>
            Memory, tone, and flow signals are active for every new response.
          </div>
        </div>
      </aside>
    </>
  );
}
