import { defineConfig } from 'vite';
import { lessonEditor } from './dev/lesson-editor.ts';

export default defineConfig({
  base: './',
  plugins: [lessonEditor()],
  // the tutorial's built-in riff is a MIDI file, imported as bytes (`?inline`)
  assetsInclude: ['**/*.mid'],
  build: { target: 'es2022' },
  // dev/demo is its own project (the Remotion demo video, its own node_modules)
  test: { environment: 'node', exclude: ['**/node_modules/**', 'dev/demo/**'] },
} as never);
