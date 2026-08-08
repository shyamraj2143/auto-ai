import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CreditCard,
  Download,
  Headphones,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Tag,
  Wallet
} from "lucide-react";
import { API_BASE_URL, api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { AppSelect } from "../common/AppSelect";
import type { BillingCenter, BillingPlan, PaidPricingPlanName, PaymentConfig, PaymentHistoryItem, PaymentHistoryPage, PromoCodeResponse } from "../../types";
import { createRazorpayCheckoutOptions, loadRazorpayCheckout } from "../../utils/razorpay";
import { normalizeUpiId } from "../../utils/upi";
import { UpiPaymentBox } from "../payments/UpiPaymentBox";
import { CrystalBadge, CrystalLoader, CrystalSurface } from "../crystal/Crystal";
import { downloadAuthenticatedReceipt } from "../../utils/receipt";

const paidPlans = new Set(["pro", "premium", "ultra"]);

function money(amountPaise: number, currency = "INR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountPaise / 100);
}

function formatDate(value?: string | null) {
  if (!value) return "No date";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value));
}

function numberText(value: number) {
  return value === 0 ? "Unlimited" : value.toLocaleString();
}

function planAmount(plan: BillingPlan, promo?: PromoCodeResponse | null) {
  return promo?.plan === plan.id ? promo.discounted_amount_paise : plan.price_paise;
}

export function SubscriptionBillingCenter() {
  const { token, user } = useAuth();
  const [billing, setBilling] = useState<BillingCenter | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [promoPlan, setPromoPlan] = useState<PaidPricingPlanName>("pro");
  const [promo, setPromo] = useState<PromoCodeResponse | null>(null);
  const [history, setHistory] = useState<PaymentHistoryPage>({ items: [], page: 1, page_size: 20, total: 0, total_pages: 1 });
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyQueryDraft, setHistoryQueryDraft] = useState("");
  const [historyStatus, setHistoryStatus] = useState<"all" | "success" | "failed">("all");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [paymentConfig, setPaymentConfig] = useState<PaymentConfig | null>(null);
  const razorpayKeyId = paymentConfig?.key_id || "";
  const razorpayReady = paymentConfig?.razorpay_ready ?? false;
  const stripeReady = paymentConfig?.stripe_ready ?? false;
  const upiId = normalizeUpiId(paymentConfig?.upi_id || import.meta.env.VITE_UPI_ID || "");
  const upiPayeeName = paymentConfig?.upi_payee_name || import.meta.env.VITE_UPI_PAYEE_NAME || "Auto-AI";

  const current = billing?.current_plan;
  const currentCatalogPlan = current && billing?.plans.find((plan) => plan.id === current.plan);
  const currentMonthlyLimit = currentCatalogPlan?.token_quota ?? current?.token_limit_monthly ?? 0;
  const currentDailyLimit = currentCatalogPlan?.daily_message_limit ?? current?.daily_message_limit ?? 0;
  const currentTokenBalance = currentMonthlyLimit > 0 && current
    ? Math.max(0, currentMonthlyLimit - current.tokens_used_monthly)
    : current?.token_balance ?? 0;
  const paidPlanOptions = useMemo(
    () => (billing?.plans.filter((plan) => paidPlans.has(plan.id)) ?? []) as Array<BillingPlan & { id: PaidPricingPlanName }>,
    [billing]
  );

  async function loadBilling() {
    if (!token) return;
    setBusy((currentBusy) => currentBusy || "load");
    try {
      setBilling(await api.billingCenter(token));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load subscription.");
    } finally {
      setBusy((currentBusy) => (currentBusy === "load" ? "" : currentBusy));
    }
  }

  async function loadPaymentHistory(options: { query?: string; status?: "all" | "success" | "failed"; page?: number } = {}) {
    if (!token) return;
    const nextQuery = options.query ?? historyQuery;
    const nextStatus = options.status ?? historyStatus;
    const nextPage = options.page ?? history.page;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await api.paymentHistory(token, { query: nextQuery, status: nextStatus, page: nextPage, pageSize: 20 });
      setHistory(result);
      setHistoryQuery(nextQuery);
      setHistoryStatus(nextStatus);
    } catch {
      setHistoryError("Unable to load payment history. Please retry.");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    void loadBilling();
    void loadPaymentHistory({ query: "", status: "all", page: 1 });
  }, [token]);

  useEffect(() => {
    const refreshOnResume = () => {
      if (!document.hidden) {
        void loadBilling();
        void loadPaymentHistory();
      }
    };
    window.addEventListener("focus", refreshOnResume);
    document.addEventListener("visibilitychange", refreshOnResume);
    return () => {
      window.removeEventListener("focus", refreshOnResume);
      document.removeEventListener("visibilitychange", refreshOnResume);
    };
  }, [token]);

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

  async function upgrade(plan: BillingPlan) {
    if (!token || !user || !paidPlans.has(plan.id)) return;
    if (!razorpayReady && !stripeReady) {
      setError("Online payments are not configured. Contact support or use an available payment option.");
      return;
    }
    const paidPlan = plan.id as PaidPricingPlanName;
    setBusy(`pay-${plan.id}`);
    setError("");
    setSuccess("");
    try {
      if (!razorpayReady && stripeReady) {
        const stripeSession = await api.createStripeCheckoutSession(token, { plan_id: paidPlan, currency: "INR", receipt: `auto-ai-${paidPlan}-${Date.now()}`.slice(0, 40), promo_code: promo?.plan === paidPlan ? promo.code : null });
        window.location.assign(stripeSession.checkout_url);
        return;
      }
      if (!razorpayKeyId) throw new Error("Razorpay public key is missing from the backend configuration.");
      const session = await api.createPaymentSession(token, {
        plan_id: paidPlan,
        currency: "INR",
        receipt: `auto-ai-${paidPlan}-${Date.now()}`.slice(0, 40),
        promo_code: promo?.plan === paidPlan ? promo.code : null
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
        prefill: { name: user.name, email: user.email, contact: user.mobile || "" },
        onDismiss: () => {
          void api.cancelPaymentSession(token, session.session_id).catch(() => undefined);
          setBusy("");
          setError("Payment cancelled.");
        },
        onSuccess: (response) => {
          void api.verifyRazorpayPayment(token, {
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature
          })
            .then((result) => {
              setSuccess(result.message);
              setPromo(null);
              setPromoCode("");
              void loadBilling();
              void loadPaymentHistory({ page: 1 });
            })
            .catch((err) => setError(err instanceof Error ? err.message : "Payment verification failed."))
            .finally(() => setBusy(""));
        }
      }));
      checkout.on("payment.failed", (response) => {
        void api.cancelPaymentSession(token, session.session_id).catch(() => undefined);
        setBusy("");
        const description = response.error?.description || response.error?.reason || "Payment failed.";
        setError(description.toLowerCase().includes("api key") && description.toLowerCase().includes("expired")
          ? "Razorpay API key has expired. Update the Razorpay env keys and rebuild the app."
          : description);
      });
      checkout.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start payment.");
      setBusy("");
    }
  }

  async function applyPromo() {
    if (!token || !promoCode.trim()) return;
    setBusy("promo");
    setError("");
    setSuccess("");
    try {
      const result = await api.applyPromoCode(token, { code: promoCode, plan: promoPlan });
      setPromo(result);
      setSuccess(`${result.code} applied successfully.`);
    } catch (err) {
      setPromo(null);
      setError(err instanceof Error ? err.message : "Invalid promo code.");
    } finally {
      setBusy("");
    }
  }

  async function updateAutoRenewal(next: boolean) {
    if (!token) return;
    setBusy("renewal");
    setError("");
    try {
      const currentPlan = await api.updateAutoRenewal(token, next);
      setBilling((existing) => (existing ? { ...existing, current_plan: currentPlan } : existing));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update renewal.");
    } finally {
      setBusy("");
    }
  }

  async function restorePurchase() {
    if (!token) return;
    setBusy("restore");
    setError("");
    setSuccess("");
    try {
      const result = await api.restorePurchase(token);
      setSuccess(result.message);
      await loadBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore purchase.");
    } finally {
      setBusy("");
    }
  }

  async function downloadReceipt(payment: PaymentHistoryItem, share = false) {
    if (!token || !payment.receipt_url) return;
    setBusy(`receipt-${payment.id}`);
    setError("");
    try {
      const apiOrigin = API_BASE_URL.replace(/\/api\/v1\/?$/, "");
      await downloadAuthenticatedReceipt({
        url: `${apiOrigin}${payment.receipt_url}`,
        token,
        fallbackFilename: `AutoAI-Receipt-${payment.receipt_number || payment.id}.pdf`,
        share
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to download receipt.");
    } finally {
      setBusy("");
    }
  }

  if (!billing || !current) {
    return (
      <section className="settings-billing-center">
        <div className="billing-loading"><CrystalLoader label="Loading subscription" /> Loading subscription</div>
      </section>
    );
  }

  const progress = currentMonthlyLimit > 0
    ? Math.min(100, Math.round((current.tokens_used_monthly / currentMonthlyLimit) * 100))
    : 0;
  const supportHref = `mailto:${billing.support_email || "support@autoai.site.je"}?subject=Auto-AI%20Subscription%20Support`;

  return (
    <section className="settings-billing-center">
      <div className="billing-section-head">
        <div>
          <p className="settings-eyebrow"><CreditCard size={14} /> Subscription</p>
          <h2>Subscription & Billing</h2>
        </div>
        <button className="chip-dark" onClick={loadBilling} type="button" disabled={busy === "load"}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      {(error || success) && <div className={success ? "billing-alert billing-alert-success" : "billing-alert billing-alert-error"}>{success || error}</div>}

      <div className="billing-summary-grid">
        <CrystalSurface className="billing-current-card">
          <div className="billing-plan-line">
            <div>
              <span>Current Plan</span>
              <strong>{current.plan_name}</strong>
            </div>
            <CrystalBadge tone={current.plan === "free" ? "default" : "premium"}>{current.status}</CrystalBadge>
          </div>
          <div className="billing-block-title">Token Usage</div>
          <div className="billing-token-bar">
            <div style={{ width: `${progress}%` }} />
          </div>
          <div className="billing-metrics">
            <span>Monthly Token Limit<strong>{numberText(currentMonthlyLimit)}</strong></span>
            <span>Used Tokens<strong>{current.tokens_used_monthly.toLocaleString()}</strong></span>
            <span>Remaining Tokens<strong>{numberText(currentTokenBalance)}</strong></span>
            <span>Daily Message Limit<strong>{numberText(currentDailyLimit)}</strong></span>
            <span>Upload Limit<strong>{current.upload_limit_mb} MB</strong></span>
            <span>Expiry Date<strong>{current.is_lifetime ? "Lifetime" : formatDate(current.expires_at)}</strong></span>
            <span>Renewal Date<strong>{formatDate(current.renewal_at)}</strong></span>
            <span>Plan Status<strong>{current.status}</strong></span>
          </div>
        </CrystalSurface>
        <div className="billing-side-card">
          <div className="billing-side-title"><Sparkles size={16} /> Enabled AI Models</div>
          <div className="billing-chip-list">
            {current.enabled_ai_models.map((model) => <span key={model}>{model}</span>)}
          </div>
          <div className="billing-renewal-row">
            <span>Auto Renewal</span>
            <button
              className={current.auto_renewal ? "billing-toggle billing-toggle-on" : "billing-toggle"}
              onClick={() => updateAutoRenewal(!current.auto_renewal)}
              type="button"
              disabled={busy === "renewal"}
              aria-pressed={current.auto_renewal}
            >
              <span />
            </button>
          </div>
        </div>
      </div>

      <div className="billing-block-title billing-plans-title">Available Plans</div>
      <div className="billing-plan-grid">
        {billing.plans.map((plan) => {
          const isCurrent = current.plan === plan.id;
          const amount = planAmount(plan, promo);
          return (
            <article key={plan.id} className={isCurrent ? "billing-plan-card billing-plan-active" : "billing-plan-card"}>
              <div className="billing-plan-top">
                <h3>{plan.label}</h3>
                <strong>{money(amount, plan.currency)}</strong>
              </div>
              <div className="billing-plan-meta">
                <span>{plan.token_quota.toLocaleString()} tokens/month</span>
                <span>{plan.upload_limit_mb} MB uploads</span>
                <span>{plan.priority_speed} speed</span>
              </div>
              <div className="billing-chip-list">
                {plan.model_access.map((model) => <span key={model}>{model}</span>)}
              </div>
              <ul className="billing-feature-list">
                {plan.features.map((feature) => <li key={feature}><Check size={14} /> {feature}</li>)}
              </ul>
              <div className="billing-payment-actions">
                {!isCurrent && plan.id !== "free" && upiId && (
                  <UpiPaymentBox upiId={upiId} payeeName={upiPayeeName} amountPaise={amount} planLabel={plan.label} />
                )}
                <button
                  className={isCurrent ? "btn-secondary" : "btn-primary"}
                  onClick={() => upgrade(plan)}
                  disabled={isCurrent || plan.id === "free" || busy === `pay-${plan.id}`}
                  type="button"
                >
                  {busy === `pay-${plan.id}` ? <Loader2 className="spin-icon" size={16} /> : <Wallet size={16} />}
                  {isCurrent ? "Current" : plan.id === "free" ? "Free" : "UPI QR / Cards / Wallet"}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className="billing-tools-grid">
        <div className="billing-tool-card">
          <div className="billing-side-title"><Tag size={16} /> Promo Code</div>
          <div className="billing-promo-row">
            <input className="input-dark h-10 uppercase" value={promoCode} onChange={(event) => setPromoCode(event.target.value.toUpperCase())} placeholder="Code" maxLength={40} />
            <AppSelect label="Promo plan" value={promoPlan} onChange={(value) => setPromoPlan(value as PaidPricingPlanName)} options={paidPlanOptions.map((plan) => ({ value: plan.id, label: plan.label }))} />
            <button className="btn-secondary h-10" onClick={applyPromo} disabled={busy === "promo"} type="button">Apply</button>
          </div>
          {promo && (
            <div className="billing-promo-summary">
              <span>Plan subtotal<strong>{money(promo.original_amount_paise)}</strong></span>
              <span>Promo code<strong>{promo.code}</strong></span>
              <span>Discount<strong>-{money(promo.discount_amount_paise)}</strong></span>
              <span>Payable total<strong>{money(promo.discounted_amount_paise)}</strong></span>
              {promo.expires_at && <small>Valid until {formatDate(promo.expires_at)}</small>}
              <button className="chip-dark" onClick={() => { setPromo(null); setPromoCode(""); setSuccess(""); }} type="button">Remove promo</button>
            </div>
          )}
        </div>
        <div className="billing-tool-card billing-actions-card">
          <button className="btn-secondary" onClick={restorePurchase} disabled={busy === "restore"} type="button">
            <RotateCcw size={16} />
            Restore Purchase
          </button>
          <a className="btn-secondary" href={supportHref}>
            <Headphones size={16} />
            Contact Support
          </a>
        </div>
      </div>

      <div className="billing-history-card">
        <div className="billing-section-head billing-section-head-compact">
          <div className="billing-side-title"><ShieldCheck size={16} /> Payment History</div>
          <form className="billing-history-toolbar" onSubmit={(event) => { event.preventDefault(); void loadPaymentHistory({ query: historyQueryDraft, page: 1 }); }}>
            <label>
              <Search size={15} />
              <input value={historyQueryDraft} onChange={(event) => setHistoryQueryDraft(event.target.value)} placeholder="Receipt, payment, plan, amount or date" aria-label="Search payment history" />
            </label>
            <AppSelect label="Payment status" value={historyStatus} onChange={(value) => void loadPaymentHistory({ status: value as "all" | "success" | "failed", page: 1 })} options={[{value:"all",label:"All"},{value:"success",label:"Success"},{value:"failed",label:"Failed"}]} />
            <button className="chip-dark" disabled={historyLoading} type="submit">Search</button>
            {(historyQuery || historyStatus !== "all") && (
              <button className="chip-dark" onClick={() => { setHistoryQueryDraft(""); void loadPaymentHistory({ query: "", status: "all", page: 1 }); }} type="button">Clear</button>
            )}
          </form>
        </div>
        {historyError && <div className="billing-history-error">{historyError} <button onClick={() => void loadPaymentHistory()} type="button">Retry</button></div>}
        <div className="billing-history-table">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Receipt ID</th>
                <th>Amount</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((payment) => (
                <tr key={payment.id}>
                  <td data-label="Date">{formatDate(payment.date)}</td>
                  <td data-label="Receipt ID">{payment.receipt_number || payment.payment_id || payment.id}</td>
                  <td data-label="Amount">{money(payment.amount_paise, payment.currency)}</td>
                  <td data-label="Plan">{payment.plan}</td>
                  <td data-label="Status"><span className={`billing-payment-status billing-payment-status-${payment.status}`}>{payment.status}</span></td>
                  <td data-label="Action">
                    {payment.receipt_url && (
                      <div className="billing-receipt-actions">
                        <button className="chip-dark" onClick={() => downloadReceipt(payment)} disabled={busy === `receipt-${payment.id}`} type="button">
                          <Download size={14} /> Download receipt
                        </button>
                        {typeof navigator.share === "function" && (
                          <button className="chip-dark" onClick={() => downloadReceipt(payment, true)} disabled={busy === `receipt-${payment.id}`} type="button">
                            <Share2 size={14} /> Share
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {!historyLoading && history.items.length === 0 && (
                <tr><td data-label="Payment History" colSpan={6}>{historyQuery || historyStatus !== "all" ? "No matching payments." : "No payments yet."}</td></tr>
              )}
              {historyLoading && <tr><td data-label="Payment History" colSpan={6}><Loader2 className="spin-icon inline" size={15} /> Loading payments...</td></tr>}
            </tbody>
          </table>
        </div>
        {history.total_pages > 1 && (
          <div className="billing-history-pagination">
            <button className="chip-dark" disabled={historyLoading || history.page <= 1} onClick={() => void loadPaymentHistory({ page: history.page - 1 })} type="button">Previous</button>
            <span>Page {history.page} of {history.total_pages} · {history.total} payments</span>
            <button className="chip-dark" disabled={historyLoading || history.page >= history.total_pages} onClick={() => void loadPaymentHistory({ page: history.page + 1 })} type="button">Next</button>
          </div>
        )}
      </div>
    </section>
  );
}
