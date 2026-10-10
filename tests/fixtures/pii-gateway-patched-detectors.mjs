// pii-gateway v13 detectors + the unification patch (docs/pii-gateway-patch.md). Differences from v13 are marked PATCH.
// Verbatim copy of pii-gateway v13 detectors (pure functions)
const NIQQUD = /[֑-ׇ]/g;
const QUOTES = /[״"׳'`]/g;
const DASHES = /[־‐-―\-]/g;
const HEB_PREFIX = "(?:[והבכלמש]{1,3})?";
const HEB_LETTER = "\\u05D0-\\u05EA";
const COMPANY_SUFFIXES = /(?<![א-תA-Za-z])(בע"?מ|ltd\.?|limited|inc\.?|llc|gmbh|שותפות מוגבלת|ש\.מ\.?)(?![א-תA-Za-z])/giu;
function stripNiqqud(s){return s.replace(NIQQUD,"")}
export function normalizeName(s){return stripNiqqud(s).replace(QUOTES,'"').replace(COMPANY_SUFFIXES," ").replace(/"/g,"").replace(DASHES," ").replace(/[.,()]/g," ").replace(/\s+/g," ").trim().toLowerCase()}
function digitsOnly(s){return s.replace(/\D/g,"")}
function isValidIsraeliId(input){const digits=input.replace(/\D/g,"");if(digits.length<5||digits.length>9)return false;const id=digits.padStart(9,"0");if(/^0+$/.test(id))return false;let sum=0;for(let i=0;i<9;i++){let n=Number(id[i])*(i%2+1);if(n>9)n-=9;sum+=n}return sum%10===0}
function looksLikeCorporateNumber(d){return /^5[0-8]\d{7}$/.test(d)}
const ID_CONTEXT = /(ת[.״"']?\s?ז[.']?|תעודת\s+זהות|מס['׳]?\s*זהות|מספר\s+זהות|\bID\b|passport|דרכון)[\s:.\-מס'׳]*$/iu;
const CORP_CONTEXT = /(ח[.״"']?\s?פ[.']?|ח[.״"']?\s?צ[.']?|ע[.״"']?\s?ר[.']?|מס['׳]?\s*(חברה|תאגיד|עמותה|שותפות)|company\s+(no|number|reg))[\s:.\-מס'׳]*$/iu;
const lookbehind=(t,i,n=24)=>t.slice(Math.max(0,i-n),i);
const push=(o,d)=>{if(d.end>d.start)o.push(d)};
export function detectStructured(text){
  const out=[];
  for(const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g)) push(out,{kind:"EMAIL",start:m.index,end:m.index+m[0].length,value:m[0],confidence:1});
  for(const m of text.matchAll(/\bIL\d{2}(?:[\s-]?\d{4}){4}[\s-]?\d{3}\b/gi)) push(out,{kind:"IBAN",start:m.index,end:m.index+m[0].length,value:m[0],confidence:1});
  const phoneRe=/(?<![\w])(?:(?:\+|00)?972[\s-]?|0)(?:5\d|7\d|[2-489])[\s-]?\d{3}[\s-]?\d{4}(?![\w])/g;
  for(const m of text.matchAll(phoneRe)) push(out,{kind:"PHONE",start:m.index,end:m.index+m[0].length,value:m[0],confidence:1});
  const bankRe=/(חשבון(?:\s+בנק)?(?:\s+מס['׳]?|\s+מספר)?\s*:?\s*)(\d[\d\-\/]{3,14}\d)/gdu;
  for(const m of text.matchAll(bankRe)){const [s,e]=m.indices[2];push(out,{kind:"BANK_ACCOUNT",start:s,end:e,value:m[2],confidence:0.95})}
  const numRe=/(?<![\w\/]|\d[.,])(\d{2,3}-\d{6,7}-\d|\d{2,8}-\d|\d{5,9})(?![\w\/]|[.,]\d)/g;
  for(const m of text.matchAll(numRe)){
    const raw=m[0],digits=digitsOnly(raw),start=m.index,before=lookbehind(text,start,40);
    const corpCtx=CORP_CONTEXT.test(before),idCtx=ID_CONTEXT.test(before);
    const valid=digits.length>=8&&isValidIsraeliId(digits);
    let kind=null,confidence=0;
    if(corpCtx){kind="COMPANY_ID";confidence=valid?1:0.9}
    else if(idCtx){kind="ID_NUMBER";confidence=valid?1:0.9}
    else if(digits.length===9&&valid){kind=looksLikeCorporateNumber(digits)?"COMPANY_ID":"ID_NUMBER";confidence=1}
    if(kind)push(out,{kind,start,end:start+raw.length,value:raw,confidence});
  }
  // PATCH: passport, combined parcel, street address
  for(const m of text.matchAll(/((?:passport|דרכון)(?:\s+(?:no|number|מס['׳]?|מספר))?\s*[:.]?\s*)([A-Z]{0,2}\d{6,9})/gdiu)){const [s,e]=m.indices[2];push(out,{kind:"ID_NUMBER",start:s,end:e,value:m[2],confidence:0.95})}
  for(const m of text.matchAll(/(?:גוש\s*\/\s*חלקה|גו"ח)\s*:?\s*(\d{1,6})\s*\/\s*(\d{1,5})/gdu)){for(const g of [1,2]){const [s,e]=m.indices[g];push(out,{kind:g===1?"GUSH":"HELKA",start:s,end:e,value:m[g],confidence:1})}}
  for(const m of text.matchAll(/(?<![\p{L}])(?:[ולבמהכש]{0,2}(?=רחוב|רח['׳]|שדרות|שד['׳]|סמטת|כיכר)|(?=דרך))((?:רחוב|רח['׳]|שדרות|שד['׳]|דרך|סמטת|כיכר)\s+(?:[\p{L}'׳"״-]+\s+){0,2}[\p{L}'׳"״-]+\s+\d{1,4}[א-ת]?)(?![\d\w])/gdu)) push(out,{kind:"ADDRESS",start:m.indices[1][0],end:m.indices[1][1],value:m[1],confidence:0.9});
  const landRules=[[/(גוש(?:\s+מס['׳]?)?\s*:?\s*)(\d{3,6})/gdu,"GUSH"],[/((?<!תת[\s-])חלק(?:ה|ות)(?:\s+מס['׳]?)?\s*:?\s*)(\d{1,5})/gdu,"HELKA"],[/(תת[\s-]?חלק(?:ה|ות)(?:\s+מס['׳]?)?\s*:?\s*)(\d{1,4})/gdu,"SUB_HELKA"]];
  for(const [re,kind] of landRules) for(const m of text.matchAll(re)){const [s,e]=m.indices[2];push(out,{kind,start:s,end:e,value:m[2],confidence:1})}
  return out;
}
export function detectDictionary(text,parties){
  const out=[];
  for(const p of parties){
    const kind=p.role==="client"?"CLIENT_NAME":p.role==="adverse"?"COUNTERPARTY":"PERSON";
    for(const name of [p.displayName,...(p.aliases??[])]){
      if(!name||name.trim().length<2)continue;
      const parts=stripNiqqud(name).trim().split(/\s+/).map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/["״]/g,'["״]?').replace(/['׳]/g,"['׳]?"));
      const re=new RegExp(`(?<![${HEB_LETTER}A-Za-z0-9])${/[א-ת]/.test(name)?HEB_PREFIX:""}(${parts.join("\\s+")})(?![${HEB_LETTER}A-Za-z0-9])`,"gdiu");
      for(const m of text.matchAll(re)){const [s,e]=m.indices[1];out.push({kind,start:s,end:e,value:m[1],confidence:1})}
    }
  }
  return out;
}
const TITLE_RE=new RegExp(String.raw`(?<![${HEB_LETTER}])(?:[וש]?ה?)(?:מר|גב['׳]|גברת|עו["״]ד|ד["״]ר|פרופ['׳]|רו["״]ח|שמאי(?:ת)?|המנוח(?:ה)?|הקטינ?(?:ה)?|התובע(?:ת)?|הנתבע(?:ת)?|המבקש(?:ת)?|המשיב(?:ה)?|המערער(?:ת)?|יורש(?:ת)?)\s+`+String.raw`([${HEB_LETTER}][${HEB_LETTER}'׳"״\-]+(?:\s+[${HEB_LETTER}][${HEB_LETTER}'׳"״\-]+)?)`,"gdu");
const EN_TITLE_RE=/\b(?:Mr|Mrs|Ms|Dr|Adv|Prof)\.?\s+([A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+)?)/gd;
const STOP=new Set(`על של את כי אשר הנ"ל הנ״ל טען טענה אמר אמרה הגיש הגישה חתם חתמה ציין ציינה השיב השיבה יליד ילידת ת"ז ת״ז מס' מס׳ בע"מ בע״מ וכן או גם לא כן היה היתה הודיע הודיעה מסר מסרה לפי בגין חברה חברת עמותה שותפות בעל בעלת הוא היא הינו הינה באמצעות ב"כ ב״כ ע"י ע״י מטעם בין לבין להלן ובין וכן מאת עם אל כנגד נגד מול מר גב' גב׳ גברת עו"ד עו״ד ד"ר ד״ר פרופ' רו"ח רו״ח שמאי אני שמי אינו אינה אינם אינן הינם הינן`.split(" "));
const HW=`[${HEB_LETTER}][${HEB_LETTER}'׳"״\\-]+`;
const ANCHOR_ID_RE=new RegExp(String.raw`((?:${HW}\s+){0,2}${HW})\s*,?\s*(?=ת[.״"']?\s?ז)`,"gdu");
const ORG_RE=new RegExp(String.raw`((?:${HW}\s+){0,3}${HW})\s+(בע["״]?מ|Ltd\.?|LLC)`,"gdu");
function trimLeftToName(m,kind,confidence,suffix){
  const [g1s,g1e]=m.indices[1];
  const words=[...m[1].matchAll(/\S+/gu)].map(w=>({w:w[0],at:g1s+w.index}));
  let cut=0;words.forEach((x,i)=>{if(STOP.has(x.w)||/^[ולבמש]?(?:בין|לבין|חברת|להלן|הנתבעת|התובעת|הנתבע|התובע)$/u.test(x.w))cut=i+1});
  const kept=words.slice(cut);if(!kept.length)return null;
  const start=kept[0].at,end=suffix?m.index+m[0].length:g1e;
  return {kind,start,end,value:(m.input??"").slice(start,end),confidence};
}
export function detectHeuristicPersons(text){
  const out=[];
  for(const m of text.matchAll(TITLE_RE)){const [s]=m.indices[1];const kept=[];for(const w of m[1].split(/\s+/)){if(STOP.has(w))break;kept.push(w)}if(!kept.length)continue;const value=kept.join(" ");out.push({kind:"PERSON",start:s,end:s+value.length,value,confidence:0.75})}
  for(const m of text.matchAll(ANCHOR_ID_RE)){const d=trimLeftToName(m,"PERSON",0.8);if(d)out.push(d)}
  for(const m of text.matchAll(ORG_RE)){const d=trimLeftToName(m,"ORG",0.8,m[2]);if(d)out.push(d)}
  for(const m of text.matchAll(EN_TITLE_RE)){const [s,e]=m.indices[1];out.push({kind:"PERSON",start:s,end:e,value:m[1],confidence:0.75})}
  return out;
}
export function resolveOverlaps(ds){const r=[...ds].sort((a,b)=>b.confidence-a.confidence||b.end-b.start-(a.end-a.start)||a.start-b.start);const t=[];for(const d of r)if(!t.some(x=>d.start<x.end&&x.start<d.end))t.push(d);return t.sort((a,b)=>a.start-b.start)}
const allow=new Set(["אברהם ללום","Avraham Lalum","Avi Lalum"].map(normalizeName));
export function detect(text){return resolveOverlaps([...detectStructured(text),...detectDictionary(text,[]),...detectHeuristicPersons(text)].filter(d=>!((d.kind==="PERSON"||d.kind==="ORG")&&allow.has(normalizeName(d.value)))))}
// B's egress guard (structured + dictionary only, no heuristics)
export function residual(text){return resolveOverlaps([...detectStructured(text),...detectDictionary(text,[]),...detectHeuristicPersons(text)])} // PATCH: guard includes heuristics
export function mask(text){const ds=detect(text);const cnt={};let o=text;const toks=ds.map(d=>{cnt[d.kind]=(cnt[d.kind]??0)+1;return `[${d.kind}_${cnt[d.kind]}]`});for(let i=ds.length-1;i>=0;i--)o=o.slice(0,ds[i].start)+toks[i]+o.slice(ds[i].end);return o}
