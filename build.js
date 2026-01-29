const esbuild = require('esbuild')

;(async () => {
  try {
    await esbuild.build({
      entryPoints: ['src/index.ts'],
      bundle: true,
      outfile: 'dist/bundle.js',
      format: 'esm', // ES module format
      platform: 'browser',
      minify: false,
      sourcemap: true,
      target: 'es2020',
      external: [], // Bundle everything
    })
    console.log('Build completed successfully!')
  } catch (error) {
    console.error('Build failed:', error)
    process.exit(1)
  }
})()
