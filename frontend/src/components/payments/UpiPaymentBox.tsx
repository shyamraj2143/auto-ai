import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AlertCircle, Check, Copy, ExternalLink, QrCode } from "lucide-react";
import { buildUpiPaymentUri, copyText } from "../../utils/upi";

type UpiPaymentBoxProps = {
  upiId?: string | null;
  payeeName?: string | null;
  amountPaise: number;
  planLabel: string;
};

export function UpiPaymentBox({ upiId, payeeName, amountPaise, planLabel }: UpiPaymentBoxProps) {
  const [copied, setCopied] = useState(false);
  const normalizedUpiId = upiId?.trim();
  const normalizedPayee = payeeName?.trim() || "Auto-AI";

  const upiUri = useMemo(() => {
    if (!normalizedUpiId) return "";
    return buildUpiPaymentUri({
      upiId: normalizedUpiId,
      payeeName: normalizedPayee,
      amountPaise,
      note: `Auto-AI ${planLabel} subscription`
    });
  }, [amountPaise, normalizedPayee, normalizedUpiId, planLabel]);

  if (!normalizedUpiId) {
    return (
      <div className="upi-payment-box upi-payment-missing">
        <div className="upi-payment-head">
          <QrCode size={15} />
          <span>UPI QR / ID</span>
        </div>
        <div className="upi-payment-missing-row">
          <AlertCircle size={16} />
          <span>UPI ID is not configured. Set UPI_ID in backend environment.</span>
        </div>
      </div>
    );
  }

  const paymentUpiId = normalizedUpiId;

  async function copyUpiId() {
    await copyText(paymentUpiId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="upi-payment-box">
      <div className="upi-payment-head">
        <QrCode size={15} />
        <span>UPI QR / ID</span>
      </div>
      <div className="upi-payment-body">
        <div className="upi-qr-frame">
          <QRCodeSVG value={upiUri} size={132} bgColor="#ffffff" fgColor="#020617" marginSize={2} />
        </div>
        <div className="upi-payment-details">
          <span>Scan QR or pay to</span>
          <strong>{paymentUpiId}</strong>
          <div className="upi-payment-actions">
            <a className="btn-secondary" href={upiUri}>
              <ExternalLink size={15} />
              Open UPI App
            </a>
            <button className="btn-secondary" onClick={copyUpiId} type="button">
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy UPI ID"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
