// Copies the built app into the blog as a gadget, at content/gadgets/signal-lab/ in the blog
// checkout (BLOG_DIR, default ../blog). Preview images already there are kept.

import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { dist, root } from './build.ts';

const blog = resolve(process.env.BLOG_DIR ?? join(root, '../blog'));
const gadgets = join(blog, 'content/gadgets');
const target = join(gadgets, 'signal-lab');

if (!existsSync(gadgets)) {
  console.error(
    `No content/gadgets in ${blog}. Set BLOG_DIR to the blog checkout.`,
  );
  process.exit(1);
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('Nothing to install: run npm run build first.');
  process.exit(1);
}

if (existsSync(target)) {
  for (const entry of readdirSync(target)) {
    if (!/^preview(-dark)?\.webp$/.test(entry)) {
      rmSync(join(target, entry), { recursive: true, force: true });
    }
  }
}

cpSync(dist, target, { recursive: true });
console.log(`Installed into ${target}`);
