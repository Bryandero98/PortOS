import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

import { vitestCiPool } from '../scripts/vitestCiPool.js';

export default defineConfig({
  plugins: [react()],
  test: {
    ...vitestCiPool(),
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
});
