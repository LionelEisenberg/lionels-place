import { parse } from 'node-html-parser';
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { encrypt } from './crypto-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const POSTS_SRC = join(ROOT, 'blog-posts', 'posts');
const DIST = join(ROOT, 'dist');

const PLAIN_COPY_FILES = ['style.css', 'decrypt.js', 'crypto-utils.mjs'];
const STATIC_DIRS = ['assets'];

// Content-hash style.css and rewrite every `/style.css` reference to
// `/style.css?v=<hash>`. Cloudflare keys cache by full URL including query
// string, so a CSS edit invalidates without needing a manual purge.
async function computeStyleVersion() {
  const css = await readFile(join(ROOT, 'style.css'));
  return createHash('sha256').update(css).digest('hex').slice(0, 8);
}

function injectStyleVersion(html, version) {
  return html.replace(/href="\/style\.css"/g, `href="/style.css?v=${version}"`);
}

/**
 * Replace every <private password="X" hint="Y">...</private> with a
 * <div class="locked" data-ct=".." data-salt=".." data-iv=".." data-hint="Y"></div>.
 * Inner HTML is AES-GCM encrypted with PBKDF2-derived key from X.
 */
export async function processPost(html) {
  const root = parse(html, { lowerCaseTagName: false, voidTag: { closingSlash: false } });
  const blocks = root.querySelectorAll('private');
  for (const block of blocks) {
    const password = block.getAttribute('password');
    if (!password) {
      throw new Error('<private> block missing required password="" attribute');
    }
    const hint = block.getAttribute('hint') || '';
    const inner = block.innerHTML;
    const { ct, salt, iv } = await encrypt(inner, password);
    const replacement = parse(
      `<div class="locked" data-ct="${ct}" data-salt="${salt}" data-iv="${iv}" data-hint="${escapeAttr(hint)}"></div>`
    );
    block.replaceWith(replacement);
  }
  return root.toString();
}

function escapeAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function buildAll(opts = {}) {
  // Wiping dist/ fights Windows file locking when the preview server is running.
  // Default is incremental: writeFile overwrites individual files in place. Pass
  // { clean: true } for a full wipe (use this in CI / before deploy).
  if (opts.clean) {
    await rm(DIST, { recursive: true, force: true });
  }
  await mkdir(join(DIST, 'posts'), { recursive: true });

  const styleVersion = await computeStyleVersion();

  // Process posts
  let postCount = 0;
  try {
    const files = await readdir(POSTS_SRC);
    for (const file of files) {
      if (!file.endsWith('.html')) continue;
      const src = join(POSTS_SRC, file);
      const html = await readFile(src, 'utf8');
      const processed = injectStyleVersion(await processPost(html), styleVersion);
      // Strip YYYY-MM-DD- date prefix from output filename so URLs are clean slugs.
      // Source: 2026-05-10-welcome-to-read.html  →  dist: welcome-to-read.html
      const outFile = file.replace(/^\d{4}-\d{2}-\d{2}-/, '');
      await writeFile(join(DIST, 'posts', outFile), processed);
      postCount++;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn(`[build] no posts/ found at ${POSTS_SRC} — proceeding with empty post list`);
  }

  // index.html — read, version-inject, write
  const indexHtml = await readFile(join(ROOT, 'index.html'), 'utf8');
  await writeFile(join(DIST, 'index.html'), injectStyleVersion(indexHtml, styleVersion));

  // Copy unchanged static files
  for (const file of PLAIN_COPY_FILES) {
    await copyFile(join(ROOT, file), join(DIST, file));
  }

  // Copy static dirs
  for (const dir of STATIC_DIRS) {
    await copyDir(join(ROOT, dir), join(DIST, dir));
  }

  console.log(`[build] processed ${postCount} post(s) → ${DIST} (style v=${styleVersion})`);
}

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}
