import { Suspense, lazy, useEffect, useRef, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { HashRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ShellProvider } from "./contexts/ShellContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SeoManager } from "./seo/SeoManager";
import { AppErrorBoundary } from "./components/common/AppErrorBoundary";
import { LandingPage } from "./components/landing/LandingPage";
import { isMobileAppRuntime } from "./utils/runtime";
import { MotionProvider } from "./motion/MotionProvider";
import { consumeSafeRootRedirect, markStartupStable } from "./reliability/safeMode";
import { AppSettingsProvider } from "./contexts/AppSettingsContext";
import { AnnouncementBanner } from "./components/common/AnnouncementBanner";
import { isAdminPanelRole } from "./utils/roles";

const AppShell = lazy(() => import("./components/layout/AppShell").then((module) => ({ default: module.AppShell })));
const ChatPage = lazy(() => import("./components/chat/ChatPage").then((module) => ({ default: module.ChatPage })));
const DownloadPage = lazy(() => import("./components/download/DownloadPage").then((module) => ({ default: module.DownloadPage })));
const AdminDashboard = lazy(() => import("./components/admin/AdminDashboard").then((module) => ({ default: module.AdminDashboard })));
const AdminLoginPage = lazy(() => import("./components/auth/AdminLoginPage").then((module) => ({ default: module.AdminLoginPage })));
const LoginPage = lazy(() => import("./components/auth/LoginPage").then((module) => ({ default: module.LoginPage })));
const PaymentCheckoutPage = lazy(() => import("./components/payments/PaymentCheckoutPage").then((module) => ({ default: module.PaymentCheckoutPage })));
const PaymentStatusPage = lazy(() => import("./components/payments/PaymentStatusPage").then((module) => ({ default: module.PaymentStatusPage })));
const PricingPage = lazy(() => import("./components/pricing/PricingPage").then((module) => ({ default: module.PricingPage })));
const RegisterPage = lazy(() => import("./components/auth/RegisterPage").then((module) => ({ default: module.RegisterPage })));
const ResetPasswordPage = lazy(() => import("./components/auth/ResetPasswordPage").then((module) => ({ default: module.ResetPasswordPage })));
const SettingsPage = lazy(() => import("./components/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const CallsPage = lazy(() => import("./features/calls/CallsPage").then((module) => ({ default: module.CallsPage })));
const UserMessagesPage = lazy(() => import("./features/userMessages/UserMessagesPage").then((module) => ({ default: module.UserMessagesPage })));
const ScreenShareJoinPage = lazy(() => import("./features/screenShare/ScreenShareJoinPage").then((module) => ({ default: module.ScreenShareJoinPage })));

/** Shows LandingPage for guests, redirects logged-in users to /chat */
function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="app-loading">Loading Auto-AI...</div>;
  }
  if (isMobileAppRuntime()) {
    return <Navigate to={user ? "/chat" : "/login"} replace />;
  }
  return user ? <Navigate to="/chat" replace /> : <LandingPage />;
}

function MobileBlockedRoute({ children }: { children: ReactNode }) {
  return isMobileAppRuntime() ? <Navigate to="/" replace /> : children;
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
  return isAdminPanelRole(user?.role) ? <Outlet /> : <Navigate to="/admin/login" replace />;
}

function AppRoutes() {
  const location = useLocation();
  return (
    <AppErrorBoundary resetKey={`${location.pathname}${location.search}`}>
      <Suspense fallback={<div className="app-loading">Loading Auto-AI...</div>}>
        <Routes>
          <Route index element={<RootRedirect />} />
          <Route path="/home" element={<Navigate to="/" replace />} />
          <Route path="/download" element={<MobileBlockedRoute><DownloadPage /></MobileBlockedRoute>} />
          <Route path="/pricing" element={<MobileBlockedRoute><PricingPage /></MobileBlockedRoute>} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/payment/checkout" element={<PaymentCheckoutPage />} />
          <Route path="/payment/success" element={<PaymentStatusPage status="success" />} />
          <Route path="/payment/failed" element={<PaymentStatusPage status="failed" />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/:chatId" element={<ChatPage />} />
              <Route path="/messages" element={<UserMessagesPage />} />
              <Route path="/messages/:threadId" element={<UserMessagesPage />} />
              <Route path="/screen-share/:sessionId" element={<ScreenShareJoinPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/calls" element={<CallsPage />} />
            </Route>
          </Route>
          <Route element={<AdminRoute />}>
            <Route element={<AppShell />}>
              <Route path="/admin" element={<AdminDashboard />} />
              <Route path="/admin/*" element={<AdminDashboard />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppErrorBoundary>
  );
}

function StartupRecoveryMarker() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const safeRootRef = useRef(consumeSafeRootRedirect());

  useEffect(() => {
    const timer = window.setTimeout(markStartupStable, 4500);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!safeRootRef.current || loading) return;
    safeRootRef.current = false;
    navigate(user ? "/chat" : "/login", { replace: true });
  }, [loading, navigate, user]);

  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <MotionProvider>
        <AppSettingsProvider>
          <AuthProvider>
            <ShellProvider>
              <HashRouter>
                <SeoManager />
                <AnnouncementBanner />
                <StartupRecoveryMarker />
                <AppRoutes />
              </HashRouter>
            </ShellProvider>
          </AuthProvider>
        </AppSettingsProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}
