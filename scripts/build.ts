// Builds the static app into dist/: compiled modules in dist/js, the page, stylesheet and fonts
// from public/, and in dist/vendor Temml (TeX to MathML), the CMU Pronouncing Dictionary for
// the Speech block, and the licenses of what the app is built from. The result is a
// self-contained directory any static host can serve.

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dictionary } from 'cmu-pronouncing-dictionary';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const dist = `${root}dist`;
export const tsc = `${root}node_modules/.bin/tsc`;

/** Files taken from node_modules, by where they land in dist/vendor. */
const VENDOR: Record<string, string> = {
  'temml.min.js': 'temml/dist/temml.min.js',
  'Temml-Local.css': 'temml/dist/Temml-Local.css',
  'Temml.woff2': 'temml/dist/Temml.woff2',
  'temml-LICENSE.txt': 'temml/LICENSE',
};

export function copyStatic(): void {
  cpSync(`${root}public`, dist, { recursive: true });
  mkdirSync(`${dist}/vendor`, { recursive: true });

  for (const [target, source] of Object.entries(VENDOR)) {
    cpSync(`${root}node_modules/${source}`, `${dist}/vendor/${target}`);
  }

  cpSync(`${root}licenses`, `${dist}/vendor/licenses`, { recursive: true });
  writePronunciations();
}

/**
 * The CMU Pronouncing Dictionary as the Speech block reads it, a word and its
 * phonemes to a line, first pronunciations only.
 */
function writePronunciations(): void {
  const lines = Object.entries(dictionary)
    .filter(([word]) => !word.includes('('))
    .map(([word, phones]) => `${word} ${phones}`);
  writeFileSync(`${dist}/vendor/cmudict.txt`, `${lines.join('\n')}\n`);
}

/**
 * Lists every module in the page's head as a modulepreload, so the browser
 * fetches them all at once instead of discovering each import only after
 * loading the module that makes it.
 */
export function preloadModules(): void {
  const modules = readdirSync(`${dist}/js`, {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((file) => file.endsWith('.js'))
    .map((file) => `js/${file.split('\\').join('/')}`)
    .sort();
  const page = `${dist}/index.html`;
  const links = modules
    .map((href) => `<link rel="modulepreload" href="${href}">`)
    .join('\n');
  writeFileSync(
    page,
    readFileSync(page, 'utf8').replace('<!-- modulepreload -->', links),
  );
}

export function build(): void {
  rmSync(dist, { recursive: true, force: true });
  execFileSync(tsc, ['-p', `${root}tsconfig.json`], { stdio: 'inherit' });
  copyStatic();
  preloadModules();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build();
}
