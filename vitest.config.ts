import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // Tests exercise the workspace sources directly, without a prebuilt dist.
      '@vue-player/core': resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
})
