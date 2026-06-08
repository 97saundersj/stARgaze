import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    https: true,
  },
  preview: {
    host: true,
    https: true,
  },
});
