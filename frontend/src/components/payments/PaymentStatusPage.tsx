import { Link, useLocation } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";

export function PaymentStatusPage({ status }: { status: "success" | "failed" }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const paymentId = params.get("payment_id");
  const success = status === "success";
  const Icon = success ? CheckCircle2 : XCircle;

  return (
    <div className="landing-page pricing-page">
      <main className="landing-section pricing-main">
        <div className="section-heading">
          <p className="hero-kicker">
            <Icon size={14} />
            Payment
          </p>
          <h1>{success ? "Payment Successful" : "Payment Failed"}</h1>
          <p className="pricing-subtitle">
            {success
              ? "Your subscription is being updated. Return to billing to refresh your plan."
              : "The payment was cancelled or could not be verified. Try again from billing."}
          </p>
        </div>
        <div className={success ? "payment-alert payment-alert-success" : "payment-alert payment-alert-error"}>
          {success ? "Razorpay payment verified." : "Razorpay payment was not completed."}
          {paymentId ? ` Payment ID: ${paymentId}` : ""}
        </div>
        <div className="pricing-actions">
          <Link className="btn-primary" to="/settings">
            Open Billing
          </Link>
          <Link className="btn-secondary" to="/chat">
            Open Chat
          </Link>
        </div>
      </main>
    </div>
  );
}
