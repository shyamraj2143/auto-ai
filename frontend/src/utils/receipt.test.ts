import { describe, expect, it } from "vitest";
import { isPdfBlob, receiptFilename } from "./receipt";

describe("receipt download validation", () => {
  it("accepts a real PDF signature and rejects an error blob", async () => {
    expect(await isPdfBlob(new Blob(["%PDF-1.4\nreceipt"]), "application/pdf")).toBe(true);
    expect(await isPdfBlob(new Blob(["{\"detail\":\"failed\"}"]), "application/pdf")).toBe(false);
    expect(await isPdfBlob(new Blob(["%PDF-1.4"]), "application/json")).toBe(false);
  });

  it("uses a safe server filename with a fallback", () => {
    expect(receiptFilename('attachment; filename="AutoAI-Receipt-AA-1.pdf"', "fallback.pdf")).toBe("AutoAI-Receipt-AA-1.pdf");
    expect(receiptFilename(null, "Auto AI receipt.pdf")).toBe("Auto-AI-receipt.pdf");
  });
});
