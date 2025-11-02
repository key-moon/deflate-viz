import { adler32, u32beBytes } from "./parser";

export type ZopfliFn = (input: Uint8Array, numIterations?: number) => Promise<Uint8Array>;
let _zopfliFn: ZopfliFn | null = null;
export async function getZopfli(): Promise<ZopfliFn> {
  if (_zopfliFn) return _zopfliFn;
  try {
    const scriptUrl = new URL(import.meta.url);
    let base = "/";
    if (scriptUrl.host.endsWith("github.io")) {
      base = scriptUrl.pathname.split('/').slice(0, 2).join('/') + '/';
    }
    const mod: any = await import(`${base}gzip_zopfli_worker.mjs`);
    if (!mod || typeof mod.zopfli !== "function") {
      throw new Error("Failed to load zopfli_worker.mjs (zopfli not found)");
    }
    _zopfliFn = mod.zopfli as ZopfliFn;
    return _zopfliFn!;
  } catch (e: any) {
    console.error("Failed to load zopfli_worker.mjs:", e);
    throw new Error(`Failed to import zopfli_worker.mjs: ${e.message || e}`);
  }
}

function extractDeflateFromGzip(gz: Uint8Array): Uint8Array {
  if (gz.length < 18) throw new Error("gzip is too short");
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8) throw new Error("Invalid gzip header or not DEFLATE");
  const FLG = gz[3];
  let off = 10; // ID1 ID2 CM FLG MTIME(4) XFL OS
  const need = (n: number) => { if (off + n > gz.length) throw new Error("Truncated gzip header"); };
  if (FLG & 0x04) {
    need(2); const xlen = gz[off] | (gz[off+1] << 8); off += 2; need(xlen); off += xlen;
  }
  if (FLG & 0x08) {
    while (off < gz.length && gz[off++] !== 0) {/*skip*/}
  }
  if (FLG & 0x10) {
    while (off < gz.length && gz[off++] !== 0) {/*skip*/}
  }
  if (FLG & 0x02) {
    need(2); off += 2;
  }
  if (off > gz.length - 8) throw new Error("No gzip body found");
  return gz.subarray(off, gz.length - 8);
}

function wrapZlib(deflateRaw: Uint8Array, adler: number): Uint8Array {
  const zhead = new Uint8Array([0x78, 0x9c]);
  const tail  = u32beBytes(adler);
  const out = new Uint8Array(2 + deflateRaw.length + 4);
  out.set(zhead, 0);
  out.set(deflateRaw, 2);
  out.set(tail, 2 + deflateRaw.length);
  return out;
}

export async function zopfliCompressWithWorker(input: Uint8Array, raw: boolean, numIterations = 10): Promise<Uint8Array> {
  const zopfli = await getZopfli();
  const gz = await zopfli(input, numIterations); // Worker returns GZIP
  const deflateRaw = extractDeflateFromGzip(gz);
  if (raw) return deflateRaw;
  const ad = adler32(input);
  return wrapZlib(deflateRaw, ad);
}

