import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { PaidPricingPlanName, PaymentConfig, PricingPlanName } from "../../types";
import { LogoIcon } from "../brand/LogoIcon";

type RazorpaySuccessResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayFailureResponse = {
  error?: {
    description?: string;
    reason?: string;
  };
};

type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: {
    name?: string;
    email?: string;
  };
  theme: {
    color: string;
  };
  modal: {
    ondismiss: () => void;
  };
  handler: (response: RazorpaySuccessResponse) => void;
};

type RazorpayCheckout = {
  open: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayFailureResponse) => void) => void;
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayCheckout;
  }
}

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

  const razorpayKeyId = useMemo(() => paymentConfig?.key_id || import.meta.env.VITE_RAZORPAY_KEY_ID || "", [paymentConfig]);

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
      setError("Razorpay key is not configured.");
      return;
    }
    if (!window.Razorpay) {
      setError("Razorpay checkout failed to load.");
      return;
    }

    const paidPlan = plan.id as PaidPricingPlanName;
    setBusyPlan(paidPlan);
    setError("");
    setMessage("");
    try {
      const order = await api.createRazorpayOrder(token, {
        plan: paidPlan,
        amount: plan.amount,
        currency: "INR",
        receipt: `auto-ai-${paidPlan}-${Date.now()}`.slice(0, 40)
      });
      const checkout = new window.Razorpay({
        key: razorpayKeyId,
        amount: order.amount,
        currency: order.currency,
        name: "Auto-AI",
        description: `${plan.label} plan`,
        order_id: order.order_id,
        prefill: {
          name: user.name,
          email: user.email
        },
        theme: {
          color: "#22d3ee"
        },
        modal: {
          ondismiss: () => {
            setBusyPlan(null);
            setError("Payment cancelled.");
          }
        },
        handler: (response) => {
          void api.verifyRazorpayPayment(token, {
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature,
            plan: paidPlan,
            amount: order.amount,
            currency: order.currency
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
      });
      checkout.on("payment.failed", (response) => {
        setBusyPlan(null);
        setError(response.error?.description || response.error?.reason || "Payment failed.");
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
        <Link className="btn-primary" to={user ? "/chat" : "/login"}>
          {user ? "Open app" : "Sign in"}
          <ArrowRight size={16} />
        </Link>
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
                    <button className="btn-primary" disabled={busy} onClick={() => startCheckout(plan)} type="button">
                      {busy ? <Loader2 className="spin-icon" size={16} /> : <CreditCard size={16} />}
                      Pay {plan.price}
                    </button>
                    {paymentLink ? (
                      <a className="btn-secondary" href={paymentLink} rel="noreferrer" target="_blank">
                        <ExternalLink size={16} />
                        Payment Link
                      </a>
                    ) : (
                      <button className="btn-secondary" disabled type="button">
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
