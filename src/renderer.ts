import type { BlockInfo } from "./parser";
import { LEN_BASE, LEN_EXTRA, DIST_BASE, DIST_EXTRA } from "./parser";

const $ = (id: string) => document.getElementById(id)!;

/* ============================== 可視化：LITグラデーション ============================== */
const defaultBg = (i: number) => `hsl(${Math.floor((i*137.508)%360)}deg 65% 28% / .45)`;
function getMaxLitBits(blocks: BlockInfo[]): number {
  let max = 0;
  for (const b of blocks) {
    const arr = b.trees.litLenCodeLengths;
    if (arr) for (const v of arr) if (v > max) max = v;
  }
  return max || 9;
}
function litBgFor(bitlen: number, maxBits: number) {
  const denom = Math.max(1, maxBits - 1);
  const t = Math.max(0, Math.min(1, (bitlen - 1) / denom));
  const hue = 120 - 120 * t;                  // 緑(短)→赤(長)
  const light = (bitlen % 2 === 0) ? 32 : 26; // 偶奇で明度差
  return `hsl(${hue}deg 75% ${light}% / .55)`;
}
function countBgFor(count: number, maxCount: number) {
  if (maxCount <= 0) return `hsl(0deg 0% 18% / .0)`;
  const denom = Math.max(1, maxCount - 1);
  const t = Math.max(0, Math.min(1, (count - 1) / denom));
  const hue = 120 * t; // 0(赤) → 120(緑)
  const light = (count % 2 === 0) ? 32 : 26;
  return `hsl(${hue}deg 75% ${light}% / .55)`;
}
function updateLitLegend(maxBits: number) {
  const bar = $("litLegendBar") as HTMLDivElement;
  const minLab = $("litLegendMin") as HTMLSpanElement;
  const maxLab = $("litLegendMax") as HTMLSpanElement;
  const stops: string[] = [];
  for (let b = 1; b <= maxBits; b++) {
    const color = litBgFor(b, maxBits);
    const p0 = ((b - 1) / maxBits * 100).toFixed(2) + "%";
    const p1 = (b / maxBits * 100).toFixed(2) + "%";
    stops.push(`${color} ${p0} ${p1}`);
  }
  bar.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
  minLab.textContent = "1b";
  maxLab.textContent = `${maxBits}b`;
}
function updateCountLegend(maxCount: number) {
  const bar = $("countLegendBar") as HTMLDivElement;
  const stops: string[] = [];
  for (let c = 1; c <= Math.max(1, maxCount); c++) {
    const color = countBgFor(c, Math.max(1, maxCount));
    const p0 = ((c - 1) / Math.max(1, maxCount) * 100).toFixed(2) + "%";
    const p1 = (c / Math.max(1, maxCount) * 100).toFixed(2) + "%";
    stops.push(`${color} ${p0} ${p1}`);
  }
  bar.style.background = stops.length
    ? `linear-gradient(to right, ${stops.join(", ")})`
    : "linear-gradient(to right, #1a2746, #1a2746)";
  ($("countLegendMax") as HTMLSpanElement).textContent = String(maxCount);
}

/* ======== 参照元ハイライト & 同一トークン断片の同時強調 ======== */
function rangesOverlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(a0, b0) < Math.min(a1, b1);
}
function clearHighlights(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('ruby.tok.ref-target').forEach(el => el.classList.remove('ref-target'));
  container.querySelectorAll<HTMLElement>('ruby.tok.same-token').forEach(el => el.classList.remove('same-token'));
  container.querySelectorAll<HTMLElement>('ruby.tok.hit').forEach(el => el.classList.remove('hit'));
  container.querySelectorAll<HTMLElement>('.ch.refch').forEach(el => el.classList.remove('refch'));
}
function applyHighlight(container: HTMLElement, refStart: number, refEnd: number, tokenId: string) {
  const rubies = Array.from(container.querySelectorAll<HTMLElement>('ruby.tok'));
  for (const ruby of rubies) {
    const ss = parseInt(ruby.dataset.spanStart || "-1", 10);
    const se = parseInt(ruby.dataset.spanEnd   || "-1", 10);
    if (ss >= 0 && se >= 0 && rangesOverlap(ss, se, refStart, refEnd)) {
      const chars = ruby.querySelectorAll<HTMLElement>('.ch');
      chars.forEach(ch => {
        const abs = parseInt(ch.dataset.abs || "-1", 10);
        if (abs >= refStart && abs < refEnd) ch.classList.add('refch');
      });
    }
    if (ruby.dataset.tokenId === tokenId) ruby.classList.add('ref-target', 'same-token');
  }
}

/* ======== クリック固定ハイライト（トークン／コードセル） ======== */
let locked = false;
export function lockClear(container: HTMLElement) {
  locked = false;
  clearHighlights(container);
}
export function lockToken(container: HTMLElement, tokenId: string, type: string) {
  locked = true;
  container.querySelectorAll<HTMLElement>(`ruby.tok[data-token-id="${tokenId}"]`)
    .forEach(el => el.classList.add("same-token","hit","ref-target"));
  if (type === "match") {
    const any = container.querySelector<HTMLElement>(`ruby.tok[data-token-id="${tokenId}"]`);
    if (any) {
      const rs = parseInt(any.dataset.refStart || "-1", 10);
      const re = parseInt(any.dataset.refEnd   || "-1", 10);
      if (rs >= 0 && re > rs) applyHighlight(container, rs, re, tokenId);
    }
  }
}
export function lockLitByCode(container: HTMLElement, code: number, blockIndex: number|null = null) {
  locked = true;
  clearHighlights(container);
  const sel = blockIndex==null
    ? `ruby.tok.lit[data-lit="${code}"]`
    : `ruby.tok.lit[data-lit="${code}"][data-block-index="${blockIndex}"]`;
  container.querySelectorAll<HTMLElement>(sel).forEach(el=>{
    el.classList.add("hit","same-token","ref-target");
  });
}

export function lockLengthRange(container: HTMLElement, min: number, max: number, blockIndex: number|null = null) {
  locked = true;
  clearHighlights(container);
  const sel = blockIndex==null
    ? `ruby.tok.match`
    : `ruby.tok.match[data-block-index="${blockIndex}"]`;
  container.querySelectorAll<HTMLElement>(sel).forEach(el=>{
    const len=parseInt(el.dataset.length||"0",10);
    if(len>=min && len<=max) el.classList.add("hit","same-token","ref-target");
  });
}

export function lockDistanceRange(container: HTMLElement, min: number, max: number, blockIndex: number|null = null) {
  locked = true;
  clearHighlights(container);
  const sel = blockIndex==null
    ? `ruby.tok.match`
    : `ruby.tok.match[data-block-index="${blockIndex}"]`;
  container.querySelectorAll<HTMLElement>(sel).forEach(el=>{
    const dist=parseInt(el.dataset.distance||"0",10);
    if(dist>=min && dist<=max) el.classList.add("hit","same-token","ref-target");
  });
}

/* ============================== トークン描画 ============================== */
export function renderOutput(container: HTMLElement, tokens: any[], blocks: BlockInfo[]): number {
  container.innerHTML = "";
  const maxLitBits = getMaxLitBits(blocks);

  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti];
    const parts = (t.text || "").split("\n");
    let carried = 0;

    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      const absStart = (t.spanStart | 0) + carried;
      const absEnd = absStart + p.length;

      const ruby = document.createElement("ruby");
      ruby.className = "tok";
      ruby.dataset.type = t.type;
      ruby.dataset.spanStart = String(absStart);
      ruby.dataset.spanEnd   = String(absEnd);
      ruby.dataset.tokenId   = String(ti);
      ruby.dataset.partIndex = String(j);
      ruby.dataset.partTotal = String(parts.length);
      ruby.dataset.blockIndex= String(t.blockIndex);

      if (parts.length === 1) ruby.classList.add("frag-single");
      else if (j === 0) ruby.classList.add("frag-start");
      else if (j === parts.length - 1) ruby.classList.add("frag-end");
      else ruby.classList.add("frag-mid");

      if (t.type === "lit") {
        (ruby.style as any).background = litBgFor(t.bitsUsed || 1, maxLitBits);
        ruby.classList.add("lit");
        if (typeof t.litCode === "number") ruby.dataset.lit = String(t.litCode);
      } else if (t.type === "match") {
        ruby.classList.add("match");
        const refStart = Math.max(0, (t.spanStart | 0) - (t.distance | 0));
        const refLen = Math.max(0, Math.min(t.length | 0, t.distance | 0));
        const refEnd = refStart + refLen;
        ruby.dataset.refStart = String(refStart);
        ruby.dataset.refEnd = String(refEnd);
        ruby.dataset.length = String(t.length);
        ruby.dataset.distance = String(t.distance);
      } else {
        (ruby.style as any).background = defaultBg(ti);
        ruby.classList.add("raw");
      }

      // 文字（rb）は1文字ずつ span（絶対位置 data-abs）
      const rb = document.createElement("rb");
      for (let i = 0; i < p.length; i++) {
        const ch = document.createElement("span");
        ch.className = "ch";
        ch.dataset.abs = String(absStart + i);
        ch.textContent = p[i]; // \t は CSS tab-size で見た目だけ広げる
        rb.appendChild(ch);
      }

      // ルビ（下側）
      const rt = document.createElement("rt");
      const head = t.type === 'lit' ? 'LIT' : t.type === 'match' ? 'MATCH' : 'RAW';
      if (t.type === 'match') {
        const lcb = t.lenCodeBits || 0;
        const leb = t.lenExtraBits || 0;
        const dcb = t.distCodeBits || 0;
        const deb = t.distExtraBits || 0;
        rt.textContent = `${head}(L=${t.length},D=${t.distance}) ${t.bitsUsed}b(${lcb}+${leb},${dcb}+${deb})`;
      } else {
        rt.textContent = `${head} (L=${t.length})  ${t.bitsUsed}b`;
      }

      ruby.append(rb, rt);
      container.appendChild(ruby);

      // ホバー：同一トークン断片 + 参照（MATCH）
      ruby.addEventListener("mouseenter", (ev) => {
        if (locked) return;
        const me = ev.currentTarget as HTMLElement;
        const tokenId = me.dataset.tokenId!;
        container.querySelectorAll<HTMLElement>(`ruby.tok[data-token-id="${tokenId}"]`)
          .forEach(el => el.classList.add("same-token"));
        if (me.dataset.type === "match") {
          const rs = parseInt(me.dataset.refStart || "-1", 10);
          const re = parseInt(me.dataset.refEnd   || "-1", 10);
          if (rs >= 0 && re > rs) applyHighlight(container, rs, re, tokenId);
          else me.classList.add('ref-target');
        } else {
          me.classList.add('ref-target');
        }
      });
      ruby.addEventListener("mouseleave", () => { if (!locked) clearHighlights(container); });

      // クリック固定
      ruby.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const me = ev.currentTarget as HTMLElement;
        clearHighlights(container);
        lockToken(container, me.dataset.tokenId!, me.dataset.type || "");
      });

      if (j < parts.length - 1) container.appendChild(document.createTextNode("\n"));
      carried += p.length + (j < parts.length - 1 ? 1 : 0);
    }
  }

  updateLitLegend(maxLitBits);
  return maxLitBits;
}

/* ============================== レンジ表ユーティリティ ============================== */
function escAsciiChar(code: number): string {
  const ch = String.fromCharCode(code);
  if (ch === "\\") return "\\\\";
  if (ch === "'") return "\\'";
  return ch;
}
function asciiAnnotationForRange(a: number, b: number): string {
  const lo = Math.max(0x20, a);
  const hi = Math.min(0x7e, b);
  if (hi < 0x20 || lo > 0x7e) return "";
  if (lo === hi) return `'${escAsciiChar(lo)}'`;
  return `'${escAsciiChar(lo)}'–'${escAsciiChar(hi)}'`;
}
function rangesWithAscii(nums: number[]) {
  if (nums.length === 0) return "";
  const a = Array.from(new Set(nums)).sort((x,y)=>x-y);
  const out: string[] = [];
  let s = a[0], p = a[0];
  const push = (start: number, end: number) => {
    let base = (start === end) ? `${start}` : `${start}–${end}`;
    const loClamp = Math.max(0x20, start);
    const hiClamp = Math.min(0x7e, end);
    if (end >= 0 && start <= 255 && hiClamp >= loClamp) {
      base += ` (${asciiAnnotationForRange(start, end)})`;
    }
    out.push(base);
  };
  for (let i=1;i<a.length;i++){
    if (a[i] === p + 1) { p = a[i]; continue; }
    push(s, p); s = a[i]; p = a[i];
  }
  push(s, p);
  return out.join(", ");
}

function symbolsWithHints(nums: number[], mode:'litlen'|'dist') {
  if (nums.length === 0) return "";
  if (mode === 'dist') {
    return nums.sort((a,b)=>a-b).map(sym=>{
      const base=DIST_BASE[sym]; const extra=DIST_EXTRA[sym];
      const end=base + ((1<<extra) - 1);
      const label = extra ? `${base}-${end}` : `${base}`;
      return `${sym}(${label})`;
    }).join(", ");
  } else {
    const lit = nums.filter(n=>n<=255);
    const len = nums.filter(n=>n>=257);
    const parts:string[]=[];
    if (lit.length) parts.push(rangesWithAscii(lit));
    if (len.length) {
      const mapped=len.sort((a,b)=>a-b).map(sym=>{
        if (sym===285) return `285(258)`;
        const idx=sym-257; const base=LEN_BASE[idx]; const extra=LEN_EXTRA[idx];
        const end=base + ((1<<extra) - 1);
        const label = extra?`${base}-${end}`:`${base}`;
        return `${sym}(${label})`;
      }).join(", ");
      parts.push(mapped);
    }
    return parts.join(", ");
  }
}
function groupByLength(codeLengths?: number[]) {
  const map = new Map<number, number[]>();
  if (!codeLengths) return map;
  for (let sym=0; sym<codeLengths.length; sym++){
    const len = codeLengths[sym] | 0;
    if (len<=0) continue;
    if (!map.has(len)) map.set(len, []);
    map.get(len)!.push(sym);
  }
  return new Map([...map.entries()].sort((a,b)=>a[0]-b[0]));
}

/* ============================== makeLenTable ============================== */
function makeLenTable(title: string, codeLengths?: number[], mode:'litlen'|'dist') {
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.textContent = title;
  (head.style as any).color = "#9db1d0";
  (head.style as any).margin = "8px 0 4px";
  wrap.appendChild(head);

  const tbl = document.createElement("table"); tbl.className="len-table";
  const trh = document.createElement("tr");
  ["len", "count", "symbols (ranges)"].forEach(t=>{ const th=document.createElement("th"); th.textContent=t; trh.appendChild(th); });
  tbl.appendChild(trh);

  const grouped = groupByLength(codeLengths);
  grouped.forEach((syms,len)=>{
    const tr=document.createElement("tr");
    const td1=document.createElement("td"); td1.textContent=String(len);
    const td2=document.createElement("td"); td2.textContent=String(syms.length);
    const td3=document.createElement("td"); td3.className="mono-small wrap";
    td3.textContent = symbolsWithHints(syms, mode);
    tr.append(td1,td2,td3); tbl.appendChild(tr);
  });
  wrap.appendChild(tbl);
  return wrap;
}

/* ============================== 0..127 可視マップ生成 ============================== */
function countLitsForBlock(tokens: any[], blockIndex: number): number[] {
  const cnt = new Array(128).fill(0);
  for (const t of tokens) {
    if (t.blockIndex !== blockIndex) continue;
    if (t.type === "lit" && typeof t.litCode === "number" && t.litCode >= 0 && t.litCode <= 127) {
      cnt[t.litCode]++;
    }
  }
  return cnt;
}
function bitlenFor0to127(codeLengths?: number[]): number[] {
  const out = new Array(128).fill(0);
  if (!codeLengths) return out;
  for (let i = 0; i <= 127; i++) out[i] = (codeLengths[i] | 0);
  return out;
}

/** カスタムツールチップ */
export const tooltip = (() => {
  const el = document.createElement("div");
  el.id = "tt";
  Object.assign(el.style, {
    position: "fixed",
    zIndex: "9999",
    pointerEvents: "none",
    padding: "6px 8px",
    fontSize: "12px",
    background: "rgba(0,0,0,.8)",
    color: "#eaf2ff",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,.15)",
    transform: "translate(8px, 8px)",
    opacity: "0",
    transition: "opacity .08s ease",
    whiteSpace: "pre",
    maxWidth: "60vw"
  } as CSSStyleDeclaration);
  document.body.appendChild(el);
  let visible = false;
  function show(x:number, y:number, text:string) {
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    if (!visible) { el.style.opacity = "1"; visible = true; }
  }
  function move(x:number, y:number) {
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
  }
  function hide() {
    if (visible) { el.style.opacity = "0"; visible = false; }
  }
  return { show, move, hide };
})();

/** 0..127 グリッド（bit長／count） */
function makeCodeGrid(
  caption: string,
  values: number[],
  colorer: (v:number)=>string,
  presentMask: boolean[],
  showTextMask: boolean[],
  titleBuilder: (i:number)=>string,
  onClick: (i:number)=>void
) {
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.textContent = caption;
  (head.style as any).color = "#9db1d0";
  (head.style as any).margin = "8px 0 6px";
  wrap.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "codegrid";
  for (let i = 0; i < 128; i++) {
    const cell = document.createElement("div");
    cell.className = "codecell";
    const present = presentMask[i];
    const showChar = showTextMask[i];
    const v = values[i];

    if (present && v > 0) {
      (cell.style as any).background = colorer(v);
    } else {
      cell.classList.add("missing");
    }
    if (showChar) cell.textContent = String.fromCharCode(i);

    // 自前ツールチップ
    cell.addEventListener("mouseenter", (ev:any)=>{
      const e = ev as MouseEvent;
      tooltip.show(e.clientX, e.clientY, titleBuilder(i));
    });
    cell.addEventListener("mousemove", (ev:any)=>{
      const e = ev as MouseEvent;
      tooltip.move(e.clientX, e.clientY);
    });
    cell.addEventListener("mouseleave", ()=>tooltip.hide());

    // クリック：該当 LIT を点灯
    cell.addEventListener("click", (ev)=>{
      ev.stopPropagation();
      onClick(i);
    });

    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  return wrap;
}

function makeRangeGrid(
  caption:string,
  entries:{label:string,value:number,present:boolean,from:number,to:number}[],
  colorer:(v:number)=>string,
  titleBuilder:(e:any)=>string,
  onClick:(e:any)=>void
) {
  const wrap=document.createElement("div");
  const head=document.createElement("div");
  head.textContent=caption;
  (head.style as any).color="#9db1d0";
  (head.style as any).margin="8px 0 6px";
  wrap.appendChild(head);
  const cols=Math.ceil(entries.length/2);
  const grid=document.createElement("div");
  grid.className="codegrid";
  (grid.style as any).gridTemplateColumns=`repeat(${cols}, 1fr)`;
  entries.forEach(e=>{
    const cell=document.createElement("div");
    cell.className="codecell";
    if(e.present && e.value>0){
      (cell.style as any).background=colorer(e.value);
    } else {
      cell.classList.add("missing");
    }
    cell.textContent=e.label;
    cell.addEventListener("mouseenter", (ev:any)=>{
      const m=ev as MouseEvent;
      tooltip.show(m.clientX,m.clientY,titleBuilder(e));
    });
    cell.addEventListener("mousemove", (ev:any)=>{
      const m=ev as MouseEvent;
      tooltip.move(m.clientX,m.clientY);
    });
    cell.addEventListener("mouseleave",()=>tooltip.hide());
    cell.addEventListener("click", (ev)=>{ev.stopPropagation(); onClick(e);});
    grid.appendChild(cell);
  });
  wrap.appendChild(grid);
  return wrap;
}

/* ============================== ブロック側レンダリング ============================== */
type BlockSummary = {
  index:number; type:string; final:boolean;
  headerBits:number; dynHeaderBits:number; padBits:number; lenNlenBits:number;
  bodyBits:number; totalBits:number; tokens:number; lit:number; match:number; raw:number; outBytes:number;
};
function summarizeBlocks(blocks: BlockInfo[], tokens: any[]): BlockSummary[] {
  return blocks.map(b => {
    const tk = tokens.filter(t => t.blockIndex === b.index);
    const lit = tk.filter(t=>t.type==='lit').length;
    const match = tk.filter(t=>t.type==='match').length;
    const raw = tk.filter(t=>t.type==='raw').length;
    const bodyBits = tk.reduce((a,t)=>a + (t.bitsUsed||0), 0);
    const outBytes = tk.reduce((a,t)=>a + ((t.spanEnd||0)-(t.spanStart||0)), 0);
    const overheadBits = (b.headerBitsUsed||0) + (b.dynamicHeaderBits||0) + (b.padBits||0) + (b.lenNlenBits||0);
    const totalBits = overheadBits + bodyBits;
    return {
      index: b.index,
      type: b.BTYPE===0?'RAW':b.BTYPE===1?'FIXED':'DYNAMIC',
      final: !!b.BFINAL,
      headerBits: b.headerBitsUsed||0,
      dynHeaderBits: b.dynamicHeaderBits||0,
      padBits: b.padBits||0,
      lenNlenBits: b.lenNlenBits||0,
      bodyBits,
      totalBits,
      tokens: tk.length,
      lit, match, raw,
      outBytes
    };
  });
}

export function renderBlocks(sidebar: HTMLElement, blocks: BlockInfo[], tokens: any[], maxLitBits: number) {
  sidebar.innerHTML = "";
  const summary = summarizeBlocks(blocks, tokens);

  // counts 凡例（全ブロック最大）
  let globalMaxCount = 0;
  for (const b of blocks) {
    const cnt = countLitsForBlock(tokens, b.index);
    globalMaxCount = Math.max(globalMaxCount, ...cnt);
  }
  updateCountLegend(globalMaxCount);

  const vizContainer = $("output");

  for (const s of summary) {
    const base = blocks.find(b=>b.index===s.index)!;
    const card = document.createElement("div"); card.className="block";
    const h = document.createElement("h3"); h.textContent = `Block #${s.index} [${s.type}] ${s.final?'- Final':''}`;
    card.appendChild(h);

    const chips = document.createElement("div"); chips.className="chipline";
    const add = (text:string)=>{ const c=document.createElement("span"); c.className="chip"; c.textContent=text; chips.appendChild(c); };
    add(`header ${s.headerBits}b`);
    if (s.type==='DYNAMIC') add(`dyn ${s.dynHeaderBits}b`);
    if (s.type==='RAW') { if (s.padBits) add(`pad ${s.padBits}b`); add(`LEN/NLEN ${s.lenNlenBits||32}b`); }
    add(`body ${s.bodyBits}b`);
    add(`total ${s.totalBits}b`);
    card.appendChild(chips);

    const note = document.createElement("div"); note.className="muteline";
    note.textContent = `tokens ${s.tokens} (lit ${s.lit} / match ${s.match} / raw ${s.raw}), out ${s.outBytes} bytes`;
    card.appendChild(note);

    // 各種ヒートマップ（bit長 / usage）
    if (s.type !== 'RAW' && base.trees.litLenCodeLengths) {
      const bitlens = bitlenFor0to127(base.trees.litLenCodeLengths);
      const presentMask = bitlens.map(bl => bl > 0);
      const showTextMask = Array.from({length:128}, (_,i)=> i>=0x20 && i<=0x7e);
      const counts = countLitsForBlock(tokens, s.index);
      const titleBuilderLit = (i:number)=> {
        const ch = (i>=0x20 && i<=0x7e) ? ` ('${String.fromCharCode(i)}')` : "";
        const bl = bitlens[i] || 0;
        const ct = counts[i] || 0;
        const blTxt = bl ? `${bl}b` : "—";
        const ctTxt = String(ct);
        return `code ${i}${ch}\nbit長: ${blTxt}\n使用回数: ${ctTxt}`;
      };
      const onClickLit = (i:number)=> {
        lockLitByCode(vizContainer, i, s.index);
      };
      const litBitsGrid = makeCodeGrid(
        "Literal 0–127 : bit-length heatmap（緑=短, 赤=長）",
        bitlens,
        (v)=>litBgFor(v || 1, maxLitBits),
        presentMask,
        showTextMask,
        titleBuilderLit,
        onClickLit
      );
      const litCountGrid = makeCodeGrid(
        "Literal 0–127 : usage count heatmap（小=赤, 大=緑）",
        counts,
        (v)=>countBgFor(v, Math.max(1, globalMaxCount)),
        counts.map(c => c>0),
        showTextMask,
        titleBuilderLit,
        onClickLit
      );

      // Length ranges
      const matches = tokens.filter(t=>t.blockIndex===s.index && t.type==='match');
      const lenEntriesAll:any[]=[];
      for(let idx=0; idx<=28; idx++){
        const sym=257+idx;
        let from:number, to:number;
        if(sym===285){ from=258; to=258; }
        else { from=LEN_BASE[idx]; const extra=LEN_EXTRA[idx]; to=from+((1<<extra)-1); }
        const label=from===to?`${from}`:`${from}-${to}`;
        const bitlen=base.trees.litLenCodeLengths?(base.trees.litLenCodeLengths[sym]|0):0;
        const count=matches.filter(m=>m.length>=from && m.length<=to).length;
        lenEntriesAll.push({label,bitlen,count,present:bitlen>0,from,to});
      }
      const lenBitEntries=lenEntriesAll.filter(e=>e.bitlen>0).map(e=>({...e,value:e.bitlen}));
      const lenCountEntries=lenEntriesAll.filter(e=>e.count>0).map(e=>({...e,value:e.count,present:true}));
      const maxLenBits=Math.max(1,...lenBitEntries.map(e=>e.value));
      const maxLenCount=Math.max(1,...lenCountEntries.map(e=>e.value));
      const titleBuilderLen=(e:any)=>{
        const blTxt=e.bitlen?`${e.bitlen}b`:'—';
        return `len ${e.label}\nbit長: ${blTxt}\n使用回数: ${e.count}`;
      };
      const lenBitsGrid=makeRangeGrid(
        "Len : bit-length heatmap（緑=短, 赤=長）",
        lenBitEntries,
        (v)=>litBgFor(v||1,maxLenBits),
        titleBuilderLen,
        (e:any)=>lockLengthRange(vizContainer,e.from,e.to,s.index)
      );
      const lenCountGrid=makeRangeGrid(
        "Len : usage count heatmap（小=赤, 大=緑）",
        lenCountEntries,
        (v)=>countBgFor(v,maxLenCount),
        titleBuilderLen,
        (e:any)=>lockLengthRange(vizContainer,e.from,e.to,s.index)
      );

      // Distance ranges
      const distEntriesAll:any[]=DIST_BASE.map((baseVal,sym)=>{
        const extra=DIST_EXTRA[sym];
        const from=baseVal; const to=baseVal+((1<<extra)-1);
        const bitlen=base.trees.distCodeLengths?(base.trees.distCodeLengths[sym]|0):0;
        const count=matches.filter(m=>m.distance>=from && m.distance<=to).length;
        const label=from===to?`${from}`:`${from}-${to}`;
        return {label,bitlen,count,present:bitlen>0,from,to};
      });
      const distBitEntries=distEntriesAll.filter(e=>e.bitlen>0).map(e=>({...e,value:e.bitlen}));
      const distCountEntries=distEntriesAll.filter(e=>e.count>0).map(e=>({...e,value:e.count,present:true}));
      const maxDistBits=Math.max(1,...distBitEntries.map(e=>e.value));
      const maxDistCount=Math.max(1,...distCountEntries.map(e=>e.value));
      const titleBuilderDist=(e:any)=>{
        const blTxt=e.bitlen?`${e.bitlen}b`:'—';
        return `dist ${e.label}\nbit長: ${blTxt}\n使用回数: ${e.count}`;
      };
      const distBitsGrid=makeRangeGrid(
        "Dist : bit-length heatmap（緑=短, 赤=長）",
        distBitEntries,
        (v)=>litBgFor(v||1,maxDistBits),
        titleBuilderDist,
        (e:any)=>lockDistanceRange(vizContainer,e.from,e.to,s.index)
      );
      const distCountGrid=makeRangeGrid(
        "Dist : usage count heatmap（小=赤, 大=緑）",
        distCountEntries,
        (v)=>countBgFor(v,maxDistCount),
        titleBuilderDist,
        (e:any)=>lockDistanceRange(vizContainer,e.from,e.to,s.index)
      );

      const bitsRow=document.createElement('div'); bitsRow.className='heatmap-row';
      const countsRow=document.createElement('div'); countsRow.className='heatmap-row';
      litBitsGrid.classList.add('hm-half');
      lenBitsGrid.classList.add('hm-third');
      distBitsGrid.classList.add('hm-sixth');
      litCountGrid.classList.add('hm-half');
      lenCountGrid.classList.add('hm-third');
      distCountGrid.classList.add('hm-sixth');
      bitsRow.append(litBitsGrid,lenBitsGrid,distBitsGrid);
      countsRow.append(litCountGrid,lenCountGrid,distCountGrid);
      card.append(bitsRow,countsRow);
    }

    // 長さ別シンボル表（ヒートマップの下）
    if (base.trees.litLenCodeLengths) card.appendChild(makeLenTable(s.type==='FIXED'?'Lit/Len (fixed)':'Lit/Len', base.trees.litLenCodeLengths, 'litlen'));
    if (base.trees.distCodeLengths)   card.appendChild(makeLenTable(s.type==='FIXED'?'Dist (fixed)':'Dist',     base.trees.distCodeLengths, 'dist'));

    sidebar.appendChild(card);
  }
}
