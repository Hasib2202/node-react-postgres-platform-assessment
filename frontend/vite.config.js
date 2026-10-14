import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // `npm run dev` only: proxy /api to a locally running backend.
  server: { proxy: { '/api': 'http://localhost:4000' } },
});
