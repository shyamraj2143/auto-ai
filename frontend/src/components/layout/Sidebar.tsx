import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Bot, CreditCard, Eraser, LogOut, MessageCircle, MessageSquarePlus, PanelLeftClose, Pencil, Search, Settings, Shield, Trash2, UserCircle2, X } from "lucide-react";
import clsx from "clsx";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useShell } from "../../contexts/ShellContext";
import { useSettingsNavigation } from "../../hooks/useSettingsNavigation";
import { LogoIcon } from "../brand/LogoIcon";
import { isAdminPanelRole } from "../../utils/roles";

const accountMenuItemClass =
  "compact-button flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-white transition hover:border-cyan-200/30 hover:bg-cyan-200/10";
const accountMenuDangerClass =
  "compact-button flex w-full items-center justify-center gap-2 rounded-lg border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-100 transition hover:bg-red-500/20";

function formatSubscriptionStatus(value?: string | null) {
  const normalized = value?.trim().toLowerCase().replace(/[_-]+/g, " ") || "free";
  if (normalized === "free") return "Free plan";
  if (normalized === "active") return "Active subscription";
  if (normalized === "paid") return "Paid subscription";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} plan`;
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const { chats, activeChat, createChat, deleteChat, loadingChats, openChat, updateChat } = useChat();
  const { activeConversationId, activeMode, isSidebarOpen, isSidebarCollapsed, closeSidebar, collapseSidebar, setActiveAiConversation, setActiveUserMessages } = useShell();
  const openSettings = useSettingsNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const filteredChats = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return chats;
    return chats.filter((chat) => chat.title.toLowerCase().includes(term));
  }, [chats, query]);

  const displayName = user?.name?.trim() || "Account";
  const displayEmail = user?.email?.trim() || "";
  const subscriptionLabel = formatSubscriptionStatus(user?.subscription_status);
  const subscriptionHref = "/settings?section=subscription";
  const profileInitial = (displayName || displayEmail || "A").charAt(0).toUpperCase();
  const profileAvatar = resolveApiAssetUrl(user?.avatar || user?.picture);

  useEffect(() => {
    if (!isAccountMenuOpen) return;
    const handleAndroidBack = (event: Event) => {
      event.preventDefault();
      setIsAccountMenuOpen(false);
    };
    window.addEventListener("auto-ai-android-back", handleAndroidBack);
    return () => {
      window.removeEventListener("auto-ai-android-back", handleAndroidBack);
    };
  }, [isAccountMenuOpen]);

  useEffect(() => {
    if (!isSidebarOpen) {
      setIsAccountMenuOpen(false);
    }
  }, [isSidebarOpen]);

  useEffect(() => {
    if (!isAccountMenuOpen) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && !accountMenuRef.current?.contains(target)) {
        setIsAccountMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAccountMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAccountMenuOpen]);

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
    setActiveAiConversation(id);
    navigate(`/chat/${encodeURIComponent(id)}`);
    await openChat(id);
    closeSidebar();
  }

  async function createNewChat() {
    const chat = await createChat();
    setActiveAiConversation(chat.id);
    navigate(`/chat/${encodeURIComponent(chat.id)}`);
    closeSidebar();
  }

  async function clearCurrentChat() {
    if (!activeChat?.id || !window.confirm("Clear all messages in this chat?")) return;
    await updateChat(activeChat.id, { clear_messages: true });
    setIsAccountMenuOpen(false);
    closeSidebar();
  }

  return (
    <>
      {isSidebarOpen && <div className="fixed inset-0 z-40 bg-slate-950/65 backdrop-blur-sm md:hidden" onClick={closeSidebar} />}
      <aside
        className={clsx(
          "workspace-sidebar compact-panel fixed inset-y-0 left-0 z-50 flex w-80 shrink-0 flex-col border-r border-white/10 bg-slate-950/95 text-white shadow-[18px_0_60px_rgba(0,0,0,0.35)] backdrop-blur-xl transition-transform duration-300 md:static md:z-auto md:translate-x-0",
          isSidebarCollapsed && "workspace-sidebar-collapsed md:hidden",
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
          <button
            className="icon-button-dark sidebar-collapse-button"
            onClick={() => {
              if (window.matchMedia("(max-width: 767px)").matches) {
                closeSidebar();
                return;
              }
              collapseSidebar();
            }}
            title="Hide chat history"
            type="button"
          >
            <PanelLeftClose className="hidden md:block" size={16} />
            <X className="md:hidden" size={16} />
          </button>
        </div>
        <div className="space-y-3 p-3">
          <button
            className="compact-button premium-gradient-button flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-cyan-200/30 bg-cyan-200 px-3 text-sm font-bold text-slate-950 transition hover:bg-white"
            onClick={createNewChat}
            type="button"
          >
            <MessageSquarePlus size={17} />
            New chat
          </button>
          <Link
            className="compact-button flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.055] px-3 text-sm font-semibold text-cyan-50 transition hover:border-cyan-200/30 hover:bg-cyan-200/10"
            onClick={() => {
              setActiveUserMessages(null);
              closeSidebar();
            }}
            to="/messages"
          >
            <MessageCircle size={16} />
            User messages
          </Link>
          <label className="compact-input flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.055] px-3 text-sm text-slate-300 focus-within:border-cyan-200/40">
            <Search size={15} className="shrink-0 text-slate-500" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
            />
          </label>
        </div>
        <div className="flex items-center justify-between px-4 pb-2 text-[11px] font-bold uppercase text-slate-500">
          <span>Chat history</span>
          <span>{filteredChats.length}</span>
        </div>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {loadingChats && <p className="px-2 py-2 text-sm text-white/50">Loading...</p>}
          {!loadingChats && filteredChats.length === 0 && (
            <p className="px-2 py-2 text-sm text-white/45">No chats found</p>
          )}
          {filteredChats.map((chat) => (
            <div
              key={chat.id}
              className={clsx(
                "compact-sidebar-item group flex items-center rounded-lg border border-transparent transition",
                activeMode === "ai" && (activeConversationId === chat.id || activeChat?.id === chat.id) && location.pathname.startsWith("/chat")
                  ? "glow-active border-cyan-200/20 bg-cyan-200/12"
                  : "hover:bg-white/10"
              )}
            >
              <button className="min-w-0 flex-1 px-3 py-2 text-left" onClick={() => openExistingChat(chat.id)} type="button">
                <span className="block truncate text-sm text-slate-100">{chat.title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-slate-500">{chat.mode || "normal"} / {chat.model}</span>
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
        <div ref={accountMenuRef} className="relative border-t border-white/10 p-3">
          {isAccountMenuOpen && (
            <div className="absolute bottom-[calc(100%+8px)] left-3 right-3 z-50 max-h-[calc(100vh-96px)] space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-slate-950 p-2 shadow-[0_22px_65px_rgba(0,0,0,0.55)]">
              {isAdminPanelRole(user?.role) && (
                <Link
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-200/20 bg-cyan-200/10 px-3 py-2 text-sm font-medium text-cyan-50 transition hover:bg-cyan-200/15"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    closeSidebar();
                  }}
                  to="/admin"
                >
                  <Shield size={16} />
                  Admin Dashboard
                </Link>
              )}
              <button
                className={`${accountMenuItemClass} md:hidden`}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("toggle-context-panel"));
                  setIsAccountMenuOpen(false);
                  closeSidebar();
                }}
                type="button"
              >
                <Bot size={16} />
                Context & Memory
              </button>
              <button
                className={accountMenuItemClass}
                aria-label="Open account and settings"
                onClick={() => {
                  openSettings();
                  setIsAccountMenuOpen(false);
                  closeSidebar();
                }}
                type="button"
              >
                <Settings size={16} />
                Account & Settings
              </button>
              {activeChat?.id && (
                <button className={accountMenuItemClass} onClick={clearCurrentChat} type="button">
                  <Eraser size={16} />
                  Clear current chat
                </button>
              )}
              <Link
                className={accountMenuItemClass}
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  closeSidebar();
                }}
                to={subscriptionHref}
              >
                <CreditCard size={16} />
                Subscription
              </Link>
              <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3 text-xs leading-5 text-slate-300">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-white">
                  <UserCircle2 size={15} />
                  Profile
                </div>
                <p className="truncate text-slate-200">{displayName}</p>
                <p className="truncate text-slate-400">{displayEmail}</p>
                <p className="truncate text-cyan-200">{subscriptionLabel}</p>
              </div>
              <button
                className={accountMenuDangerClass}
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  closeSidebar();
                  logout();
                }}
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
          )}
          <div className="flex items-center gap-2">
            <button
              className={clsx(
                "flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] p-2 text-left transition hover:border-cyan-200/40 hover:bg-cyan-200/12",
                isAccountMenuOpen && "border-cyan-200/50 bg-cyan-200/15 text-cyan-50"
              )}
              aria-expanded={isAccountMenuOpen}
              aria-haspopup="menu"
              aria-label="Open profile menu"
              onClick={() => setIsAccountMenuOpen((current) => !current)}
              title="Profile menu"
              type="button"
            >
              <span className="profileicon grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06] text-sm font-bold text-white">
                {profileAvatar ? <img className="h-full w-full object-cover" src={profileAvatar} alt="" /> : profileInitial}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-white">{displayName}</span>
                <span className="block truncate text-[11px] font-medium text-cyan-200">{subscriptionLabel}</span>
              </span>
            </button>
            <Link
              className="account-subscription-button grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-cyan-200/25 bg-cyan-200/10 text-cyan-100 transition hover:border-cyan-200/45 hover:bg-cyan-200/18"
              onClick={() => {
                setIsAccountMenuOpen(false);
                closeSidebar();
              }}
              title="Subscription"
              aria-label="Open subscription"
              to={subscriptionHref}
            >
              <CreditCard size={18} />
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
