/* ============================== imports ============================== */
import ace from "ace-builds/src-noconflict/ace";
import "ace-builds/src-noconflict/mode-python";
import "ace-builds/src-noconflict/theme-monokai";

/* ここからは zopfli_worker を動的インポートで使う */
type ZopfliFn = (input: Uint8Array, numIterations?: number) => Promise<Uint8Array>;
let _zopfliFn: ZopfliFn | null = null;
async function getZopfli(): Promise<ZopfliFn> {
  if (_zopfliFn) return _zopfliFn;
  try {
    // 現在のスクリプトURLからベースパスを取得し、それを基にパスを組み立て
    const scriptUrl = new URL(import.meta.url);
    let base = "/";
    if (scriptUrl.host.endsWith("github.io")) {
      base = scriptUrl.pathname.split('/').slice(0, 2).join('/') + '/';
    }
    // リポ内の Worker ラッパ（GZIPを返す想定）
    const mod: any = await import(`${base}gzip_zopfli_worker.mjs`);
    if (!mod || typeof mod.zopfli !== "function") {
      throw new Error("zopfli_worker.mjs の読み込みに失敗（zopfliが見つかりません）");
    }
    _zopfliFn = mod.zopfli as ZopfliFn;
    return _zopfliFn!;
  } catch (e: any) {
    console.error("zopfli_worker.mjs のロードに失敗:", e);
    throw new Error(`zopfli_worker.mjs の読み込みに失敗: ${e.message || e}`);
  }
}

/* ============================== helpers ============================== */
const $ = (id: string) => document.getElementById(id)!;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

const hexToBytes = (hex: string) => {
  const cleaned = (hex || "").replace(/[^0-9a-fA-F]/g, "");
  if (!cleaned) return new Uint8Array([]);
  if (cleaned.length % 2) throw new Error("16進文字列の長さが奇数です");
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return out;
};
const bytesToHex = (u8: Uint8Array) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const b64enc = (u8: Uint8Array) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const b64dec = (b64: string) => { const bin = atob((b64 || "").trim()); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const u32be = (b: Uint8Array, off: number) => ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
const u32beBytes = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

/* ============================== Adler-32 ============================== */
function adler32(u8: Uint8Array) {
  const MOD = 65521; let a = 1, b = 0;
  for (let i = 0; i < u8.length; ) {
    const t = Math.min(3850, u8.length - i);
    for (let j = 0; j < t; j++) { a += u8[i++]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/* ============================== BitReader (LSB-first) ============================== */
class BitReader {
  bytes: Uint8Array; bitPos: number;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.bitPos = 0; }
  ensure(n: number) { if (this.bitPos + n > this.bytes.length * 8) throw new Error("ビット列が足りません（不正/切り詰め）"); }
  readBits(n: number) {
    this.ensure(n);
    let val = 0, shift = 0;
    while (n > 0) {
      const i = this.bitPos >>> 3, inner = this.bitPos & 7, take = Math.min(n, 8 - inner);
      const cur = this.bytes[i] >>> inner;
      val |= (cur & ((1 << take) - 1)) << shift;
      this.bitPos += take; shift += take; n -= take;
    }
    return val >>> 0;
  }
  readByteAligned() { if (this.bitPos & 7) this.bitPos += 8 - (this.bitPos & 7); }
  tellBits() { return this.bitPos; }
}

/* ============================== 正規化ハフマン ============================== */
function bitReverse(v: number, w: number) { let r = 0; for (let i = 0; i < w; i++) { r = (r << 1) | (v & 1); v >>>= 1; } return r >>> 0; }
function buildCanonical(codeLengths: number[]) {
  const maxBits = Math.max(0, ...codeLengths);
  const bl_count = new Array(maxBits + 1).fill(0);
  for (const bl of codeLengths) if (bl > 0) bl_count[bl]++;
  const next_code = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) { code = (code + bl_count[bits - 1]) << 1; next_code[bits] = code; }
  const lookup: Array<Record<string, number> | undefined> = new Array(maxBits + 1);
  const codeMap: any[] = [];
  for (let sym = 0; sym < codeLengths.length; sym++) {
    const len = codeLengths[sym];
    if (len > 0) {
      const c = next_code[len]++; const lsb = bitReverse(c, len);
      if (!lookup[len]) lookup[len] = Object.create(null);
      (lookup[len] as any)[lsb] = sym;
      codeMap.push({ symbol: sym, bitlen: len, msbCode: c, lsbCode: lsb });
    }
  }
  return { lookup, maxBits, codeMap };
}
class HuffmanLSB {
  lookup: Array<Record<string, number> | undefined>; maxBits: number; codeMap: any[];
  constructor(codeLengths: number[]) { const { lookup, maxBits, codeMap } = buildCanonical(codeLengths); this.lookup = lookup; this.maxBits = maxBits; this.codeMap = codeMap; }
  decode(reader: BitReader, dbg?: any) {
    const start = reader.tellBits(); let accum = 0;
    for (let len = 1; len <= this.maxBits; len++) {
      const bit = reader.readBits(1); accum |= bit << (len - 1);
      const tbl = this.lookup[len];
      if (tbl) { const sym = (tbl as any)[accum]; if (sym !== undefined) { if (dbg) dbg.decodedAt = { start, used: len }; return { symbol: sym, bitsUsed: len }; } }
    }
    const pos = reader.tellBits();
    throw new Error(`ハフマン木の不整合（不正な符号列） @bit=${pos - 1} depth>=${this.maxBits} (start=${start})`);
  }
}

/* ============================== RFC1951 定数 ============================== */
const LEN_BASE=[3,4,5,6,7,8,9,10, 11,13,15,17, 19,23,27,31, 35,43,51,59, 67,83,99,115, 131,163,195,227, 259];
const LEN_EXTRA=[0,0,0,0,0,0,0,0, 1,1,1,1, 2,2,2,2, 3,3,3,3, 4,4,4,4, 5,5,5,5, 0];
const DIST_BASE=[1,2,3,4, 5,7, 9,13, 17,25, 33,49, 65,97, 129,193, 257,385, 513,769, 1025,1537, 2049,3073, 4097,6145, 8193,12289, 16385,24577];
const DIST_EXTRA=[0,0,0,0, 1,1, 2,2, 3,3, 4,4, 5,5, 6,6, 7,7, 8,8, 9,9, 10,10, 11,11, 12,12, 13,13];
const CODELEN_CODE_ORDER=[16,17,18, 0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

/* ============================== zlibヘッダ検出 ============================== */
function parseMaybeZlibHeader(bytes: Uint8Array) {
  if (bytes.length >= 2) {
    const cmf = bytes[0], flg = bytes[1];
    const cm = cmf & 0x0f; const check = ((cmf << 8) + flg) % 31;
    if (cm === 8 && check === 0) {
      const fdict = (flg >>> 5) & 1; let pos = 2;
      if (fdict) { if (bytes.length < 6) throw new Error("zlibヘッダFDICT指定だが不足"); pos += 4; }
      if (bytes.length < pos + 6) throw new Error("zlibヘッダ以降が短すぎます");
      return { isZlib: true, start: pos, adlerAt: bytes.length - 4, cmf, flg };
    }
  }
  return { isZlib: false, start: 0, adlerAt: -1 };
}

/* ============================== DEFLATE パーサ ============================== */
type BlockInfo = {
  index: number;
  BFINAL: number;
  BTYPE: number;
  headerBitsUsed: number;
  dynamicHeaderBits: number;
  padBits?: number;
  lenNlenBits?: number;
  trees: {
    fixed?: boolean;
    litLenCodeLengths?: number[];
    distCodeLengths?: number[];
    codeLenCodeLengths?: number[];
    params?: { HLIT: number; HDIST: number; HCLEN: number };
  };
  notes: string[];
};
function parseDeflate(allBytes: Uint8Array, isRaw = false) {
  let start = 0, adlerAt = -1, zlib = false;
  if (!isRaw) {
    const z = parseMaybeZlibHeader(allBytes);
    if (z.isZlib) { zlib = true; start = z.start; adlerAt = z.adlerAt; }
  }
  const body = allBytes.subarray(start, adlerAt >= 0 ? adlerAt : allBytes.length);
  const reader = new BitReader(body);

  const tokens: any[] = [];
  const blocks: BlockInfo[] = [];
  const out: number[] = [];
  let blockIndex = 0;

  outer: while (true) {
    const blockStartBits = reader.tellBits();
    const BFINAL = reader.readBits(1);
    const BTYPE  = reader.readBits(2);
    const headerBitsUsed = reader.tellBits() - blockStartBits;
    const blockInfo: BlockInfo = { index:blockIndex, BFINAL, BTYPE, headerBitsUsed, dynamicHeaderBits:0, trees:{}, notes:[] };

    if (BTYPE === 3) throw new Error(`BTYPE=3 (予約) は不正なストリームです @block=${blockIndex}`);

    if (BTYPE === 0) {
      const beforeAlign = reader.tellBits();
      const pad = (8 - (beforeAlign & 7)) & 7;
      reader.readByteAligned();
      const len = reader.readBits(16), nlen = reader.readBits(16);
      if (((len ^ 0xffff) & 0xffff) !== nlen) throw new Error(`非圧縮ブロック LEN/NLEN 不一致 @block=${blockIndex}`);
      const tStart = out.length;
      const buf = new Uint8Array(len);
      for (let i=0;i<len;i++){ reader.ensure(8); buf[i]=reader.readBits(8); out.push(buf[i]); }
      const seg = dec.decode(buf);
      tokens.push({ type:'raw', text:seg, length:len, distance:null, bitsUsed:len*8, blockIndex, spanStart:tStart, spanEnd:tStart+len, bitStart:blockStartBits, bitEnd:reader.tellBits(), detail:`RAW` });
      blocks.push(Object.assign(blockInfo, { padBits: pad, lenNlenBits: 32 }));
      if (BFINAL) break outer; blockIndex++; continue;
    }

    let litLen: HuffmanLSB, dist: HuffmanLSB;
    if (BTYPE === 1) {
      const litLenLen=new Array(288).fill(0);
      for(let i=0;i<=143;i++) litLenLen[i]=8;
      for(let i=144;i<=255;i++) litLenLen[i]=9;
      for(let i=256;i<=279;i++) litLenLen[i]=7;
      for(let i=280;i<=287;i++) litLenLen[i]=8;
      const distLen=new Array(32).fill(5);
      litLen = new HuffmanLSB(litLenLen);
      dist   = new HuffmanLSB(distLen);
      blockInfo.trees.fixed=true;
      blockInfo.trees.litLenCodeLengths = litLenLen;
      blockInfo.trees.distCodeLengths   = distLen;
    } else {
      const dynStart=reader.tellBits();
      const HLIT = reader.readBits(5)+257;
      const HDIST= reader.readBits(5)+1;
      const HCLEN= reader.readBits(4)+4;

      const codeLenCodeLengths=new Array(19).fill(0);
      for(let i=0;i<HCLEN;i++) codeLenCodeLengths[CODELEN_CODE_ORDER[i]] = reader.readBits(3);
      const codeLenTree = new HuffmanLSB(codeLenCodeLengths);

      const total=HLIT+HDIST; const lengths:number[]=[];
      while(lengths.length<total){
        const dec1=codeLenTree.decode(reader);
        const sym=dec1.symbol;
        if (sym<=15){ lengths.push(sym); }
        else if (sym===16){
          if (lengths.length===0) throw new Error(`コード長16の前に値が必要 @block=${blockIndex}`);
          const repeat=reader.readBits(2)+3; const prev=lengths[lengths.length-1];
          for(let i=0;i<repeat;i++) lengths.push(prev);
        } else if (sym===17){
          const repeat=reader.readBits(3)+3; for(let i=0;i<repeat;i++) lengths.push(0);
        } else if (sym===18){
          const repeat=reader.readBits(7)+11; for(let i=0;i<repeat;i++) lengths.push(0);
        } else throw new Error(`不正なコード長符号 sym=${sym} @block=${blockIndex}`);
      }
      const litLens=lengths.slice(0,HLIT);
      const distLens=lengths.slice(HLIT,HLIT+HDIST);
      const distLensFixed = distLens.every(v=>v===0) ? (()=>{const a=distLens.slice(); a[0]=1; return a;})() : distLens;
      litLen = new HuffmanLSB(litLens);
      dist   = new HuffmanLSB(distLensFixed);

      blockInfo.dynamicHeaderBits = reader.tellBits()-dynStart;
      blockInfo.trees.fixed=false;
      blockInfo.trees.params={HLIT,HDIST,HCLEN};
      blockInfo.trees.codeLenCodeLengths=codeLenCodeLengths;
      blockInfo.trees.litLenCodeLengths =litLens;
      blockInfo.trees.distCodeLengths   =distLens;
    }

    while(true){
      const ldbg:any={}; const dec2=litLen.decode(reader, ldbg);
      const sym=dec2.symbol; let tokenBits=dec2.bitsUsed;

      if (sym<256){
        const tStart=out.length; out.push(sym);
        const txt=dec.decode(new Uint8Array([sym]));
        tokens.push({
          type:'lit', text:txt, length:1, distance:null, bitsUsed:tokenBits,
          blockIndex, spanStart:tStart, spanEnd:tStart+1,
          bitStart:ldbg.decodedAt.start, bitEnd:ldbg.decodedAt.start+tokenBits,
          detail:`LIT`, litCode: sym
        });
      } else if (sym===256){
        blocks.push(blockInfo);
        if (blockInfo.BFINAL) { break outer; }
        blockIndex++; break;
      } else {
        if (sym>285) throw new Error(`不正な長さ符号 sym=${sym} @block=${blockIndex}`);
        let length:number;
        if (sym===285){ length=258; }
        else { const idx=sym-257; const base=LEN_BASE[idx]; const extra=LEN_EXTRA[idx]; const ext=extra?reader.readBits(extra):0; tokenBits+=extra; length=base+ext; }
        const ddbg:any={}; const ddec=dist.decode(reader, ddbg); const dsym=ddec.symbol; tokenBits+=ddec.bitsUsed;
        if (dsym>29) throw new Error(`不正な距離符号 dsym=${dsym} @block=${blockIndex}`);
        const dbase=DIST_BASE[dsym]; const dextra=DIST_EXTRA[dsym]; const dval=dextra?reader.readBits(dextra):0; tokenBits+=dextra;
        const distance=dbase+dval;
        const tStart=out.length;
        for (let i=0;i<length;i++){ const src=out.length-distance; if (src<0) throw new Error(`距離が出力境界を超過 dist=${distance} @block=${blockIndex}`); out.push(out[src]); }
        const seg=dec.decode(new Uint8Array(out.slice(tStart,tStart+length)));
        tokens.push({
          type:'match', text:seg, length, distance, bitsUsed:tokenBits,
          blockIndex, spanStart:tStart, spanEnd:tStart+length,
          bitStart:ddbg.decodedAt?ddbg.decodedAt.start:(ldbg.decodedAt.start+dec2.bitsUsed),
          bitEnd:reader.tellBits(), detail:`MATCH`
        });
      }
    }
  }

  const outputBytes=new Uint8Array(out);
  let zlibNote = '';
  if (!isRaw){
    const z = parseMaybeZlibHeader(allBytes);
    const adlerExpected=u32be(allBytes, z.adlerAt);
    const adlerActual=adler32(outputBytes);
    zlibNote = (adlerExpected===adlerActual)
      ? `zlib Adler32 OK (0x${adlerActual.toString(16).padStart(8,'0')})`
      : `zlib Adler32 不一致 expected=0x${adlerExpected.toString(16).padStart(8,'0')} actual=0x${adlerActual.toString(16).padStart(8,'0')}`;
  }
  return {tokens,blocks,outputBytes,zlib:!isRaw,zlibNote};
}

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
/** counts 用の同系グラデーション（小=赤 → 大=緑） */
function countBgFor(count: number, maxCount: number) {
  if (maxCount <= 0) return `hsl(0deg 0% 18% / .0)`;
  const denom = Math.max(1, maxCount - 1);
  const t = Math.max(0, Math.min(1, (count - 1) / denom));
  const hue = 120 * t; // 0(赤) → 120(緑)
  const light = (count % 2 === 0) ? 32 : 26;
  return `hsl(${hue}deg 75% ${light}% / .55)`;
}

/** LIT 凡例（ビット長スケール）更新 */
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

/** 使用回数凡例（0〜maxCount, 小=赤→大=緑）更新 */
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
  // 参照元文字を強調
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
    // 同一トークン（断片）を同時強調
    if (ruby.dataset.tokenId === tokenId) ruby.classList.add('ref-target', 'same-token');
  }
}

/* ======== クリック固定ハイライト（トークン／コードセル） ======== */
let locked = false;
function lockClear(container: HTMLElement) {
  locked = false;
  clearHighlights(container);
}
function lockToken(container: HTMLElement, tokenId: string, type: string) {
  locked = true;
  // 同一トークン断片
  container.querySelectorAll<HTMLElement>(`ruby.tok[data-token-id="${tokenId}"]`)
    .forEach(el => el.classList.add("same-token","hit","ref-target"));
  // 参照 (MATCH)
  if (type === "match") {
    const any = container.querySelector<HTMLElement>(`ruby.tok[data-token-id="${tokenId}"]`);
    if (any) {
      const rs = parseInt(any.dataset.refStart || "-1", 10);
      const re = parseInt(any.dataset.refEnd   || "-1", 10);
      if (rs >= 0 && re > rs) applyHighlight(container, rs, re, tokenId);
    }
  }
}
function lockLitByCode(container: HTMLElement, code: number, blockIndex: number|null = null) {
  locked = true;
  clearHighlights(container);
  const sel = blockIndex==null
    ? `ruby.tok.lit[data-lit="${code}"]`
    : `ruby.tok.lit[data-lit="${code}"][data-block-index="${blockIndex}"]`;
  container.querySelectorAll<HTMLElement>(sel).forEach(el=>{
    el.classList.add("hit","same-token","ref-target");
  });
}

/* ============================== トークン描画 ============================== */
function renderOutput(container: HTMLElement, tokens: any[], blocks: BlockInfo[]): number {
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
        ch.textContent = p[i];
        rb.appendChild(ch);
      }

      // ルビ（下側）
      const rt = document.createElement("rt");
      const head = t.type === 'lit' ? 'LIT' : t.type === 'match' ? 'MATCH' : 'RAW';
      rt.textContent = `${head} ${t.type==='match' ? `(L=${t.length},D=${t.distance})` : `(L=${t.length})`}  ${t.bitsUsed}b`;

      ruby.append(rb, rt);
      container.appendChild(ruby);

      // ホバー：同一トークン断片 + 参照（MATCH）
      ruby.addEventListener("mouseenter", (ev) => {
        if (locked) return; // ロック中は hover 無効
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
function rangesWithAscii(nums: number[], annotateForLiteralOnly: boolean) {
  if (nums.length === 0) return "";
  const a = Array.from(new Set(nums)).sort((x,y)=>x-y);
  const out: string[] = [];
  let s = a[0], p = a[0];
  const push = (start: number, end: number) => {
    let base = (start === end) ? `${start}` : `${start}–${end}`;
    if (annotateForLiteralOnly) {
      const loClamp = Math.max(0x20, start);
      const hiClamp = Math.min(0x7e, end);
      if (end >= 0 && start <= 255 && hiClamp >= loClamp) {
        base += ` (${asciiAnnotationForRange(start, end)})`;
      }
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

/* ============================== makeLenTable（復活） ============================== */
function makeLenTable(title: string, codeLengths?: number[], isLitLen = false) {
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
    td3.textContent = rangesWithAscii(syms, isLitLen); // ASCII注釈
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
const tooltip = (() => {
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

function renderBlocks(sidebar: HTMLElement, blocks: BlockInfo[], tokens: any[], maxLitBits: number) {
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

    // 0..127 ヒートマップ（bit長 / count）— テーブルより上
    if (s.type !== 'RAW' && base.trees.litLenCodeLengths) {
      const bitlens = bitlenFor0to127(base.trees.litLenCodeLengths);
      const presentMask = bitlens.map(bl => bl > 0);
      const showTextMask = Array.from({length:128}, (_,i)=> i>=0x20 && i<=0x7e);
      const counts = countLitsForBlock(tokens, s.index);
      const titleBuilder = (i:number)=> {
        const ch = (i>=0x20 && i<=0x7e) ? ` ('${String.fromCharCode(i)}')` : "";
        const bl = bitlens[i] || 0;
        const ct = counts[i] || 0;
        const blTxt = bl ? `${bl}b` : "—";
        const ctTxt = String(ct);
        return `code ${i}${ch}\nbit長: ${blTxt}\n使用回数: ${ctTxt}`;
      };
      const onClick = (i:number)=> {
        lockLitByCode(vizContainer, i, s.index);
      };

      const gridBits = makeCodeGrid(
        "Literal 0–127 : bit-length heatmap（緑=短, 赤=長）",
        bitlens,
        (v)=>litBgFor(v || 1, maxLitBits),
        presentMask,
        showTextMask,
        titleBuilder,
        onClick
      );
      card.appendChild(gridBits);

      const gridCounts = makeCodeGrid(
        "Literal 0–127 : usage count heatmap（小=赤, 大=緑）",
        counts,
        (v)=>countBgFor(v, Math.max(1, globalMaxCount)),
        counts.map(c => c>0),
        showTextMask,
        titleBuilder,
        onClick
      );
      card.appendChild(gridCounts);
    }

    // 長さ別シンボル表（ヒートマップの下）
    if (base.trees.litLenCodeLengths) card.appendChild(makeLenTable(s.type==='FIXED'?'Lit/Len (fixed)':'Lit/Len', base.trees.litLenCodeLengths, true));
    if (base.trees.distCodeLengths)   card.appendChild(makeLenTable(s.type==='FIXED'?'Dist (fixed)':'Dist',     base.trees.distCodeLengths, false));

    sidebar.appendChild(card);
  }
}

/* ============================== Zopfli 圧縮：Worker 出力(GZIP)→DEFLATE抽出→zlib再パック ============================== */
function extractDeflateFromGzip(gz: Uint8Array): Uint8Array {
  if (gz.length < 18) throw new Error("gzipが短すぎます");
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8) throw new Error("gzipヘッダ不正または非DEFLATE");
  const FLG = gz[3];
  let off = 10; // ID1 ID2 CM FLG MTIME(4) XFL OS
  const need = (n: number) => { if (off + n > gz.length) throw new Error("gzipヘッダ切り詰め"); };
  if (FLG & 0x04) { // FEXTRA
    need(2); const xlen = gz[off] | (gz[off+1] << 8); off += 2; need(xlen); off += xlen;
  }
  if (FLG & 0x08) { // FNAME
    while (off < gz.length && gz[off++] !== 0) {/*skip*/}
  }
  if (FLG & 0x10) { // FCOMMENT
    while (off < gz.length && gz[off++] !== 0) {/*skip*/}
  }
  if (FLG & 0x02) { // FHCRC
    need(2); off += 2;
  }
  if (off > gz.length - 8) throw new Error("gzipボディが存在しません");
  return gz.subarray(off, gz.length - 8); // 末尾8B（CRC32, ISIZE）除外
}
function wrapZlib(deflateRaw: Uint8Array, adler: number): Uint8Array {
  const zhead = new Uint8Array([0x78, 0x9c]); // 32KB窓 & 既定圧縮（FCHECK整合）
  const tail  = u32beBytes(adler);
  const out = new Uint8Array(2 + deflateRaw.length + 4);
  out.set(zhead, 0);
  out.set(deflateRaw, 2);
  out.set(tail, 2 + deflateRaw.length);
  return out;
}
async function zopfliCompressWithWorker(input: Uint8Array, raw: boolean, numIterations = 10): Promise<Uint8Array> {
  const zopfli = await getZopfli();
  const gz = await zopfli(input, numIterations); // Worker は GZIP を返す
  const deflateRaw = extractDeflateFromGzip(gz);
  if (raw) return deflateRaw;
  const ad = adler32(input);
  return wrapZlib(deflateRaw, ad);
}

/* ============================== Ace Editor 初期化 ============================== */
const editor = ace.edit("editor", {
  mode: "ace/mode/python",
  theme: "ace/theme/monokai",
  fontSize: "15px",
  showPrintMargin: false,
  wrap: true,
  useWorker: false
});
const fitEditor = () => {
  const wrap = document.getElementById("editorWrap")!;
  const h = wrap.clientHeight;
  (document.getElementById("editor") as HTMLElement).style.height = Math.max(120, h - 4) + "px";
  editor.resize();
};
new ResizeObserver(fitEditor).observe(document.getElementById("editorWrap")!);
window.addEventListener("resize", fitEditor);
fitEditor();

/* ============================== UI要素 ============================== */
const elHex = $("hex") as HTMLTextAreaElement;
const elB64 = $("b64") as HTMLInputElement;
const elRaw = $("rawMode") as HTMLInputElement;
const elBlocks = $("blocks") as HTMLDivElement;
const elZlibNote = $("zlibNote") as HTMLDivElement;
const outDiv = $("output") as HTMLDivElement;
const errDiv = $("error") as HTMLSpanElement;
const okDiv = $("success") as HTMLSpanElement;
const paneIO = $("pane-io") as HTMLDivElement;
const elIter = $("iter") as HTMLInputElement;
const elIterVal = $("iterVal") as HTMLSpanElement;

const setErr = (m: string) => { errDiv.textContent = m; errDiv.classList.remove("hidden"); okDiv.classList.add("hidden"); };
const setOk  = (m: string) => { okDiv .textContent = m; okDiv .classList.remove("hidden"); errDiv.classList.add("hidden"); };
const clearMsgs=()=>{ errDiv.classList.add("hidden"); errDiv.textContent=''; okDiv.classList.add("hidden"); okDiv.textContent=''; };

/* ============================== エディタ同期（再帰抑止） ============================== */
let isProgrammaticEditorUpdate = false;
let lastCompressedB64: string | null = null;

/* ============================== 圧縮→可視化 ============================== */
let compressTimer: number | null = null as any;
async function compressFromEditorAndVisualize() {
  if (isProgrammaticEditorUpdate) return; // プログラム更新中はスキップ
  clearMsgs();
  try{
    const text = editor.getValue();
    const input = enc.encode(text);
    const raw = elRaw.checked;
    const iters = Math.max(1, Math.min(1000, parseInt(elIter.value || "10", 10) || 10));

    const comp = await zopfliCompressWithWorker(input, raw, iters);
    const compB64 = b64enc(comp);

    // 入力欄に反映
    elHex.value = bytesToHex(comp);
    elB64.value = compB64;

    // 解析して可視化
    const {tokens,blocks,outputBytes,zlib,zlibNote} = parseDeflate(comp, raw);
    const maxLitBits = renderOutput(outDiv, tokens, blocks);
    renderBlocks(elBlocks, blocks, tokens, maxLitBits);
    elZlibNote.textContent = zlib ? zlibNote : '';

    const decoded = dec.decode(outputBytes);

    // 圧縮バイト列が変化した場合のみ、エディタを更新（再帰抑止）
    if (lastCompressedB64 !== compB64) {
      lastCompressedB64 = compB64;
      if (editor.getValue() !== decoded) {
        isProgrammaticEditorUpdate = true;
        editor.setValue(decoded, -1);
        isProgrammaticEditorUpdate = false;
      }
    }

    setOk(`復号長: ${outputBytes.length} bytes / 文字列長: ${decoded.length} chars / トークン: ${tokens.length} / ブロック: ${blocks.length} / deflate: ${comp.length} bytes`);
  }catch(e:any){
    console.error(e);
    setErr(String(e && e.message ? e.message : e));
  }
}
const debounceCompress = ()=>{ if (compressTimer) clearTimeout(compressTimer); compressTimer = window.setTimeout(compressFromEditorAndVisualize, 300); };

/* エディタ変更/トグル変更/イテレーション変更で再圧縮 */
(editor.session as any).on("change", ()=>{
  if (isProgrammaticEditorUpdate) return;
  debounceCompress();
});
elRaw.addEventListener("change", debounceCompress);
elIter.addEventListener("input", ()=>{
  elIterVal.textContent = String(elIter.value);
  debounceCompress();
});

/* ============================== 入力→解析（手動解析ボタン） ============================== */
$("btn-parse")!.addEventListener("click", ()=>{
  clearMsgs();
  try{
    const raw = elRaw.checked;
    let bytes: Uint8Array | null = null;
    if (elHex.value.trim()) bytes = hexToBytes(elHex.value);
    else if (elB64.value.trim()) bytes = b64dec(elB64.value);
    else throw new Error("入力が空です。16進かBase64を指定してください。");

    const {tokens,blocks,outputBytes,zlib,zlibNote} = parseDeflate(bytes, raw);
    const maxLitBits = renderOutput(outDiv, tokens, blocks);
    renderBlocks(elBlocks, blocks, tokens, maxLitBits);
    elZlibNote.textContent = zlib ? zlibNote : '';

    const decoded = dec.decode(outputBytes);
    const nowB64 = b64enc(bytes);
    if (lastCompressedB64 !== nowB64) lastCompressedB64 = nowB64;

    if (editor.getValue() !== decoded) {
      isProgrammaticEditorUpdate = true;
      editor.setValue(decoded, -1);
      isProgrammaticEditorUpdate = false;
    }

    setOk(`復号長: ${outputBytes.length} bytes / 文字列長: ${decoded.length} chars / トークン: ${tokens.length} / ブロック: ${blocks.length} / deflate: ${bytes.length} bytes`);
  }catch(e:any){ console.error(e); setErr(String(e && e.message ? e.message : e)); }
});

/* ============================== ファイル読み込み（クリック & ドラッグ＆ドロップ） ============================== */
$("btn-file")!.addEventListener("click", ()=> $("fileInput")!.click());
$("fileInput")!.addEventListener("change", async (ev:any)=>{
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  await handleFile(f);
  (ev.target as HTMLInputElement).value = "";
});
["dragenter","dragover"].forEach(evName=>{
  document.addEventListener(evName, (e)=>{ e.preventDefault(); paneIO.classList.add("drop"); });
});
["dragleave","drop"].forEach(evName=>{
  document.addEventListener(evName, (e)=>{ e.preventDefault(); paneIO.classList.remove("drop"); });
});
document.addEventListener("drop", async (e: DragEvent)=>{
  const dt = e.dataTransfer; if (!dt) return;
  if (dt.files && dt.files.length>0) {
    await handleFile(dt.files[0]);
  }
});
async function handleFile(f: File){
  clearMsgs();
  try{
    const buf = new Uint8Array(await f.arrayBuffer());
    const raw = elRaw.checked;
    elHex.value = bytesToHex(buf);
    elB64.value = b64enc(buf);
    const {tokens,blocks,outputBytes,zlib,zlibNote} = parseDeflate(buf, raw);
    const maxLitBits = renderOutput(outDiv, tokens, blocks);
    renderBlocks(elBlocks, blocks, tokens, maxLitBits);
    elZlibNote.textContent = zlib ? zlibNote : '';

    const decoded = dec.decode(outputBytes);
    if (editor.getValue() !== decoded) {
      isProgrammaticEditorUpdate = true;
      editor.setValue(decoded, -1);
      isProgrammaticEditorUpdate = false;
    }

    lastCompressedB64 = b64enc(buf);
    setOk(`復号長: ${outputBytes.length} bytes / 文字列長: ${decoded.length} chars / トークン: ${tokens.length} / ブロック: ${blocks.length} / deflate: ${buf.length} bytes / ファイル: ${f.name}`);
  }catch(e:any){ console.error(e); setErr(String(e && e.message ? e.message : e)); }
}

/* ============================== 共有（URL生成） ============================== */
function currentURLWithParams(): string {
  const raw = elRaw.checked ? "1" : "0";
  const b64 = (elB64.value || "").trim();
  const q = new URLSearchParams();
  if (b64) q.set("deflate", b64);
  else {
    const text = editor.getValue();
    const t64 = btoa(unescape(encodeURIComponent(text)));
    q.set("text", t64);
  }
  if (raw === "1") q.set("raw", "1");
  return `${location.origin}${location.pathname}?${q.toString()}`;
}
$("btn-share")!.addEventListener("click", async ()=>{
  try{
    const url = currentURLWithParams();
    if ((navigator as any).share) {
      await (navigator as any).share({ title:"Deflate可視化", url });
      setOk("共有ダイアログを開きました");
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      setOk("URLをクリップボードにコピーしました");
    } else {
      history.replaceState(null, "", url);
      setOk("URLを更新しました");
    }
  }catch(e:any){ console.error(e); setErr(String(e && e.message ? e.message : e)); }
});

/* ============================== URL復元（初期） ============================== */
(function restoreFromURL(){
  const q = new URLSearchParams(location.search);
  // 既定 raw=1（指定があればそれを優先）
  const rawParam = q.get("raw");
  const raw = rawParam ? (rawParam === "1") : true;
  elRaw.checked = raw;

  const t = q.get("text");   // 平文（UTF-8 Base64）
  const d = q.get("deflate");// 圧縮（Base64）
  if (t){
    try{
      const text = decodeURIComponent(escape(atob(t)));
      isProgrammaticEditorUpdate = true;
      editor.setValue(text, -1);
      isProgrammaticEditorUpdate = false;
      elIterVal.textContent = String(elIter.value || "10");
      debounceCompress();
      return;
    }catch(e){ console.warn("text デコード失敗", e); }
  }
  if (d){
    try{
      const bytes = b64dec(d);
      elB64.value = d;
      elHex.value = bytesToHex(bytes);
      lastCompressedB64 = d;
      $("btn-parse")!.click();
      return;
    }catch(e){ console.warn("deflate デコード失敗", e); }
  }
  // 何も指定がなければエディタ内容から自動圧縮
  elIterVal.textContent = String(elIter.value || "10");
  debounceCompress();
})();

/* ============================== グローバル：クリックでロック解除 / ESCで解除 ============================== */
document.addEventListener("click", (e)=>{
  const out = $("output");
  // ブロック側のセルクリックは stopPropagation 済み。その他は解除。
  lockClear(out);
  tooltip.hide();
});
document.addEventListener("keydown", (e)=>{
  if (e.key === "Escape") {
    lockClear($("output"));
    tooltip.hide();
  }
});
