const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

/**
 * Bundle @ath/core into the extension. The extension is deliberately not an
 * npm workspace member: vsce cannot follow workspace symlinks, and bundling
 * sidesteps that entirely while keeping one copy of the session logic.
 */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // Provided by the extension host at runtime; must never be bundled.
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
