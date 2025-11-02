import { defineConfig } from "vite";

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true, // inline dynamic imports
        manualChunks: undefined
      },
    },
    // sourcemap: true
  }
});
