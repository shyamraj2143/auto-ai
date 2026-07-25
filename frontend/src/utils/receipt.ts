export function receiptFilename(contentDisposition: string | null, fallback: string) {
  const candidate = contentDisposition?.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
  const filename = candidate || fallback;
  return filename.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160) || "AutoAI-Receipt.pdf";
}

export async function isPdfBlob(blob: Blob, contentType: string | null) {
  if (!contentType?.toLowerCase().includes("application/pdf") || blob.size < 4) return false;
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return String.fromCharCode(...signature) === "%PDF";
}

export async function downloadAuthenticatedReceipt(options: {
  url: string;
  token: string;
  fallbackFilename: string;
  share?: boolean;
}) {
  const response = await fetch(options.url, { headers: { Authorization: `Bearer ${options.token}` } });
  if (!response.ok) throw new Error("Unable to download receipt.");
  const blob = await response.blob();
  if (!(await isPdfBlob(blob, response.headers.get("content-type")))) {
    throw new Error("The receipt response was not a valid PDF.");
  }
  const filename = receiptFilename(response.headers.get("content-disposition"), options.fallbackFilename);
  const file = new File([blob], filename, { type: "application/pdf" });
  if (options.share && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    await navigator.share({ title: "Auto-AI Payment Receipt", files: [file] });
    return "shared" as const;
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return "downloaded" as const;
}
