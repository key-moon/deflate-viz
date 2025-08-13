import { defineConfig } from "vite";

// Viteは wasm を標準サポートします。
// 依存のWASMをfetchするタイプでもだいたい動きます。
// もし開発環境によってwasm解決に失敗したら、public/ に wasm を置く対処も可能です（後述）。
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      external: ["/gzip_zopfli_worker.mjs"], // 明示的に外部モジュールとして指定
      output: {
        inlineDynamicImports: true, // 動的importをインライン化
        manualChunks: undefined
      },
    },
    // sourcemap: true
  }
});
