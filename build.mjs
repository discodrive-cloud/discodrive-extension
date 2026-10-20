import * as esbuild from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'

const watch = process.argv.includes('--watch')
// Release builds ship no sourcemaps: they double the bundle size and expose the
// full source inside the signed package. Code stays unminified so AMO's
// automated review reads it as-is.
const release = process.argv.includes('--release')

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

const ctx = await esbuild.context({
  entryPoints: {
    'background': 'src/background.js',
    'popup/popup': 'src/popup/popup.js',
    'options/options': 'src/options/options.js',
    'help/help': 'src/help/help.js',
    'content/extract': 'src/content/extract.js',
  },
  bundle: true,
  format: 'iife',
  target: ['firefox128', 'chrome120'],
  outdir: 'dist',
  sourcemap: release ? false : 'inline',
  logLevel: 'info',
})

// Finder litter (.DS_Store) must not end up in the signed package.
const noJunk = { recursive: true, filter: (src) => !src.endsWith('.DS_Store') }

async function copyStatic() {
  await cp('src/manifest.json', 'dist/manifest.json')
  await cp('src/_locales', 'dist/_locales', noJunk)
  await cp('src/popup/popup.html', 'dist/popup/popup.html')
  await cp('src/popup/popup.css', 'dist/popup/popup.css')
  await cp('src/options/options.html', 'dist/options/options.html')
  await cp('src/options/options.css', 'dist/options/options.css')
  await cp('src/help/help.html', 'dist/help/help.html')
  await cp('src/help/help.css', 'dist/help/help.css')
  await cp('src/help/img', 'dist/help/img', noJunk)
  await cp('icons', 'dist/icons', noJunk)
}

if (watch) {
  await copyStatic()
  await ctx.watch()
  console.log('watching… (static files are copied on start only)')
} else {
  await ctx.rebuild()
  await copyStatic()
  await ctx.dispose()
}
