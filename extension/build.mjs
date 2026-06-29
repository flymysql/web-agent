import esbuild from 'esbuild';
import {
  rmSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'dist');
const sharedEntry = resolve(root, '../shared/src/index.ts');
const watch = process.argv.includes('--watch');

/**
 * TypeScript ESM source uses explicit `.js` extensions in relative imports
 * (e.g. `import './page-context.js'`), but the files on disk are `.ts`.
 * esbuild does not remap these by default, so we resolve them manually.
 */
const tsExtensionResolve = {
  name: 'ts-extension-resolve',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === 'entry-point' || !args.path.startsWith('.')) return undefined;
      const tsPath = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      return existsSync(tsPath) ? { path: tsPath } : undefined;
    });
  },
};

const common = {
  bundle: true,
  platform: 'browser',
  target: ['chrome110'],
  format: 'iife',
  legalComments: 'none',
  alias: { '@ai-browser-agent/shared': sharedEntry },
  plugins: [tsExtensionResolve],
  logLevel: 'info',
};

const entries = [
  { entry: 'src/background/service-worker.ts', out: 'service-worker.js' },
  { entry: 'src/content/index.ts', out: 'content.js' },
  { entry: 'src/popup/popup.ts', out: 'popup.js' },
  { entry: 'src/options/options.ts', out: 'options.js' },
];

function copyStatic() {
  cpSync(resolve(root, 'icons'), resolve(outDir, 'icons'), { recursive: true });
  cpSync(resolve(root, 'src/popup/popup.css'), resolve(outDir, 'popup.css'));
  cpSync(resolve(root, 'src/options/options.css'), resolve(outDir, 'options.css'));

  const optionsHtml = readFileSync(resolve(root, 'src/options/options.html'), 'utf8')
    .replace('./options.css', 'options.css')
    .replace(
      '<script src="./options.ts" type="module"></script>',
      '<script src="options.js"></script>'
    );
  writeFileSync(resolve(outDir, 'options.html'), optionsHtml);

  const html = readFileSync(resolve(root, 'src/popup/index.html'), 'utf8')
    .replace('./popup.css', 'popup.css')
    .replace(
      '<script type="module" src="./popup.ts"></script>',
      '<script src="popup.js"></script>'
    );
  writeFileSync(resolve(outDir, 'popup.html'), html);

  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  manifest.background = { service_worker: 'service-worker.js' };
  manifest.content_scripts = [
    { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: true },
  ];
  manifest.action.default_popup = 'popup.html';
  manifest.options_ui = { page: 'options.html', open_in_tab: true };
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyStatic();

  const buildOptions = entries.map((e) => ({
    ...common,
    entryPoints: [resolve(root, e.entry)],
    outfile: resolve(outDir, e.out),
  }));

  if (watch) {
    const contexts = await Promise.all(buildOptions.map((o) => esbuild.context(o)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[build] watching for changes... (static files are not watched)');
  } else {
    await Promise.all(buildOptions.map((o) => esbuild.build(o)));
    console.log('[build] extension built to dist/');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
