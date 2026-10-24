// Vite: the dev server and build for the board. Defaults throughout, except the
// file watcher: other worktrees (.claude/worktrees/) and smoke-test output live
// inside this folder, and their churn must not hot-reload pages mid-match.

import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      ignored: ['**/.claude/**', '**/smoke-output/**'],
    },
  },
});
