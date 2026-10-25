// Vite: the dev server and build for the board. Defaults throughout, except the
// file watcher: other worktrees (.claude/worktrees/) and smoke-test output live
// inside this folder, and their churn must not hot-reload pages mid-match.
// HTTPS=1 (npm run dev:https) serves over a self-signed certificate: room codes
// need crypto.subtle, which a plain http:// page on any address but localhost lacks.
// VITE_BASE sets the path the build is served under (/land-game/ on GitHub Pages).

import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: {
    watch: {
      ignored: ['**/.claude/**', '**/smoke-output/**'],
    },
  },
});
