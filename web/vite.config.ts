import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { lessonEditor } from './dev/lesson-editor.ts';

/** the commit being built, for the About card's "Version 1.0.0-dev (062e77c)": CI's GITHUB_SHA, else git, else '' */
function buildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  base: './',
  plugins: [lessonEditor()],
  define: { __BUILD__: JSON.stringify(buildSha()) },
  // the tutorial's built-in riff is a MIDI file, imported as bytes (`?inline`)
  assetsInclude: ['**/*.mid'],
  build: { target: 'es2022' },
  // dev/demo is its own project (the Remotion demo video, its own node_modules)
  test: { environment: 'node', exclude: ['**/node_modules/**', 'dev/demo/**'] },
} as never);
