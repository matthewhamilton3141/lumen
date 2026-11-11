import { defineConfig } from 'vite';

// Relative asset URLs, so the built app works from any folder: a domain root, GitHub Pages
// at /lumen/, or a path in an R2 bucket.
export default defineConfig({
  base: './',
});
