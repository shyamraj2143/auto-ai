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

type RazorpayInstrument = {
  method: "upi" | "card" | "netbanking" | "wallet" | "emi" | "paylater";
  flows?: Array<"intent" | "qr" | "collect">;
};

export type RazorpayOptions = {
  key: string;
  checkout_config_id?: string;
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
  method: {
    upi: boolean;
    card: boolean;
    netbanking: boolean;
    wallet: boolean;
    emi: boolean;
    paylater: boolean;
  };
  config?: {
    display: {
      blocks: Record<string, { name: string; instruments: RazorpayInstrument[] }>;
      sequence: string[];
      preferences: {
        show_default_blocks: boolean;
      };
    };
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
export const DEFAULT_RAZORPAY_CHECKOUT_CONFIG_ID = "config_T9ulbVgLBfz7ko";

export const RAZORPAY_UPI_FIRST_OPTIONS = {
  method: {
    upi: true,
    card: true,
    netbanking: true,
    wallet: true,
    emi: true,
    paylater: true
  },
  config: {
    display: {
      blocks: {
        upi_qr: {
          name: "Pay via UPI / QR",
          instruments: [
            {
              method: "upi",
              flows: ["qr", "intent", "collect"]
            }
          ]
        },
        other_methods: {
          name: "Cards, Netbanking & Wallets",
          instruments: [
            {
              method: "card"
            },
            {
              method: "netbanking"
            },
            {
              method: "wallet"
            },
            {
              method: "paylater"
            }
          ]
        }
      },
      sequence: ["block.upi_qr", "block.other_methods"],
      preferences: {
        show_default_blocks: false
      }
    }
  }
} satisfies Pick<RazorpayOptions, "method" | "config">;

export function normalizeRazorpayConfigId(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const candidate = value?.trim();
    if (candidate?.startsWith("config_")) return candidate;
  }
  return "";
}

export function resolveRazorpayCheckoutConfigId(config?: { razorpay_config_id?: string | null; upi_id?: string | null } | null) {
  return normalizeRazorpayConfigId(
    config?.razorpay_config_id,
    import.meta.env.VITE_RAZORPAY_CHECKOUT_CONFIG_ID,
    import.meta.env.VITE_RAZORPAY_PAYMENT_CONFIG_ID,
    import.meta.env.VITE_RAZORPAY_CONFIG_ID,
    config?.upi_id,
    import.meta.env.VITE_UPI_ID,
    DEFAULT_RAZORPAY_CHECKOUT_CONFIG_ID
  );
}

export function razorpayAllPaymentOptions(configId?: string | null): Pick<RazorpayOptions, "method" | "config" | "checkout_config_id"> {
  const normalizedConfigId = normalizeRazorpayConfigId(configId);
  if (normalizedConfigId?.startsWith("config_")) {
    return {
      method: RAZORPAY_UPI_FIRST_OPTIONS.method,
      checkout_config_id: normalizedConfigId
    };
  }
  return {
    ...RAZORPAY_UPI_FIRST_OPTIONS
  };
}

export function createRazorpayCheckoutOptions({
  key,
  amount,
  currency,
  name,
  description,
  orderId,
  prefill,
  configId,
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
  configId?: string | null;
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
    ...razorpayAllPaymentOptions(configId),
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
