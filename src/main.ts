/* ============================== imports ============================== */
import ace from "ace-builds/src-noconflict/ace";
import "ace-builds/src-noconflict/mode-python";
import "ace-builds/src-noconflict/theme-monokai";

import { parseDeflate } from "./parser";
import { renderOutput, renderBlocks, lockClear, tooltip } from "./renderer";
import { zopfliCompressWithWorker } from "./worker";


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
/* ============================== Ace Editor 初期化 ============================== */
const editor = ace.edit("editor", {
  mode: "ace/mode/python",
  theme: "ace/theme/monokai",
  fontSize: "15px",
  showPrintMargin: false,
  wrap: true,
  useWorker: false
});
editor.session.setTabSize(2);
editor.session.setUseSoftTabs(true);

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
const inputModal = $("inputModal") as HTMLDialogElement;
const btnInput = $("btn-input") as HTMLButtonElement;
const btnClose = $("btn-close") as HTMLButtonElement;
const elIter = $("iter") as HTMLInputElement;
const elIterVal = $("iterVal") as HTMLSpanElement;
const elDeflateLen = $("deflateLen") as HTMLSpanElement;
const elCodeLen = $("codeLen") as HTMLSpanElement;

const setErr = (m: string) => { errDiv.textContent = m; errDiv.classList.remove("hidden"); okDiv.classList.add("hidden"); };
const setOk  = (m: string) => { okDiv .textContent = m; okDiv .classList.remove("hidden"); errDiv.classList.add("hidden"); };
const clearMsgs=()=>{ errDiv.classList.add("hidden"); errDiv.textContent=''; okDiv.classList.add("hidden"); okDiv.textContent=''; };

/* ============================== エディタ同期（再帰抑止） ============================== */
let isProgrammaticEditorUpdate = false;
let lastCompressedB64: string | null = null;

/* ============================== ラベル更新ユーティリティ ============================== */
function updateDeflateLenLabel(n: number){ if (elDeflateLen) elDeflateLen.textContent = String(n); }
function updateCodeLenLabel(n: number){ if (elCodeLen) elCodeLen.textContent = String(n); }

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

    // ラベル更新
    updateDeflateLenLabel(comp.length);
    updateCodeLenLabel(decoded.length);

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
elRaw.addEventListener("change", ()=>{
  debounceCompress();
  try{
    const bytes = elHex.value.trim() ? hexToBytes(elHex.value) : elB64.value.trim() ? b64dec(elB64.value) : null;
    if (bytes) parseBytes(bytes);
  }catch(e:any){ console.error(e); setErr(String(e && e.message ? e.message : e)); }
});
elIter.addEventListener("input", ()=>{
  elIterVal.textContent = String(elIter.value);
  debounceCompress();
});

/* ============================== 入力モーダル ============================== */
btnInput.addEventListener("click", ()=> inputModal.showModal());
btnClose.addEventListener("click", ()=> inputModal.close());

function parseBytes(bytes: Uint8Array, fileName?: string){
  const raw = elRaw.checked;
  const {tokens,blocks,outputBytes,zlib,zlibNote} = parseDeflate(bytes, raw);
  const maxLitBits = renderOutput(outDiv, tokens, blocks);
  renderBlocks(elBlocks, blocks, tokens, maxLitBits);
  elZlibNote.textContent = zlib ? zlibNote : '';

  const decoded = dec.decode(outputBytes);

  updateDeflateLenLabel(bytes.length);
  updateCodeLenLabel(decoded.length);

  if (editor.getValue() !== decoded) {
    isProgrammaticEditorUpdate = true;
    editor.setValue(decoded, -1);
    isProgrammaticEditorUpdate = false;
  }

  lastCompressedB64 = b64enc(bytes);
  setOk(`復号長: ${outputBytes.length} bytes / 文字列長: ${decoded.length} chars / トークン: ${tokens.length} / ブロック: ${blocks.length} / deflate: ${bytes.length} bytes${fileName ? ` / ファイル: ${fileName}` : ''}`);
}

elHex.addEventListener("input", ()=>{
  clearMsgs();
  try{
    if (!elHex.value.trim()) return;
    const bytes = hexToBytes(elHex.value);
    elB64.value = b64enc(bytes);
    parseBytes(bytes);
  }catch(e:any){ console.error(e); setErr(String(e && e.message ? e.message : e)); }
});
elB64.addEventListener("input", ()=>{
  clearMsgs();
  try{
    if (!elB64.value.trim()) return;
    const bytes = b64dec(elB64.value);
    elHex.value = bytesToHex(bytes);
    parseBytes(bytes);
  }catch(e:any){ console.error(e); setErr(String(e && e.message ? e.message : e)); }
});

/* ============================== ファイル読み込み（クリック & ドラッグ＆ドロップ） ============================== */
$("btn-file")!.addEventListener("click", ()=> $("fileInput")!.click());
$("fileInput")!.addEventListener("change", async (ev:any)=>{
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  if (!inputModal.open) inputModal.showModal();
  await handleFile(f);
  (ev.target as HTMLInputElement).value = "";
});
["dragenter","dragover"].forEach(evName=>{
  document.addEventListener(evName, (e)=>{ e.preventDefault(); inputModal.classList.add("drop"); });
});
["dragleave","drop"].forEach(evName=>{
  document.addEventListener(evName, (e)=>{ e.preventDefault(); inputModal.classList.remove("drop"); });
});
document.addEventListener("drop", async (e: DragEvent)=>{
  const dt = e.dataTransfer; if (!dt) return;
  if (dt.files && dt.files.length>0) {
    if (!inputModal.open) inputModal.showModal();
    await handleFile(dt.files[0]);
  }
});
async function handleFile(f: File){
  clearMsgs();
  try{
    const buf = new Uint8Array(await f.arrayBuffer());
    elHex.value = bytesToHex(buf);
    elB64.value = b64enc(buf);
    parseBytes(buf, f.name);
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
      updateCodeLenLabel(text.length);          // 先にコード長だけ表示
      updateDeflateLenLabel(0);                 // deflate は圧縮完了後に更新
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
      updateDeflateLenLabel(bytes.length);      // 先に deflate 長を表示
      parseBytes(bytes);
      return;
    }catch(e){ console.warn("deflate デコード失敗", e); }
  }
  elIterVal.textContent = String(elIter.value || "10");
  debounceCompress();
})();

/* ============================== グローバル：クリックでロック解除 / ESCで解除 ============================== */
document.addEventListener("click", ()=>{
  const out = $("output");
  lockClear(out);
  tooltip.hide();
});
document.addEventListener("keydown", (e)=>{
  if (e.key === "Escape") {
    lockClear($("output"));
    tooltip.hide();
  }
});
