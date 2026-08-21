import { useEffect, useState } from "react";
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
  const [session, setSession] = useState<PaymentSession | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [checkoutReady, setCheckoutReady] = useState(false);
  const [opening, setOpening] = useState(false);
  const sessionId = new URLSearchParams(location.search).get("session_id") || "";

  useEffect(() => {
    let active = true;

    async function prepareCheckout() {
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

        // Preload checkout.js while the page is preparing. The actual
        // Razorpay.open() call happens only from the button click below.
        await loadRazorpayCheckout();
        if (!active) return;
        if (!window.Razorpay) throw new Error("Razorpay checkout failed to load.");
        setCheckoutReady(true);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to prepare payment checkout.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void prepareCheckout();
    return () => {
      active = false;
    };
  }, [navigate, sessionId]);

  function openCheckout() {
    if (!session || !checkoutReady || !window.Razorpay || opening) return;

    setOpening(true);
    setError("");

    try {
      const checkout = new window.Razorpay(createRazorpayCheckoutOptions({
        key: session.key_id,
        amount: session.amount,
        currency: session.currency,
        name: "Auto-AI",
        description: planLabel(session.plan_id),
        orderId: session.razorpay_order_id,
        prefill: {
          name: session.user_name || "",
          email: session.user_email || "",
          contact: ""
        },
        onDismiss: () => {
          setOpening(false);
          navigate(`/payment/failed?order_id=${encodeURIComponent(session.razorpay_order_id)}`, { replace: true });
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
            .catch((err) => {
              setOpening(false);
              setError(err instanceof Error ? err.message : "Payment verification failed.");
            });
        }
      }));

      checkout.on("payment.failed", (response) => {
        setOpening(false);
        const description = response.error?.description || response.error?.reason || "Payment failed.";
        setError(description);
      });

      // This is intentionally synchronous with the user's click. Razorpay
      // documents that popup checkout should be opened from a user action.
      checkout.open();
    } catch (err) {
      setOpening(false);
      setError(err instanceof Error ? err.message : "Unable to open Razorpay checkout.");
    }
  }

  return (
    <div className="landing-page pricing-page">
      <main className="landing-section pricing-main">
        <div className="section-heading">
          <p className="hero-kicker">
            {error ? <XCircle size={14} /> : <CreditCard size={14} />}
            Payment
          </p>
          <h1>{error ? "Payment Could Not Open" : "Secure Checkout"}</h1>
          <p className="pricing-subtitle">
            {error || (loading ? "Preparing your secure Razorpay checkout..." : "Your payment session is ready. Continue to Razorpay to pay securely.")}
          </p>
        </div>

        {session && !error && (
          <div className="payment-alert payment-alert-success">
            {planLabel(session.plan_id)} / {(session.amount / 100).toFixed(2)} {session.currency}
          </div>
        )}

        {error && <div className="payment-alert payment-alert-error">{error}</div>}

        <div className="pricing-actions">
          {!error && (
            <button
              className="btn-primary"
              type="button"
              disabled={loading || !session || !checkoutReady || opening}
              onClick={openCheckout}
            >
              {loading || opening ? <Loader2 className="spin-icon" size={16} /> : <CreditCard size={16} />}
              {opening ? "Opening Razorpay..." : loading ? "Preparing Checkout..." : checkoutReady ? "Open Secure Payment" : "Loading Payment..."}
            </button>
          )}
          <Link className="btn-secondary" to="/pricing">Back to Pricing</Link>
        </div>
      </main>
    </div>
  );
}
