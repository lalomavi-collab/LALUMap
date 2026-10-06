// LALUM PII Shield: detection, masking and unmasking engine.
//
// Runs entirely in the browser, before any text leaves the device for the
// lalum-assistant Edge Function (and from there the LLM). The plain text
// never reaches Supabase or the model provider; only semantic tokens such
// as [CLIENT_NAME_1] or [ID_NUMBER_1] do. Replies are unmasked here, on the
// device, from the same in-memory vault.
//
// No DOM access in this file on purpose, so the same code is unit-tested
// under Node (scripts/pii-shield.test.mjs) exactly as it ships.
//
// Detection is deterministic (regex + context words + the Israeli ID check
// digit). There is no statistical NER: a Hebrew NER model is far too heavy
// to ship to a phone. Names are covered by (a) the client / adverse-party
// names the attorney enters in pii-settings.html, (b) titles (מר, גב׳,
// עו״ד, ד״ר, Mr., Dr. ...) followed by a name, and (c) "<name> בע״מ".
// Anything outside those patterns is NOT detected, and the UI says so.

(function (root) {
  'use strict';

  const subtle = root.crypto && root.crypto.subtle;

  // Category -> settings rule that enables it.
  const CATEGORY_RULE = {
    CLIENT_NAME: 'maskNames',
    ADVERSE_PARTY: 'maskNames',
    PERSON_NAME: 'maskNames',
    COMPANY_NAME: 'maskNames',
    ID_NUMBER: 'maskIds',
    PASSPORT_NUMBER: 'maskIds',
    COMPANY_NUMBER: 'maskIds',
    EMAIL: 'maskContact',
    PHONE: 'maskContact',
    LAND_BLOCK: 'maskLand',
    LAND_PARCEL: 'maskLand',
    LAND_SUBPARCEL: 'maskLand',
    AMOUNT: 'maskAmounts',
  };

  const CATEGORY_LABELS = {
    CLIENT_NAME: 'שם לקוח',
    ADVERSE_PARTY: 'צד שכנגד',
    PERSON_NAME: 'שם אדם',
    COMPANY_NAME: 'שם חברה',
    ID_NUMBER: 'מספר ת.ז.',
    PASSPORT_NUMBER: 'מספר דרכון',
    COMPANY_NUMBER: 'ח.פ. / ח.צ.',
    EMAIL: 'דוא״ל',
    PHONE: 'טלפון',
    LAND_BLOCK: 'גוש',
    LAND_PARCEL: 'חלקה',
    LAND_SUBPARCEL: 'תת-חלקה',
    AMOUNT: 'סכום כספי',
  };

  // Drawer grouping, matching the spec's breakdown.
  const CATEGORY_GROUPS = [
    { label: 'שמות', categories: ['CLIENT_NAME', 'ADVERSE_PARTY', 'PERSON_NAME', 'COMPANY_NAME'] },
    { label: 'מספרי זיהוי', categories: ['ID_NUMBER', 'PASSPORT_NUMBER'] },
    { label: 'חברות', categories: ['COMPANY_NUMBER'] },
    { label: 'דוא״ל וטלפון', categories: ['EMAIL', 'PHONE'] },
    { label: 'מקרקעין (גוש/חלקה)', categories: ['LAND_BLOCK', 'LAND_PARCEL', 'LAND_SUBPARCEL'] },
    { label: 'סכומים כספיים', categories: ['AMOUNT'] },
  ];

  // Amounts default OFF: masking every sum usually destroys the legal
  // question being asked (fees, damages, thresholds). The attorney opts in.
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    maskNames: true,
    maskIds: true,
    maskContact: true,
    maskLand: true,
    maskAmounts: false,
    clientNames: [],
    partyNames: [],
  });

  // Hebrew quote variants: ASCII ", ״ (gershayim), ” and ' / ׳ (geresh).
  const Q2 = '["״”]';
  const Q1 = "['׳’]";
  const HEB = 'א-ת';

  function isValidIsraeliId(digits) {
    if (!/^\d{5,9}$/.test(digits)) return false;
    const s = digits.padStart(9, '0');
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      let d = Number(s[i]) * ((i % 2) + 1);
      if (d > 9) d -= 9;
      sum += d;
    }
    return sum % 10 === 0;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Each rule: regex with named groups. `pre` (kept verbatim, e.g. a label
  // like "ת.ז." or a Hebrew prefix letter) and `val` (the part replaced by a
  // token). `classify(val, match)` returns a category or null (= leave it).
  function buildRules(settings) {
    const rules = [];

    rules.push({
      re: /(?<val>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
      classify: () => 'EMAIL',
    });

    rules.push({
      re: /(?<![\d+])(?<val>(?:\+972[-\s]?|0)(?:5\d|7\d|[2-489])[-\s]?\d{3}[-\s]?\d{4})(?!\d)/g,
      classify: () => 'PHONE',
    });

    // Land registry: keep the word (the model still knows it's a block /
    // parcel), mask the number. Sub-parcel first so "תת-חלקה 3" isn't also
    // read as "חלקה 3".
    rules.push({
      re: new RegExp('(?<pre>(?:תת[-\\s]?חלקה|sub[-\\s]?parcel)\\s*[:#]?\\s*)(?<val>\\d{1,4})(?!\\d)', 'gi'),
      classify: () => 'LAND_SUBPARCEL',
    });
    rules.push({
      re: new RegExp('(?<pre>(?:גוש|block)\\s*[:#]?\\s*)(?<val>\\d{1,6})(?!\\d)', 'gi'),
      classify: () => 'LAND_BLOCK',
    });
    rules.push({
      re: new RegExp('(?<pre>(?:חלקה|חלקות|parcel)\\s*[:#]?\\s*)(?<val>\\d{1,5})(?!\\d)', 'gi'),
      classify: () => 'LAND_PARCEL',
    });

    // Labelled numbers: the label decides the category, no check digit
    // required (a mistyped ID is still somebody's ID).
    rules.push({
      re: new RegExp(
        '(?<pre>(?:ח\\.?\\s?פ\\.?|ח' + Q2 + 'פ|ח\\.?\\s?צ\\.?|ח' + Q2 + 'צ|ע\\.?\\s?ר\\.?|ע' + Q2 + 'ר|מס' + Q1 + '?\\s?חברה|company\\s?(?:no\\.?|number)|reg(?:istration)?\\.?\\s?no\\.?)\\s*[:#]?\\s*)(?<val>\\d{8,9})(?!\\d)',
        'gi'),
      classify: () => 'COMPANY_NUMBER',
    });
    rules.push({
      re: new RegExp(
        '(?<pre>(?:ת\\.?\\s?ז\\.?|ת' + Q2 + 'ז|תעודת\\s+זהות|מס' + Q1 + '?\\s?זהות|ID\\s?(?:no\\.?|number)?)\\s*[:#]?\\s*)(?<val>\\d{5,9})(?!\\d)',
        'gi'),
      classify: () => 'ID_NUMBER',
    });
    rules.push({
      re: new RegExp('(?<pre>(?:דרכון(?:\\s+(?:מס' + Q1 + '?|מספר))?|passport(?:\\s?(?:no\\.?|number))?)\\s*[:#]?\\s*)(?<val>[A-Z0-9]{6,10})(?![A-Za-z0-9])', 'gi'),
      classify: (val) => (/\d/.test(val) ? 'PASSPORT_NUMBER' : null),
    });

    // Unlabelled 9-digit numbers: only when the Israeli check digit holds,
    // so case numbers and the like aren't swallowed. Company numbers share
    // the same check digit and start with 5.
    rules.push({
      re: /(?<![\d\w])(?<val>\d{9})(?![\d\w])/g,
      classify: (val) => (isValidIsraeliId(val) ? (val[0] === '5' ? 'COMPANY_NUMBER' : 'ID_NUMBER') : null),
    });

    rules.push({
      re: new RegExp(
        '(?<val>(?:₪|NIS|ILS|USD|EUR|\\$|€)\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:מיליון|אלף|million|thousand|[KkMm](?![A-Za-z])))?' +
        '|\\d[\\d,]*(?:\\.\\d+)?\\s?(?:(?:מיליון|אלף)\\s?)?(?:₪|ש' + Q2 + 'ח|שקלים(?:\\s+חדשים)?|NIS|ILS|דולר|יורו|USD|EUR))',
        'g'),
      classify: () => 'AMOUNT',
    });

    // Names the attorney entered for this matter. Longest first so "דוד
    // כהן" wins over "כהן". Hebrew prefix letters (ו, ה, ב, ל, מ, ש, כ)
    // glued to the name are kept, not masked.
    const named = [];
    for (const n of settings.clientNames || []) named.push({ name: n, category: 'CLIENT_NAME' });
    for (const n of settings.partyNames || []) named.push({ name: n, category: 'ADVERSE_PARTY' });
    named
      .map((x) => ({ ...x, name: String(x.name).trim().replace(/\s+/g, ' ') }))
      .filter((x) => x.name.length >= 2)
      .sort((a, b) => b.name.length - a.name.length)
      .forEach(({ name, category }) => {
        const body = escapeRegExp(name).replace(/ /g, '\\s+');
        rules.push({
          re: new RegExp('(?<![' + HEB + 'A-Za-z0-9])(?<pre>[ובלמשהכ]{0,2})(?<val>' + body + ')(?![' + HEB + 'A-Za-z0-9])', 'gi'),
          classify: () => category,
        });
      });

    // Title + name. Two words max; over-masking a following word is the
    // safer failure for a privacy feature than leaking a surname.
    const heWord = '[' + HEB + '][' + HEB + Q1.slice(1, -1) + '-]*';
    rules.push({
      re: new RegExp(
        '(?<pre>(?<![' + HEB + '])(?:מר|גב' + Q1 + '|גברת|עו' + Q2 + 'ד|עוה' + Q2 + 'ד|ד' + Q2 + 'ר|פרופ' + Q1 + ')\\s+)(?<val>' + heWord + '(?:\\s+' + heWord + ')?)',
        'g'),
      classify: () => 'PERSON_NAME',
    });
    rules.push({
      re: /(?<pre>\b(?:Mr|Mrs|Ms|Dr|Adv|Prof)\.?\s+)(?<val>[A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)/g,
      classify: () => 'PERSON_NAME',
    });
    rules.push({
      re: new RegExp('(?<val>(?:[' + HEB + '][' + HEB + '"״\'׳.-]*\\s+){1,3})(?<post>בע' + Q2 + 'מ)', 'g'),
      classify: () => 'COMPANY_NAME',
      trimVal: true,
    });

    return rules;
  }

  function normalizeFor(category, value) {
    const v = String(value).trim().replace(/\s+/g, ' ');
    if (['PHONE', 'ID_NUMBER', 'COMPANY_NUMBER', 'LAND_BLOCK', 'LAND_PARCEL', 'LAND_SUBPARCEL'].includes(category)) {
      return v.replace(/\D/g, '').replace(/^972/, '0');
    }
    return v.toLowerCase();
  }

  function toBytes(s) { return new TextEncoder().encode(s); }
  function fromBytes(b) { return new TextDecoder().decode(b); }
  function hex(buf) { return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join(''); }

  // Ephemeral vault: token -> AES-256-GCM ciphertext of the original value,
  // under a non-extractable key generated per conversation. The reverse
  // lookup (same value -> same token, so the model sees a consistent
  // [CLIENT_NAME_1] across turns) is keyed by an HMAC of the value, so no
  // plaintext sits in the vault's own maps. Honest scope: this protects
  // against the map leaking via logs/serialization/heap snapshots of plain
  // objects; script running inside this page could still call reveal().
  // purge() drops the keys, after which nothing in it can be decrypted.
  function createVault() {
    if (!subtle) throw new Error('WebCrypto unavailable');
    const entries = new Map(); // token -> { iv, ct, category }
    const index = new Map();   // hmac(category, value) -> token
    const counters = {};
    let keys = null;
    let purged = false;

    const ready = Promise.all([
      subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
      subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    ]).then(([aes, mac]) => { keys = { aes, mac }; });

    async function tokenFor(category, original) {
      await ready;
      if (purged) throw new Error('vault purged');
      const id = hex(await subtle.sign('HMAC', keys.mac, toBytes(category + '\u0000' + normalizeFor(category, original))));
      const existing = index.get(id);
      if (existing) return existing;
      counters[category] = (counters[category] || 0) + 1;
      const token = '[' + category + '_' + counters[category] + ']';
      const iv = root.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, keys.aes, toBytes(original));
      entries.set(token, { iv, ct, category });
      index.set(id, token);
      return token;
    }

    async function reveal(token) {
      await ready;
      if (purged) return null;
      const e = entries.get(token);
      if (!e) return null;
      return fromBytes(await subtle.decrypt({ name: 'AES-GCM', iv: e.iv }, keys.aes, e.ct));
    }

    function purge() {
      entries.clear();
      index.clear();
      for (const k of Object.keys(counters)) delete counters[k];
      keys = null;
      purged = true;
    }

    return {
      tokenFor,
      reveal,
      purge,
      get size() { return entries.size; },
      get purged() { return purged; },
      categoryOf: (token) => (entries.get(token) || {}).category || null,
    };
  }

  function enabledCategory(settings, category) {
    return !!category && !!settings[CATEGORY_RULE[category]];
  }

  // Masks `text`. Rules run in order on the progressively masked string;
  // tokens are [UPPER_CASE_N] so no later rule can match inside one.
  async function mask(text, vault, settingsIn) {
    const settings = { ...DEFAULT_SETTINGS, ...(settingsIn || {}) };
    const input = String(text == null ? '' : text);
    if (!settings.enabled) return { masked: input, entities: [], count: 0 };

    let out = input;
    let count = 0;
    const seen = new Map(); // token -> category

    for (const rule of buildRules(settings)) {
      rule.re.lastIndex = 0;
      const hits = [];
      for (const m of out.matchAll(rule.re)) {
        const g = m.groups || {};
        let val = g.val;
        if (!val) continue;
        let trail = '';
        if (rule.trimVal) {
          const t = val.replace(/\s+$/, '');
          trail = val.slice(t.length);
          val = t;
        }
        if (/^\[[A-Z_]+_\d+\]$/.test(val) || val.includes('[')) continue;
        const category = rule.classify(val, m);
        if (!enabledCategory(settings, category)) continue;
        const pre = g.pre || '';
        const post = g.post || '';
        hits.push({ index: m.index, length: m[0].length, pre, val, trail, post, category });
      }
      if (!hits.length) continue;
      for (const h of hits) h.token = await vault.tokenFor(h.category, h.val);
      // Replace right-to-left so earlier indices stay valid.
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        out = out.slice(0, h.index) + h.pre + h.token + h.trail + h.post + out.slice(h.index + h.length);
        seen.set(h.token, h.category);
        count++;
      }
    }

    const entities = [...seen.entries()].map(([token, category]) => ({ token, category }));
    return { masked: out, entities, count };
  }

  const TOKEN_RE = /\[\s*([A-Z]+(?:_[A-Z]+)*_\d+)\s*\]/g;

  async function unmask(text, vault) {
    const input = String(text == null ? '' : text);
    const tokens = [...new Set([...input.matchAll(TOKEN_RE)].map((m) => '[' + m[1] + ']'))];
    const values = new Map();
    for (const t of tokens) {
      const v = await vault.reveal(t);
      if (v != null) values.set(t, v);
    }
    return input.replace(TOKEN_RE, (whole, name) => {
      const v = values.get('[' + name + ']');
      return v == null ? whole : v;
    });
  }

  function countByCategory(entities) {
    const out = {};
    for (const e of entities) out[e.category] = (out[e.category] || 0) + 1;
    return out;
  }

  // Settings persistence. Rules live in localStorage (they're preferences).
  // Client / party names are themselves client data, so they live only in
  // sessionStorage: gone when the browser session ends, never synced.
  const RULES_KEY = 'lalum.piiShield.rules.v1';
  const NAMES_KEY = 'lalum.piiShield.names.v1';

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  function loadSettings(local, session) {
    const rules = (local && safeParse(local.getItem(RULES_KEY))) || {};
    const names = (session && safeParse(session.getItem(NAMES_KEY))) || {};
    const out = { ...DEFAULT_SETTINGS };
    for (const k of ['enabled', 'maskNames', 'maskIds', 'maskContact', 'maskLand', 'maskAmounts']) {
      if (typeof rules[k] === 'boolean') out[k] = rules[k];
    }
    out.clientNames = Array.isArray(names.clientNames) ? names.clientNames.filter((x) => typeof x === 'string') : [];
    out.partyNames = Array.isArray(names.partyNames) ? names.partyNames.filter((x) => typeof x === 'string') : [];
    return out;
  }

  function saveSettings(settings, local, session) {
    const rules = {};
    for (const k of ['enabled', 'maskNames', 'maskIds', 'maskContact', 'maskLand', 'maskAmounts']) rules[k] = !!settings[k];
    if (local) local.setItem(RULES_KEY, JSON.stringify(rules));
    if (session) session.setItem(NAMES_KEY, JSON.stringify({
      clientNames: settings.clientNames || [],
      partyNames: settings.partyNames || [],
    }));
  }

  root.LalumPII = {
    DEFAULT_SETTINGS,
    CATEGORY_LABELS,
    CATEGORY_GROUPS,
    CATEGORY_RULE,
    isValidIsraeliId,
    createVault,
    mask,
    unmask,
    countByCategory,
    loadSettings,
    saveSettings,
  };
})(typeof window !== 'undefined' ? window : globalThis);
