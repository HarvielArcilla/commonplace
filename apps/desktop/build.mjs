// Bundles the window UI. The background process runs unbundled from src/.
import { build } from 'esbuild'

await build({
  entryPoints: ['renderer/app.js'],
  outfile: 'renderer/dist/app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome130'],
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  logLevel: 'info'
})
