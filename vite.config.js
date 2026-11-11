import { defineConfig } from 'vite';

// Relative base so the build works from any path (GitHub Pages serves it
// under /vocalcoach/).
export default defineConfig({ base: './' });
