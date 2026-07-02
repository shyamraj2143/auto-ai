import { Link, useLocation } from "react-router-dom";
import { Bot, MessageSquarePlus, Pencil, Settings, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { useChat } from "../../contexts/ChatContext";
import { useShell } from "../../contexts/ShellContext";
import { LogoIcon } from "../brand/LogoIcon";

export function Sidebar() {
  const { chats, activeChat, createChat, deleteChat, loadingChats, openChat, updateChat } = useChat();
  const { isSidebarOpen, closeSidebar, openSettings } = useShell();
  const location = useLocation();

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
            onClick={openSettings}
            type="button"
          >
            <Settings size={16} />
            Account & Settings
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
