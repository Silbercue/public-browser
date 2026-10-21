import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Root is app/, output app/dist (served by server/start.mjs as the default --static).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
