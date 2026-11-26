import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import fs from 'node:fs';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background/index.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  },
  plugins: [
    {
      name: 'copy-extension-manifest',
      closeBundle() {
        const manifestSrc = resolve(__dirname, 'manifest.json');
        const manifestDst = resolve(__dirname, 'dist/manifest.json');
        fs.copyFileSync(manifestSrc, manifestDst);

        // Copia licenças das fontes abertas para o dist
        const fontLicenses = [
          'LICENSE-SpecialElite.txt',
          'OFL-Archivo.txt',
          'OFL-Geist.txt'
        ];
        for (const lic of fontLicenses) {
          const src = resolve(__dirname, 'src/fonts', lic);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, resolve(__dirname, 'dist', lic));
          }
        }
      }
    }
  ]
});
