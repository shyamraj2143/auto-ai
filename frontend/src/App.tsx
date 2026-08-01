import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ShellProvider } from "./contexts/ShellContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SeoManager } from "./seo/SeoManager";
import { AppErrorBoundary } from "./components/common/AppErrorBoundary";
import { LandingPage } from "./components/landing/LandingPage";
import { PublicCmsPage } from "./components/common/PublicCmsPage";
import { isMobileAppRuntime } from "./utils/runtime";
import { MotionProvider } from "./motion/MotionProvider";
import { consumeSafeRootRedirect, markStartupStable } from "./reliability/safeMode";
import { AppSettingsProvider } from "./contexts/AppSettingsContext";
import { AnnouncementBanner } from "./components/common/AnnouncementBanner";
import { isAdminPanelRole } from "./utils/roles";
import { ApiClientError } from "./api/client";
import { ScreenShareProvider } from "./features/screenShare/ScreenShareProvider";
import { ScreenShareOverlay } from "./features/screenShare/ScreenShareOverlay";
import "./features/screenShare/screenShare.css";

const AppShell = lazy(() => import("./components/layout/AppShell").then((module) => ({ default: module.AppShell })));
const ChatPage = lazy(() => import("./components/chat/ChatPage").then((module) => ({ default: module.ChatPage })));
const DownloadPage = lazy(() => import("./components/download/DownloadPage").then((module) => ({ default: module.DownloadPage })));
const AdminDashboard = lazy(() =>
  import("./components/admin/AdminDashboard")
    .then((module) => ({ default: module.AdminDashboard }))
    .catch((error) => {
      console.error("ADMIN_ROUTE_LOAD_FAILED", error);
      throw error;
    })
);
const AdminLoginPage = lazy(() => import("./components/auth/AdminLoginPage").then((module) => ({ default: module.AdminLoginPage })));
const LoginPage = lazy(() => import("./components/auth/LoginPage").then((module) => ({ default: module.LoginPage })));
const PaymentCheckoutPage = lazy(() => import("./components/payments/PaymentCheckoutPage").then((module) => ({ default: module.PaymentCheckoutPage })));
const PaymentStatusPage = lazy(() => import("./components/payments/PaymentStatusPage").then((module) => ({ default: module.PaymentStatusPage })));
const PricingPage = lazy(() => import("./components/pricing/PricingPage").then((module) => ({ default: module.PricingPage })));
const RegisterPage = lazy(() => import("./components/auth/RegisterPage").then((module) => ({ default: module.RegisterPage })));
const ResetPasswordPage = lazy(() => import("./components/auth/ResetPasswordPage").then((module) => ({ default: module.ResetPasswordPage })));
const SettingsPage = lazy(() => import("./components/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const CallsPage = lazy(() => import("./features/calls/CallsPage").then((module) => ({ default: module.CallsPage })));
const ActiveCallPage = lazy(() => import("./features/calls/ActiveCallPage").then((module) => ({ default: module.ActiveCallPage })));
const UserMessagesPage = lazy(() => import("./features/userMessages/UserMessagesPage").then((module) => ({ default: module.UserMessagesPage })));
const ScreenShareJoinPage = lazy(() => import("./features/screenShare/ScreenShareJoinPage").then((module) => ({ default: module.ScreenShareJoinPage })));
const ScreenShareWorkspacePage = lazy(() => import("./features/screenShare/ScreenShareWorkspacePage").then((module) => ({ default: module.ScreenShareWorkspacePage })));
const ActionHubPage = lazy(() => import("./features/actionHub/ActionHubPage").then((module) => ({ default: module.ActionHubPage })));
const AlarmPage = lazy(() => import("./features/alarms/AlarmPage").then((module) => ({ default: module.AlarmPage })));

/** Shows LandingPage for guests, redirects logged-in users to the Action Hub. */
function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="app-loading">Loading Auto-AI...</div>;
  }
  if (isMobileAppRuntime()) {
    return <Navigate to={user ? "/hub" : "/login"} replace />;
  }
  return user ? <Navigate to="/hub" replace /> : <LandingPage />;
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
  const { user, token, loading, refreshProfile } = useAuth();
  const [verification, setVerification] = useState<"idle" | "checking" | "allowed" | "forbidden" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (loading) return;
    if (!token) {
      console.warn("ADMIN_ROLE_MISSING");
      setVerification("forbidden");
      return;
    }
    let active = true;
    setVerification("checking");
    refreshProfile()
      .then((account) => {
        if (!active) return;
        if (isAdminPanelRole(account.role)) {
          setVerification("allowed");
        } else {
          console.warn("ADMIN_ROLE_FORBIDDEN", { role: account.role });
          setVerification("forbidden");
        }
      })
      .catch((error) => {
        if (!active) return;
        const apiError = error instanceof ApiClientError ? error : null;
        const code = apiError?.status === 401
          ? "ADMIN_API_UNAUTHORIZED"
          : apiError?.status === 403
            ? "ADMIN_API_FORBIDDEN"
            : "ADMIN_NETWORK_ERROR";
        console.error(code, error);
        setMessage(apiError?.status === 401
          ? "Your session expired. Please sign in again."
          : apiError?.status === 403
            ? "Admin access is not enabled for this account."
            : "Admin access could not be verified. Check your connection and retry.");
        setVerification("error");
      });
    return () => {
      active = false;
    };
  }, [loading, refreshProfile, token]);

  if (loading || verification === "idle" || verification === "checking") {
    return <div className="app-loading">Verifying admin access...</div>;
  }
  if (verification === "error") {
    return (
      <main className="app-error-page">
        <section className="app-error-card">
          <h1>Admin access could not be verified</h1>
          <p>{message}</p>
          <button className="btn-primary" type="button" onClick={() => window.location.reload()}>Retry</button>
        </section>
      </main>
    );
  }
  return verification === "allowed" && isAdminPanelRole(user?.role)
    ? <Outlet />
    : <Navigate to={token ? "/hub" : "/admin/login"} replace />;
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
          <Route path="/screen-share/:sessionId" element={<ScreenShareJoinPage />} />
          <Route path="/about" element={<MobileBlockedRoute><PublicCmsPage /></MobileBlockedRoute>} />
          <Route path="/features" element={<MobileBlockedRoute><PublicCmsPage /></MobileBlockedRoute>} />
          <Route path="/contact" element={<MobileBlockedRoute><PublicCmsPage /></MobileBlockedRoute>} />
          <Route path="/help" element={<MobileBlockedRoute><PublicCmsPage /></MobileBlockedRoute>} />
          <Route path="/privacy-policy" element={<MobileBlockedRoute><PublicCmsPage /></MobileBlockedRoute>} />
          <Route path="/terms-and-conditions" element={<MobileBlockedRoute><PublicCmsPage /></MobileBlockedRoute>} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/hub" element={<ActionHubPage />} />
              <Route path="/activity" element={<ActionHubPage />} />
              <Route path="/alarms" element={<AlarmPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/:chatId" element={<ChatPage />} />
              <Route path="/messages" element={<UserMessagesPage />} />
              <Route path="/messages/:threadId" element={<UserMessagesPage />} />
              <Route path="/screen-share" element={<ScreenShareWorkspacePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/calls" element={<Navigate to="/call-hub/search" replace />} />
              <Route path="/calls/active/:callId" element={<ActiveCallPage />} />
              <Route path="/call-hub/:section" element={<CallsPage />} />
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
    navigate(user ? "/hub" : "/login", { replace: true });
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
              <BrowserRouter>
                <ScreenShareProvider>
                  <SeoManager />
                  <AnnouncementBanner />
                  <StartupRecoveryMarker />
                  <AppRoutes />
                  <ScreenShareOverlay />
                </ScreenShareProvider>
              </BrowserRouter>
            </ShellProvider>
          </AuthProvider>
        </AppSettingsProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}
