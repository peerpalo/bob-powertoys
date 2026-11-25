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
const extensionOptions = {
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

/**
 * Browser bundle for the MCP Apps panel webview (src/mcp/appBridge.ts).
 * Bundles the official @modelcontextprotocol/ext-apps AppBridge; loaded by
 * the panel document via webview.asWebviewUri(). Must NOT import 'vscode'.
 * @type {import('esbuild').BuildOptions} */
const mcpAppBridgeOptions = {
  entryPoints: ['src/mcp/appBridge.ts'],
  bundle: true,
  outfile: 'out/mcp/appBridge.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: true,  // always: no source map means no debug value in readable output
  logLevel: 'silent',
  plugins: watch ? [tscWatchPlugin] : [],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(extensionOptions);
    await ctx.watch();
    // The bridge bundle changes rarely — build it once per watch session.
    await esbuild.build({ ...mcpAppBridgeOptions, logLevel: 'info' });
  } else {
    await esbuild.build({ ...extensionOptions, logLevel: 'info' });
    await esbuild.build({ ...mcpAppBridgeOptions, logLevel: 'info' });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
