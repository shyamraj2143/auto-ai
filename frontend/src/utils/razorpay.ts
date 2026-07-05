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

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayCheckout;
  }
}
