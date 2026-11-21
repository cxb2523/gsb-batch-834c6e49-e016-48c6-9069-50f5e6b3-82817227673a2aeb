import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.js"],
    restoreMocks: true,
    setupFiles: ["tests/setup.js"],
  },
});
