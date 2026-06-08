import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// GitHub Pages serves project sites at /stARgaze/
const repoBase = '/stARgaze/';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? repoBase : '/',
  plugins: [basicSsl()],
  server: {
    host: true,
    https: true,
  },
  preview: {
    host: true,
    https: true,
  },
}));
