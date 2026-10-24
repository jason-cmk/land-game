// Vite: the dev server and build for the board. Defaults throughout, except the
// file watcher: other worktrees (.claude/worktrees/) and smoke-test output live
// inside this folder, and their churn must not hot-reload pages mid-match.
// HTTPS=1 (npm run dev:https) serves over a self-signed certificate: room codes
// need crypto.subtle, which a plain http:// page on any address but localhost lacks.

import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: {
    watch: {
      ignored: ['**/.claude/**', '**/smoke-output/**'],
    },
  },
});
