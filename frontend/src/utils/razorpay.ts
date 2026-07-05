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
  handler: (response: RazorpaySuccessResponse) => void;
};

export type RazorpayCheckout = {
  open: () => void;
  on: (event: "payment.failed", handler: (response: RazorpayFailureResponse) => void) => void;
};

export const RAZORPAY_UPI_FIRST_OPTIONS = {
  method: {
    upi: true,
    card: true,
    netbanking: true,
    wallet: true,
    emi: true,
    paylater: true
  }
} satisfies Pick<RazorpayOptions, "method">;

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayCheckout;
  }
}
