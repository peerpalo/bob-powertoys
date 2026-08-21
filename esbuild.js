const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const tscWatchPlugin = {
  name: 'tsc-watch-compat',
  setup(build) {
    build.onStart(() => {
      // Matches $tsc-watch beginsPattern — tells VS Code a new build started
      console.log('Starting compilation in watch mode...');
    });
    build.onEnd(result => {
      if (result.errors.length > 0) {
        result.errors.forEach(e => console.error(e.text));
      }
      // Matches $tsc-watch endsPattern — tells VS Code the build finished
      console.log('Found 0 errors. Watching for file changes.');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: watch ? [tscWatchPlugin] : [],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
  } else {
    await esbuild.build({ ...buildOptions, logLevel: 'info' });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
