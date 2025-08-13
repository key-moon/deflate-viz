import { defineConfig } from "vite";

// Viteは wasm を標準サポートします。
// 依存のWASMをfetchするタイプでもだいたい動きます。
// もし開発環境によってwasm解決に失敗したら、public/ に wasm を置く対処も可能です（後述）。
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true, // 動的importをインライン化
        manualChunks: undefined
      },
    },
    // sourcemap: true
  }
});
