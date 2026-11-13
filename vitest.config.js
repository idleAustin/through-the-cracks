// Vitest configuration for archive client and server unit/integration seams under src/.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.{js,jsx}'],
      environment: 'node',
    },
  })
);
