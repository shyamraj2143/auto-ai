import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { PaidPricingPlanName, PaymentConfig, PricingPlanName } from "../../types";
import { createRazorpayCheckoutOptions, loadRazorpayCheckout } from "../../utils/razorpay";
import { isMobileAppRuntime } from "../../utils/runtime";
import { normalizeUpiId } from "../../utils/upi";
import { LogoIcon } from "../brand/LogoIcon";
import { FishAnimationToggleButton } from "../layout/FishAnimationToggleButton";
import { ThemeToggleButton } from "../layout/ThemeToggleButton";
import { UpiPaymentBox } from "../payments/UpiPaymentBox";

type Plan = {
  id: PricingPlanName;
  label: string;
  price: string;
  amount: number;
  tokens: string;
  highlights: string[];
};

const plans: Plan[] = [
  { id: "free", label: "Free", price: "₹0", amount: 0, tokens: "10,000 tokens/month", highlights: ["Chat access", "Voice input", "File uploads"] },
  { id: "pro", label: "Pro", price: "₹20", amount: 2000, tokens: "100,000 tokens/month", highlights: ["More monthly tokens", "Web search", "Priority quota review"] },
  { id: "premium", label: "Premium", price: "₹50", amount: 5000, tokens: "300,000 tokens/month", highlights: ["Deep research access", "Multi-model routing", "Higher daily messages"] },
  { id: "ultra", label: "Ultra", price: "₹100", amount: 10000, tokens: "1,000,000 tokens/month", highlights: ["Largest quota", "Advanced research", "Best for heavy use"] }
];

const paymentInstruction = "After payment, send your registered email and payment screenshot to admin.";

export function PricingPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null);
  const [busyPlan, setBusyPlan] = useState<PaidPricingPlanName | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mobileApp = isMobileAppRuntime();

  const razorpayKeyId = paymentConfig?.key_id || "";
  const razorpayReady = paymentConfig?.razorpay_ready ?? false;
  const upiId = normalizeUpiId(paymentConfig?.upi_id || import.meta.env.VITE_UPI_ID || "");
  const upiPayeeName = paymentConfig?.upi_payee_name || import.meta.env.VITE_UPI_PAYEE_NAME || "Auto-AI";

  useEffect(() => {
    let active = true;
    api.paymentConfig()
      .then((config) => {
        if (active) setPaymentConfig(config);
      })
      .catch(() => {
        if (active) setPaymentConfig(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function startCheckout(plan: Extract<Plan, { id: PaidPricingPlanName }> | Plan) {
    if (plan.id === "free") return;
    if (!token || !user) {
      navigate("/login");
      return;
    }
    if (!razorpayKeyId) {
      setError("Razorpay public key is missing. Set RAZORPAY_KEY_ID in backend environment.");
      return;
    }
    if (!razorpayReady) {
      setError("Razorpay payment is not fully configured on the backend.");
      return;
    }
    const paidPlan = plan.id as PaidPricingPlanName;
    setBusyPlan(paidPlan);
    setError("");
    setMessage("");
    try {
      const session = await api.createPaymentSession(token, {
        plan_id: paidPlan,
        amount: plan.amount,
        currency: "INR",
        receipt: `auto-ai-${paidPlan}-${Date.now()}`.slice(0, 40)
      });
      await loadRazorpayCheckout();
      if (!window.Razorpay) throw new Error("Razorpay checkout failed to load. Check internet connection and try again.");
      const checkout = new window.Razorpay(createRazorpayCheckoutOptions({
        key: session.key_id || razorpayKeyId,
        amount: session.amount,
        currency: session.currency,
        name: "Auto-AI",
        description: `${plan.label} plan`,
        orderId: session.razorpay_order_id,
        prefill: {
          name: user.name,
          email: user.email,
          contact: user.mobile || ""
        },
        onDismiss: () => {
          setBusyPlan(null);
          setError("Payment cancelled.");
        },
        onSuccess: (response) => {
          void api.verifyRazorpayPayment(token, {
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature
          })
            .then((result) => {
              setMessage(result.message || paymentInstruction);
              setError("");
            })
            .catch((err) => {
              setError(err instanceof Error ? err.message : "Payment verification failed.");
            })
            .finally(() => setBusyPlan(null));
        }
      }));
      checkout.on("payment.failed", (response) => {
        setBusyPlan(null);
        const description = response.error?.description || response.error?.reason || "Payment failed.";
        setError(description.toLowerCase().includes("api key") && description.toLowerCase().includes("expired")
          ? "Razorpay API key has expired. Update the Razorpay env keys and rebuild the app."
          : description);
      });
      checkout.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start payment.");
      setBusyPlan(null);
    }
  }

  return (
    <div className="landing-page pricing-page">
      <header className="landing-nav">
        <Link className="brand-mark" to="/">
          <span className="brand-icon"><LogoIcon /></span>
          Auto-AI
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
          <Link to="/">Home</Link>
          <Link to="/download">Android</Link>
          <Link to="/admin/login">Admin</Link>
        </nav>
        <div className="nav-actions">
          <FishAnimationToggleButton />
          <Link className="btn-primary" to={user ? "/chat" : "/login"}>
            {user ? "Open app" : "Sign in"}
            <ArrowRight size={16} />
          </Link>
          <ThemeToggleButton />
        </div>
      </header>

      <main className="landing-section pricing-main">
        <div className="section-heading">
          <p className="hero-kicker"><CreditCard size={14} /> Subscription</p>
          <h1>Auto-AI Pricing</h1>
          <p className="pricing-subtitle">{paymentInstruction}</p>
        </div>

        {(message || error) && (
          <div className={message ? "payment-alert payment-alert-success" : "payment-alert payment-alert-error"}>
            {message || error}
          </div>
        )}

        <div className="pricing-grid pricing-grid-four">
          {plans.map((plan) => {
            const paidPlan = plan.id !== "free" ? plan.id : null;
            const paymentLink = paidPlan ? paymentConfig?.payment_links[paidPlan] : null;
            const busy = busyPlan === plan.id;
            return (
              <article key={plan.id} className={plan.id === "premium" ? "pricing-card pricing-card-featured" : "pricing-card"}>
                <h3>{plan.label}</h3>
                <strong className="pricing-price">{plan.price}</strong>
                <span>{plan.tokens}</span>
                <ul className="pricing-list">
                  {plan.highlights.map((item) => (
                    <li key={item}><Check size={14} /> {item}</li>
                  ))}
                </ul>
                {plan.id === "free" ? (
                  <Link className="btn-secondary" to={user ? "/chat" : "/register"}>Start free</Link>
                ) : (
                  <div className="pricing-actions">
                    {upiId && <UpiPaymentBox upiId={upiId} payeeName={upiPayeeName} amountPaise={plan.amount} planLabel={plan.label} />}
                    <button className="btn-primary" disabled={busy} onClick={() => startCheckout(plan)} type="button">
                      {busy ? <Loader2 className="spin-icon" size={16} /> : <CreditCard size={16} />}
                      UPI QR / Cards / Wallet
                    </button>
                    {paymentLink ? (
                      <a className="btn-secondary" href={paymentLink} rel="noreferrer" target={mobileApp ? "_self" : "_blank"}>
                        <ExternalLink size={16} />
                        Payment Link
                      </a>
                    ) : (
                      <button className="btn-secondary" disabled={busy} onClick={() => startCheckout(plan)} type="button">
                        <ExternalLink size={16} />
                        Payment Link
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}
