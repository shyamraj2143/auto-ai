import { Suspense, lazy, useEffect } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { BrowserRouter, useLocation } from "react-router-dom";
import { AdminDashboard } from "./components/admin/AdminDashboard";
import { AdminLoginPage } from "./components/auth/AdminLoginPage";
import { LoginPage } from "./components/auth/LoginPage";
import { RegisterPage } from "./components/auth/RegisterPage";
import { Header } from "./components/layout/Header";
import { Sidebar } from "./components/layout/Sidebar";
import { SettingsModal } from "./components/layout/SettingsModal";
import { AppSettingsProvider } from "./contexts/AppSettingsContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ChatProvider } from "./contexts/ChatContext";
import { ShellProvider, useShell } from "./contexts/ShellContext";
import { ThemeProvider } from "./contexts/ThemeContext";

const ChatPage = lazy(() => import("./components/chat/ChatPage").then((module) => ({ default: module.ChatPage })));
const DownloadPage = lazy(() => import("./components/download/DownloadPage").then((module) => ({ default: module.DownloadPage })));
const LandingPage = lazy(() => import("./components/landing/LandingPage").then((module) => ({ default: module.LandingPage })));

/** Shows LandingPage for guests, redirects logged-in users to /chat */
function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="app-loading">Loading Auto-AI...</div>;
  }
  return user ? <Navigate to="/chat" replace /> : <LandingPage />;
}

function ProtectedRoute() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="app-loading">Loading Auto-AI...</div>;
  }
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}

function AdminRoute() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="app-loading">Loading Auto-AI...</div>;
  }
  return user?.role === "admin" ? <Outlet /> : <Navigate to="/admin/login" replace />;
}

function AppShell() {
  const location = useLocation();
  const {
    isSettingsOpen,
    closeSidebar,
    closeSettings
  } = useShell();

  useEffect(() => {
    closeSidebar();
    closeSettings();
  }, [closeSettings, closeSidebar, location.pathname]);

  return (
    <ChatProvider>
      <div className="app-shell">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header />
          <Outlet />
        </main>
        <SettingsModal open={isSettingsOpen} onClose={closeSettings} />
      </div>
    </ChatProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppSettingsProvider>
          <ShellProvider>
            <BrowserRouter>
              <Suspense fallback={<div className="app-loading">Loading Auto-AI...</div>}>
                <Routes>
                  <Route index element={<RootRedirect />} />
                  <Route path="/home" element={<LandingPage />} />
                  <Route path="/download" element={<DownloadPage />} />
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/admin/login" element={<AdminLoginPage />} />
                  <Route path="/register" element={<RegisterPage />} />
                  <Route element={<ProtectedRoute />}>
                    <Route element={<AppShell />}>
                      <Route path="/chat" element={<ChatPage />} />
                    </Route>
                  </Route>
                  <Route element={<AdminRoute />}>
                    <Route element={<AppShell />}>
                      <Route path="/admin" element={<AdminDashboard />} />
                    </Route>
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </BrowserRouter>
          </ShellProvider>
        </AppSettingsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
