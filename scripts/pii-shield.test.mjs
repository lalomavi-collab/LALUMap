#!/usr/bin/env node
// Unit tests for public/pii-shield.js, run against the exact file that
// ships (loaded into a vm context with Node's WebCrypto). Pure Node, no
// dependencies, same as check.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "..", "public", "pii-shield.js"), "utf8");
const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const PII = sandbox.LalumPII;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}

const ALL_ON = { ...PII.DEFAULT_SETTINGS, maskAmounts: true };

await test("Israeli ID check digit", () => {
  assert.equal(PII.isValidIsraeliId("123456782"), true);
  assert.equal(PII.isValidIsraeliId("123456789"), false);
  assert.equal(PII.isValidIsraeliId("000000018"), true);
});

await test("labelled ID, phone, email are masked and round-trip", async () => {
  const v = PII.createVault();
  const text = 'הלקוח, ת"ז 012345674, טלפון 052-249-0420, מייל client@example.co.il';
  const { masked, entities, count } = await PII.mask(text, v, ALL_ON);
  assert.ok(!masked.includes("012345674"), masked);
  assert.ok(!masked.includes("052-249-0420"), masked);
  assert.ok(!masked.includes("client@example.co.il"), masked);
  assert.ok(masked.includes('ת"ז [ID_NUMBER_1]'), masked);
  assert.ok(masked.includes("[PHONE_1]"), masked);
  assert.ok(masked.includes("[EMAIL_1]"), masked);
  assert.equal(count, 3);
  assert.equal(entities.length, 3);
  assert.equal(await PII.unmask(masked, v), text);
});

await test("unlabelled 9 digits only with valid check digit; 5xx is a company", async () => {
  const v = PII.createVault();
  const { masked } = await PII.mask("מספרים 123456782 ו-123456789 ו-515555555", v, ALL_ON);
  assert.ok(masked.includes("[ID_NUMBER_1]"), masked);
  assert.ok(masked.includes("123456789"), "invalid check digit must stay: " + masked);
  assert.ok(masked.includes("[COMPANY_NUMBER_1]"), masked);
});

await test("company number by label, company name by בע״מ", async () => {
  const v = PII.createVault();
  const text = 'חברת אלפא נכסים בע"מ, ח.פ. 514567890';
  const { masked } = await PII.mask(text, v, ALL_ON);
  assert.ok(masked.includes("[COMPANY_NUMBER_1]"), masked);
  assert.ok(masked.includes("[COMPANY_NAME_1]"), masked);
  assert.ok(!masked.includes("514567890"), masked);
  assert.ok(!masked.includes("אלפא"), masked);
  assert.equal(await PII.unmask(masked, v), text);
});

await test("land registry keeps the word, masks the number", async () => {
  const v = PII.createVault();
  const text = "גוש 6543 חלקה 12 תת-חלקה 3";
  const { masked } = await PII.mask(text, v, ALL_ON);
  assert.equal(masked, "גוש [LAND_BLOCK_1] חלקה [LAND_PARCEL_1] תת-חלקה [LAND_SUBPARCEL_1]");
  assert.equal(await PII.unmask(masked, v), text);
});

await test("names from the matter list, with Hebrew prefix letters kept", async () => {
  const v = PII.createVault();
  const s = { ...ALL_ON, clientNames: ["דוד כהן"], partyNames: ["שרה לוי"] };
  const text = "דוד כהן תבע את שרה לוי, ולדוד כהן יש הסכם עם שרה לוי.";
  const { masked } = await PII.mask(text, v, s);
  assert.equal(masked, "[CLIENT_NAME_1] תבע את [ADVERSE_PARTY_1], ול[CLIENT_NAME_1] יש הסכם עם [ADVERSE_PARTY_1].");
  assert.equal(await PII.unmask(masked, v), text);
});

await test("titled names (Hebrew and English)", async () => {
  const v = PII.createVault();
  const { masked } = await PII.mask('נפגשנו עם עו"ד משה ישראלי ועם Mr. John Smith', v, ALL_ON);
  assert.ok(masked.includes('עו"ד [PERSON_NAME_1]'), masked);
  assert.ok(masked.includes("Mr. [PERSON_NAME_2]"), masked);
});

await test("amounts only when enabled", async () => {
  const v = PII.createVault();
  const off = await PII.mask("שכ\"ט ₪ 250,000 ועוד 1,200 ש\"ח", v, PII.DEFAULT_SETTINGS);
  assert.equal(off.count, 0);
  const on = await PII.mask("שכ\"ט ₪ 250,000 ועוד 1,200 ש\"ח", v, ALL_ON);
  assert.equal(on.count, 2, on.masked);
});

await test("same value gets the same token across turns", async () => {
  const v = PII.createVault();
  const a = await PII.mask("טלפון 0522490420", v, ALL_ON);
  const b = await PII.mask("שוב: 052-249-0420", v, ALL_ON);
  assert.ok(a.masked.includes("[PHONE_1]") && b.masked.includes("[PHONE_1]"), a.masked + " | " + b.masked);
});

await test("disabled shield passes text through unchanged", async () => {
  const v = PII.createVault();
  const r = await PII.mask("ת.ז. 123456782", v, { ...ALL_ON, enabled: false });
  assert.equal(r.masked, "ת.ז. 123456782");
  assert.equal(r.count, 0);
});

await test("unmask tolerates spacing inside tokens and ignores unknown ones", async () => {
  const v = PII.createVault();
  const { masked } = await PII.mask("ת.ז. 123456782", v, ALL_ON);
  assert.equal(masked, "ת.ז. [ID_NUMBER_1]");
  assert.equal(await PII.unmask("עבור [ ID_NUMBER_1 ] ו-[EMAIL_9]", v), "עבור 123456782 ו-[EMAIL_9]");
});

await test("purge makes the vault unreadable", async () => {
  const v = PII.createVault();
  const { masked } = await PII.mask("ת.ז. 123456782", v, ALL_ON);
  v.purge();
  assert.equal(await PII.unmask(masked, v), masked);
  assert.equal(v.size, 0);
});

await test("settings: names in session storage, rules in local storage", () => {
  const mk = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, x) => m.set(k, x), _m: m }; };
  const local = mk();
  const session = mk();
  PII.saveSettings({ ...PII.DEFAULT_SETTINGS, maskAmounts: true, clientNames: ["דוד כהן"] }, local, session);
  assert.ok(![...local._m.values()].some((x) => x.includes("דוד")), "names must not hit localStorage");
  const back = PII.loadSettings(local, session);
  assert.equal(back.maskAmounts, true);
  assert.deepEqual([...back.clientNames], ["דוד כהן"]);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll PII Shield tests passed.");
