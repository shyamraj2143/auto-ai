export type RazorpaySuccessResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

export type RazorpayFailureResponse = {
  error?: {
    description?: string;
    reason?: string;
  };
};

export type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: {
    name?: string;
    email?: string;
    contact?: string;
  };
  theme: {
    color: string;
  };
  modal: {
    ondismiss: () => void;
  };
  handler?: (response: RazorpaySuccessResponse) => void;
};

export type RazorpayCheckout = {
  open: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayFailureResponse) => void) => void;
};

const RAZORPAY_SCRIPT_ID = "razorpay-checkout-js";
const RAZORPAY_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

export function createRazorpayCheckoutOptions({
  key,
  amount,
  currency,
  name,
  description,
  orderId,
  prefill,
  onDismiss,
  onSuccess
}: {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  orderId: string;
  prefill: RazorpayOptions["prefill"];
  onDismiss: () => void;
  onSuccess: (response: RazorpaySuccessResponse) => void;
}): RazorpayOptions {
  return {
    key,
    amount,
    currency,
    name,
    description,
    order_id: orderId,
    prefill,
    theme: { color: "#22d3ee" },
    modal: { ondismiss: onDismiss },
    handler: onSuccess
  };
}

export function openPaymentCheckoutExternal(url: string) {
  const capacitor = window.Capacitor as
    | { Plugins?: { Browser?: { open?: (options: { url: string }) => Promise<void> } } }
    | undefined;
  const browserOpen = capacitor?.Plugins?.Browser?.open;
  if (browserOpen) return browserOpen({ url });
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) window.location.assign(url);
  return Promise.resolve();
}

export function loadRazorpayCheckout() {
  return new Promise<void>((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Razorpay checkout is only available in the browser."));
      return;
    }
    if (window.Razorpay) {
      resolve();
      return;
    }

    const existing = document.getElementById(RAZORPAY_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Razorpay checkout failed to load.")), { once: true });
      if (window.Razorpay) resolve();
      return;
    }

    const script = document.createElement("script");
    script.id = RAZORPAY_SCRIPT_ID;
    script.src = RAZORPAY_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay checkout failed to load. Check internet connection and try again."));
    document.head.appendChild(script);
  });
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayCheckout;
  }
}
