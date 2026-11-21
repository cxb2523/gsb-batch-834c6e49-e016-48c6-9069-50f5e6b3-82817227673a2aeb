import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const src = (segment: string) => resolve(__dirname, 'src', segment);

export default defineConfig({
  resolve: {
    alias: {
      audio: src('audio.ts'),
      adapters: src('adapters'),
      constants: src('constants'),
      events: src('events'),
      helpers: src('helpers'),
      mediasession: src('mediasession'),
      states: src('states'),
      types: src('types'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
});
