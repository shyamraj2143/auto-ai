import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CreditCard, Loader2, XCircle } from "lucide-react";
import { api } from "../../api/client";
import type { PaymentSession } from "../../types";
import { createRazorpayCheckoutOptions, loadRazorpayCheckout } from "../../utils/razorpay";

function planLabel(planId?: string | null) {
  if (!planId) return "Auto-AI plan";
  return `${planId.charAt(0).toUpperCase()}${planId.slice(1)} plan`;
}

export function PaymentCheckoutPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const openedRef = useRef(false);
  const [session, setSession] = useState<PaymentSession | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sessionId = new URLSearchParams(location.search).get("session_id") || "";

  useEffect(() => {
    let active = true;

    async function startCheckout() {
      if (!sessionId) {
        setError("Payment session is missing.");
        setLoading(false);
        return;
      }
      try {
        const nextSession = await api.paymentSession(sessionId);
        if (!active) return;
        setSession(nextSession);
        if (nextSession.status === "paid") {
          navigate(`/payment/success?order_id=${encodeURIComponent(nextSession.razorpay_order_id)}`, { replace: true });
          return;
        }
        if (openedRef.current) return;
        openedRef.current = true;
        await loadRazorpayCheckout();
        if (!window.Razorpay) throw new Error("Razorpay checkout failed to load.");
        const checkout = new window.Razorpay(createRazorpayCheckoutOptions({
          key: nextSession.key_id,
          amount: nextSession.amount,
          currency: nextSession.currency,
          name: "Auto-AI",
          description: planLabel(nextSession.plan_id),
          orderId: nextSession.razorpay_order_id,
          prefill: {
            name: nextSession.user_name || "",
            email: nextSession.user_email || "",
            contact: ""
          },
          onDismiss: () => {
            navigate(`/payment/failed?order_id=${encodeURIComponent(nextSession.razorpay_order_id)}`, { replace: true });
          },
          onSuccess: (response) => {
            void api.verifyRazorpayPayment(null, {
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_signature: response.razorpay_signature
            })
              .then(() => {
                navigate(`/payment/success?payment_id=${encodeURIComponent(response.razorpay_payment_id)}`, { replace: true });
              })
              .catch(() => {
                navigate(`/payment/failed?order_id=${encodeURIComponent(response.razorpay_order_id)}`, { replace: true });
              });
          }
        }));
        checkout.on("payment.failed", () => {
          navigate(`/payment/failed?order_id=${encodeURIComponent(nextSession.razorpay_order_id)}`, { replace: true });
        });
        checkout.open();
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to open payment checkout.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void startCheckout();
    return () => {
      active = false;
    };
  }, [navigate, sessionId]);

  return (
    <div className="landing-page pricing-page">
      <main className="landing-section pricing-main">
        <div className="section-heading">
          <p className="hero-kicker">
            {error ? <XCircle size={14} /> : <CreditCard size={14} />}
            Payment
          </p>
          <h1>{error ? "Payment Could Not Open" : "Opening Secure Checkout"}</h1>
          <p className="pricing-subtitle">
            {error || "Razorpay checkout will open for your saved Auto-AI payment session."}
          </p>
        </div>
        {!error && (
          <div className="payment-alert payment-alert-success">
            {loading ? <Loader2 className="spin-icon" size={16} /> : <CreditCard size={16} />}
            {session ? `${planLabel(session.plan_id)} / ${(session.amount / 100).toFixed(2)} ${session.currency}` : "Preparing payment..."}
          </div>
        )}
        {error && <div className="payment-alert payment-alert-error">{error}</div>}
        <div className="pricing-actions">
          <Link className="btn-secondary" to="/pricing">Back to Pricing</Link>
        </div>
      </main>
    </div>
  );
}
