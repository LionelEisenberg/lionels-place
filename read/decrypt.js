// Browser: scans for .locked blocks, auto-unlocks with cached passwords,
// renders an inline prompt UI for any that remain locked.
//
// Caches successful passwords in sessionStorage so subsequent locked blocks
// with the same password auto-unlock without prompting.

import { decrypt } from '/crypto-utils.mjs';

const CACHE_KEY = 'read:pw';

function getCached() {
  try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || '[]'); }
  catch { return []; }
}

function cachePassword(pw) {
  const all = getCached();
  if (!all.includes(pw)) {
    all.push(pw);
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(all));
  }
}

async function tryUnlock(block, password) {
  const blob = {
    ct: block.dataset.ct,
    salt: block.dataset.salt,
    iv: block.dataset.iv,
  };
  let plaintext;
  try {
    plaintext = await decrypt(blob, password);
  } catch {
    return false;
  }
  // Replace block with decrypted HTML
  const tmp = document.createElement('div');
  tmp.innerHTML = plaintext;
  const frag = document.createDocumentFragment();
  while (tmp.firstChild) frag.appendChild(tmp.firstChild);
  // <script> elements parsed via innerHTML are inert — the browser will not
  // run them. Collect them now, then recreate each one after insertion so it
  // actually executes. Without this, D3 charts inside a private block never
  // render once the block is unlocked.
  const inertScripts = [...frag.querySelectorAll('script')];
  block.parentNode.replaceChild(frag, block);
  for (const old of inertScripts) {
    const fresh = document.createElement('script');
    for (const { name, value } of old.attributes) fresh.setAttribute(name, value);
    fresh.textContent = old.textContent;
    old.parentNode.replaceChild(fresh, old);
  }
  return true;
}

function renderPrompt(block) {
  const hint = block.dataset.hint || '';
  block.innerHTML = `
    <div class="locked-inner">
      <p class="locked-label">🔒 Locked content</p>
      ${hint ? `<p class="locked-hint">${escapeHtml(hint)}</p>` : ''}
      <div class="locked-form">
        <input type="password" class="locked-input" placeholder="Password" autocomplete="off">
        <button class="locked-button" type="button">Unlock</button>
      </div>
      <p class="locked-error" hidden>Incorrect password.</p>
    </div>
  `;
  const input = block.querySelector('.locked-input');
  const button = block.querySelector('.locked-button');
  const error = block.querySelector('.locked-error');

  const submit = async () => {
    const pw = input.value;
    if (!pw) return;
    const ok = await tryUnlock(block, pw);
    if (ok) {
      cachePassword(pw);
      // Try the password on any other still-locked blocks
      const remaining = [...document.querySelectorAll('.locked')];
      for (const b of remaining) await tryUnlock(b, pw);
    } else {
      error.hidden = false;
      block.classList.add('shake');
      setTimeout(() => block.classList.remove('shake'), 360);
    }
  };
  button.addEventListener('click', submit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function init() {
  // Auto-unlock pass with cached passwords
  const cached = getCached();
  for (const pw of cached) {
    const blocks = [...document.querySelectorAll('.locked')];
    for (const block of blocks) await tryUnlock(block, pw);
  }
  // Render prompts for any remaining locked blocks
  document.querySelectorAll('.locked').forEach(renderPrompt);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
