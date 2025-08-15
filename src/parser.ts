/* Parsing utilities */
const dec = new TextDecoder("utf-8", { fatal: false });

const u32be = (b: Uint8Array, off: number) => ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
export const u32beBytes = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

export function adler32(u8: Uint8Array) {
  const MOD = 65521; let a = 1, b = 0;
  for (let i = 0; i < u8.length; ) {
    const t = Math.min(3850, u8.length - i);
    for (let j = 0; j < t; j++) { a += u8[i++]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

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

export const LEN_BASE=[3,4,5,6,7,8,9,10, 11,13,15,17, 19,23,27,31, 35,43,51,59, 67,83,99,115, 131,163,195,227, 259];
export const LEN_EXTRA=[0,0,0,0,0,0,0,0, 1,1,1,1, 2,2,2,2, 3,3,3,3, 4,4,4,4, 5,5,5,5, 0];
export const DIST_BASE=[1,2,3,4, 5,7, 9,13, 17,25, 33,49, 65,97, 129,193, 257,385, 513,769, 1025,1537, 2049,3073, 4097,6145, 8193,12289, 16385,24577];
export const DIST_EXTRA=[0,0,0,0, 1,1, 2,2, 3,3, 4,4, 5,5, 6,6, 7,7, 8,8, 9,9, 10,10, 11,11, 12,12, 13,13];
const CODELEN_CODE_ORDER=[16,17,18, 0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

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

export type BlockInfo = {
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

export function parseDeflate(allBytes: Uint8Array, isRaw = false) {
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
        let length:number; let lenExtraBits=0; const lenCodeBits=dec2.bitsUsed;
        if (sym===285){ length=258; }
        else { const idx=sym-257; const base=LEN_BASE[idx]; const extra=LEN_EXTRA[idx]; const ext=extra?reader.readBits(extra):0; tokenBits+=extra; lenExtraBits=extra; length=base+ext; }
        const ddbg:any={}; const ddec=dist.decode(reader, ddbg); const dsym=ddec.symbol; tokenBits+=ddec.bitsUsed; const distCodeBits=ddec.bitsUsed;
        if (dsym>29) throw new Error(`不正な距離符号 dsym=${dsym} @block=${blockIndex}`);
        const dbase=DIST_BASE[dsym]; const dextra=DIST_EXTRA[dsym]; const dval=dextra?reader.readBits(dextra):0; tokenBits+=dextra; const distExtraBits=dextra;
        const distance=dbase+dval;
        const tStart=out.length;
        for (let i=0;i<length;i++){ const src=out.length-distance; if (src<0) throw new Error(`距離が出力境界を超過 dist=${distance} @block=${blockIndex}`); out.push(out[src]); }
        const seg=dec.decode(new Uint8Array(out.slice(tStart,tStart+length)));
        tokens.push({
          type:'match', text:seg, length, distance, bitsUsed:tokenBits,
          lenCodeBits, lenExtraBits, distCodeBits, distExtraBits,
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

