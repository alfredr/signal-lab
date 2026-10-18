// Builds the static app into dist/: compiled modules in dist/js, with the page, stylesheet and
// fonts from public/ beside them. The result is a self-contained directory any static host
// can serve.

import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const dist = `${root}dist`;
export const tsc = `${root}node_modules/.bin/tsc`;

export function copyStatic(): void {
  cpSync(`${root}public`, dist, { recursive: true });
}

export function build(): void {
  rmSync(dist, { recursive: true, force: true });
  execFileSync(tsc, ["-p", `${root}tsconfig.json`], { stdio: "inherit" });
  copyStatic();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
