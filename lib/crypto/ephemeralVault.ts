// Request-scoped PII vault. token <-> value mapping lives only in this object's memory,
// sealed with AES-256-GCM under a key generated for this request and never exported
// (non-extractable CryptoKey). dispose() drops every reference: Zero Data Retention.
// Web Crypto only, so it runs unchanged on Deno, Node and browsers.

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Sealed { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class EphemeralVault {
  private encKey: CryptoKey | null;
  private macKey: CryptoKey | null;
  private aad: Uint8Array<ArrayBuffer>;
  private byIndex = new Map<string, string>(); // HMAC(canonical value) -> token
  private sealed = new Map<string, Sealed & { kind: string }>(); // token -> sealed value
  private counters = new Map<string, number>();

  private constructor(encKey: CryptoKey, macKey: CryptoKey, requestId: string) {
    this.encKey = encKey;
    this.macKey = macKey;
    this.aad = enc.encode(requestId);
  }

  static async create(requestId: string = crypto.randomUUID()): Promise<EphemeralVault> {
    const encKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const macKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new EphemeralVault(encKey as CryptoKey, macKey as CryptoKey, requestId);
  }

  /** Make sure new tokens of `kind` are numbered above `floor` (used when re-masking an already tokenised text). */
  reserve(kind: string, floor: number): void {
    this.counters.set(kind, Math.max(this.counters.get(kind) ?? 0, floor));
  }

  /** Same canonical value => same token within this request. */
  async tokenize(kind: string, value: string, canonical: string): Promise<string> {
    if (!this.encKey || !this.macKey) throw new Error('vault disposed');
    const idx = hex(await crypto.subtle.sign('HMAC', this.macKey, enc.encode(`${kind}|${canonical}`)));
    const existing = this.byIndex.get(idx);
    if (existing) return existing;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const token = `[${kind}_${n}]`;
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad }, this.encKey, enc.encode(value)));
    this.sealed.set(token, { iv, ct, kind });
    this.byIndex.set(idx, token);
    return token;
  }

  async reveal(token: string): Promise<string | undefined> {
    if (!this.encKey) throw new Error('vault disposed');
    const s = this.sealed.get(token);
    if (!s) return undefined;
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv, additionalData: this.aad }, this.encKey, s.ct));
  }

  get size(): number {
    return this.sealed.size;
  }

  get disposed(): boolean {
    return this.encKey === null;
  }

  dispose(): void {
    for (const s of this.sealed.values()) { s.ct.fill(0); s.iv.fill(0); }
    this.sealed.clear();
    this.byIndex.clear();
    this.counters.clear();
    this.aad.fill(0);
    this.encKey = null;
    this.macKey = null;
  }
}
