// Build script: bundles single-file-core into a single browser-ready JS file

const esbuild = require('esbuild');
const path = require('path');

const ROOT = __dirname;

async function build() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'core-entry.js')],
    bundle: true,
    format: 'iife',
    globalName: 'SingleFileCore',
    outfile: path.join(ROOT, 'core-bundle.js'),
    sourcemap: false,
    minify: false,
    target: ['es2020'],
    logLevel: 'warning',
    // Resolve node_modules from the package root
    nodePaths: [path.join(ROOT, 'node_modules')],
    // single-file-core has no package.json exports field, use legacy resolve
    mainFields: ['main', 'module', 'browser'],
  });

  console.log('✓ core-bundle.js built');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});