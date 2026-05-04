import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// If deploying to GitHub Pages at https://<user>.github.io/sm-questionbox/
// set base to '/sm-questionbox/'. If using a custom domain or root, use '/'.
export default defineConfig({
  plugins: [react()],
  base: './',
});
