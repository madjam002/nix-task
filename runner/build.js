if (!process.env.PKG_PATH_BASH) {
  throw new Error('Missing PKG_PATH_s needed for build')
}

require('esbuild').build({
  entryPoints: ['./src/index'],
  bundle: true,
  outdir: 'build/',
  sourcemap: 'inline',
  platform: 'node',
  minify: true,
  target: 'node18',
  loader: {
    '.nix': 'text',
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.PKG_PATH_BASH': JSON.stringify(process.env.PKG_PATH_BASH),
    'process.env.PKG_PATH_COREUTILS': JSON.stringify(
      process.env.PKG_PATH_COREUTILS,
    ),
    'process.env.PKG_PATH_JQ': JSON.stringify(process.env.PKG_PATH_JQ),
    'process.env.PKG_PATH_NODEJS': JSON.stringify(process.env.PKG_PATH_NODEJS),
    'process.env.PKG_PATH_UTIL_LINUX': JSON.stringify(
      process.env.PKG_PATH_UTIL_LINUX,
    ),
    'process.env.CONF_NIX_LIB_PATH': JSON.stringify(
      process.env.CONF_NIX_LIB_PATH,
    ),
  },
  logLevel: 'warning',
})
