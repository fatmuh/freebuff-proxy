import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { resolve } from 'path'

export default defineConfig({
  plugins: [solidPlugin()],
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, '../dist-dashboard'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9187',
      '/v1': 'http://localhost:9187',
      '/admin': 'http://localhost:9187',
    },
  },
})
