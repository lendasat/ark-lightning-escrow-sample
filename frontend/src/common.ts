const HODLHODL_URL = import.meta.env.VITE_HODLHODL_URL ?? "http://localhost:4567";
const EXPLORER_URL = import.meta.env.VITE_EXPLORER_URL ?? "";
export const LENDASWAP_URL = import.meta.env.VITE_LENDASWAP_URL ?? "http://localhost:7071";
export const ARKADE_URL = import.meta.env.VITE_ARKADE_URL ?? "http://localhost:7070";

/** Wrap text in an explorer link if VITE_EXPLORER_URL is set, otherwise return plain HTML. */
export function explorerLink(path: string, label: string): string {
  if (!EXPLORER_URL) return `<code class="mono">${label}</code>`;
  const base = EXPLORER_URL.replace(/\/+$/, "");
  return `<a href="${base}/${path}" target="_blank" class="mono explorer-link">${label}</a>`;
}

export function addressLink(addr: string): string {
  return explorerLink(`address/${addr}`, addr);
}

export async function api(
  method: string,
  path: string,
  body?: object,
): Promise<any> {
  const res = await fetch(`${HODLHODL_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(`${res.status}: ${msg}`);
  }
  return JSON.parse(text);
}

export interface Trade {
  trade_id: string;
  status: string;
  escrow_address: string;
  amount?: number;
}

export async function getTrade(id: string): Promise<Trade> {
  return api("GET", `/trades/${id}`);
}

/** Poll until trade reaches one of the target statuses. */
export async function pollStatus(
  id: string,
  targets: string[],
  onPoll?: (trade: Trade) => void,
): Promise<Trade> {
  while (true) {
    const trade = await getTrade(id);
    onPoll?.(trade);
    if (targets.includes(trade.status)) return trade;
    await sleep(2000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Derive the x-only public key from a secret key hex string. */
async function pubkeyFromSk(skHex: string): Promise<string> {
  const { SingleKey } = await import("@arkade-os/sdk");
  const { hex } = await import("@scure/base");
  const key = SingleKey.fromHex(skHex);
  const pk = await key.xOnlyPublicKey();
  return hex.encode(pk);
}

/**
 * Get or create a secp256k1 keypair, persisted in localStorage under `role`.
 * Returns the same keypair on subsequent calls / page reloads.
 */
export async function getOrCreateKeypair(
  role: string,
): Promise<{ sk: string; pk: string }> {
  const storageKey = `escrow_sk_${role}`;
  const existing = localStorage.getItem(storageKey);

  if (existing) {
    const pk = await pubkeyFromSk(existing);
    return { sk: existing, pk };
  }

  const { hex } = await import("@scure/base");
  const skBytes = crypto.getRandomValues(new Uint8Array(32));
  const skHex = hex.encode(skBytes);
  localStorage.setItem(storageKey, skHex);
  const pk = await pubkeyFromSk(skHex);
  return { sk: skHex, pk };
}

export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function setStep(n: number, total: number) {
  for (let i = 1; i <= total; i++) {
    const el = $(`step-${i}`);
    el.classList.remove("active", "done");
    if (i < n) el.classList.add("done");
    if (i === n) el.classList.add("active");
  }
}

export function show(id: string, html: string) {
  $(id).innerHTML = html;
}
