const HODLHODL_URL = "http://localhost:4567";

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

/** Generate a random secp256k1 keypair. Returns {sk, pk} as hex strings. */
export async function generateKeypair(): Promise<{ sk: string; pk: string }> {
  // Lazy-import to avoid pulling SDK into alice.ts bundle unnecessarily
  const { SingleKey } = await import("@arkade-os/sdk");
  const { hex } = await import("@scure/base");
  const skBytes = crypto.getRandomValues(new Uint8Array(32));
  const skHex = hex.encode(skBytes);
  const key = SingleKey.fromHex(skHex);
  const pk = await key.xOnlyPublicKey();
  return { sk: skHex, pk: hex.encode(pk) };
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
