import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import type { BillingPlan, PaidPricingPlanName, PaymentConfig } from "../../types";
import { createRazorpayCheckoutOptions, loadRazorpayCheckout } from "../../utils/razorpay";
import { isMobileAppRuntime } from "../../utils/runtime";
import { normalizeUpiId } from "../../utils/upi";
import { LogoIcon } from "../brand/LogoIcon";
import { ThemeToggleButton } from "../layout/ThemeToggleButton";
import { UpiPaymentBox } from "../payments/UpiPaymentBox";
import { usePublishedPage } from "../../hooks/useCmsContent";
import { PublishedContentBlocks } from "../common/PublishedContentBlocks";
import { PublicFooter } from "../common/PublicFooter";

const paymentInstruction = "After payment, send your registered email and payment screenshot to admin.";

function money(amountPaise: number, currency = "INR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountPaise / 100);
}

export function PricingPage() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [busyPlan, setBusyPlan] = useState<PaidPricingPlanName | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mobileApp = isMobileAppRuntime();
  const cmsPage = usePublishedPage("pricing");

  const razorpayKeyId = paymentConfig?.key_id || "";
  const razorpayReady = paymentConfig?.razorpay_ready ?? false;
  const upiId = normalizeUpiId(paymentConfig?.upi_id || import.meta.env.VITE_UPI_ID || "");
  const upiPayeeName = paymentConfig?.upi_payee_name || import.meta.env.VITE_UPI_PAYEE_NAME || "Auto-AI";

  useEffect(() => {
    let active = true;
    Promise.all([api.paymentConfig(), api.paymentPlans()])
      .then(([config, nextPlans]) => {
        if (!active) return;
        setPaymentConfig(config);
        setPlans(nextPlans);
      })
      .catch(() => {
        if (!active) return;
        setPaymentConfig(null);
        setPlans([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function startCheckout(plan: BillingPlan) {
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
        amount: plan.price_paise,
        currency: plan.currency,
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
          void api.cancelPaymentSession(token, session.session_id).catch(() => undefined);
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
        void api.cancelPaymentSession(token, session.session_id).catch(() => undefined);
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
          <Link className="btn-primary" to={user ? "/hub" : "/login"}>
            {user ? "Open app" : "Sign in"}
            <ArrowRight size={16} />
          </Link>
          <ThemeToggleButton />
        </div>
      </header>

      <main className="landing-section pricing-main">
        <div className="section-heading">
          <p className="hero-kicker"><CreditCard size={14} /> Subscription</p>
          <h1>{cmsPage?.hero_heading || "Auto-AI Pricing"}</h1>
          <p className="pricing-subtitle">{cmsPage?.hero_description || paymentInstruction}</p>
        </div>

        <PublishedContentBlocks blocks={cmsPage?.blocks?.filter((block) => block.block_type !== "pricing_description")} />

        {(message || error) && (
          <div className={message ? "payment-alert payment-alert-success" : "payment-alert payment-alert-error"}>
            {message || error}
          </div>
        )}

        <div className="pricing-grid pricing-grid-four">
          {plans.map((plan) => {
            const paidPlan = plan.id !== "free" ? plan.id as PaidPricingPlanName : null;
            const paymentLink = paidPlan ? paymentConfig?.payment_links[paidPlan] : null;
            const busy = busyPlan === plan.id;
            return (
              <article key={plan.id} className={plan.id === "premium" ? "pricing-card pricing-card-featured" : "pricing-card"}>
                <h3>{plan.label}</h3>
                <strong className="pricing-price">{money(plan.price_paise, plan.currency)}</strong>
                <span>{plan.token_quota.toLocaleString()} tokens/month</span>
                <ul className="pricing-list">
                  {plan.features.map((item) => (
                    <li key={item}><Check size={14} /> {item}</li>
                  ))}
                </ul>
                {plan.id === "free" ? (
                  <Link className="btn-secondary" to={user ? "/hub" : "/register"}>Start free</Link>
                ) : (
                  <div className="pricing-actions">
                    {upiId && <UpiPaymentBox upiId={upiId} payeeName={upiPayeeName} amountPaise={plan.price_paise} planLabel={plan.label} />}
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
      <PublicFooter />
    </div>
  );
}
