// Builds a self-contained static site in dist/: compiled ES modules, public
// assets, Temml, the pronunciation dictionary, and third-party licenses.

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

/** Vendor files mapped from node_modules to paths within dist/vendor. */
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
 * Writes one word and its phonemes per line, using only the first
 * pronunciation.
 */
function writePronunciations(): void {
  const lines = Object.entries(dictionary)
    .filter(([word]) => !word.includes('('))
    .map(([word, phones]) => `${word} ${phones}`);
  writeFileSync(`${dist}/vendor/cmudict.txt`, `${lines.join('\n')}\n`);
}

/**
 * Adds modulepreload links for all compiled modules to avoid sequential import
 * discovery in the browser.
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
