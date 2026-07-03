import { Suspense, lazy } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ShellProvider } from "./contexts/ShellContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SeoManager } from "./seo/SeoManager";
import { LandingPage } from "./components/landing/LandingPage";

const AppShell = lazy(() => import("./components/layout/AppShell").then((module) => ({ default: module.AppShell })));
const ChatPage = lazy(() => import("./components/chat/ChatPage").then((module) => ({ default: module.ChatPage })));
const DownloadPage = lazy(() => import("./components/download/DownloadPage").then((module) => ({ default: module.DownloadPage })));
const AdminDashboard = lazy(() => import("./components/admin/AdminDashboard").then((module) => ({ default: module.AdminDashboard })));
const AdminLoginPage = lazy(() => import("./components/auth/AdminLoginPage").then((module) => ({ default: module.AdminLoginPage })));
const LoginPage = lazy(() => import("./components/auth/LoginPage").then((module) => ({ default: module.LoginPage })));
const RegisterPage = lazy(() => import("./components/auth/RegisterPage").then((module) => ({ default: module.RegisterPage })));
const SettingsPage = lazy(() => import("./components/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));

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
  return user?.role === "admin" || user?.role === "super_admin" ? <Outlet /> : <Navigate to="/admin/login" replace />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ShellProvider>
          <BrowserRouter>
            <SeoManager />
            <Suspense fallback={<div className="app-loading">Loading Auto-AI...</div>}>
              <Routes>
                <Route index element={<RootRedirect />} />
                <Route path="/home" element={<Navigate to="/" replace />} />
                <Route path="/download" element={<DownloadPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/admin/login" element={<AdminLoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route element={<ProtectedRoute />}>
                  <Route element={<AppShell />}>
                    <Route path="/chat" element={<ChatPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
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
      </AuthProvider>
    </ThemeProvider>
  );
}
