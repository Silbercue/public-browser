import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  workers: 1,
  projects: [{ name: 'chromium', use: { channel: 'chrome' } }],
});
