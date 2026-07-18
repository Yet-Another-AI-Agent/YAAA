/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vitest consumes this extension at test time; Vite's own type does not
  // declare it, so keep the config on the app's single Vite type instance.
  // @ts-expect-error Vitest augments Vite config with the `test` property.
  test: {
    setupFiles: ['./src/testSetup.ts'],
  },
  server: {
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
