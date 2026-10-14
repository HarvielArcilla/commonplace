// Bundles the window UI. The background process runs unbundled from src/.
import { build } from 'esbuild'

await build({
  entryPoints: { app: 'renderer/app.js', vendor: 'renderer/vendor.css' },
  outdir: 'renderer/dist',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome130'],
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  logLevel: 'info'
})
