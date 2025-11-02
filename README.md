# Deflate Visualizer

A tool to visually inspect the compression and decompression steps of the DEFLATE algorithm.

## Features

- Compress and visualize text
- Analyze compressed byte streams
- Show detailed token and block information

### WASM bindings

The WebAssembly bindings used for Gzip/Zopfli compression and decompression in this project are provided by the `wasm_gz` repository:

- https://github.com/packurl/wasm_gz

## Development environment

- Node.js
- Vite
- TypeScript
- Ace Editor

## Local development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Build
pnpm build

# Preview build output
pnpm preview
```
