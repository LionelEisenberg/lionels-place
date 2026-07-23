import { test } from 'node:test';
import assert from 'node:assert';
import { encrypt, decrypt } from '../crypto-utils.mjs';

test('round-trip with correct password returns original plaintext', async () => {
  const blob = await encrypt('hello world', 'cradle2025');
  const result = await decrypt(blob, 'cradle2025');
  assert.equal(result, 'hello world');
});

test('wrong password causes decrypt to throw', async () => {
  const blob = await encrypt('secret', 'right-password');
  await assert.rejects(() => decrypt(blob, 'wrong-password'));
});

test('same plaintext + password produces different ciphertext each time', async () => {
  const a = await encrypt('hello', 'pw');
  const b = await encrypt('hello', 'pw');
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
});

test('decrypt with original blob still works after re-encryption', async () => {
  const a = await encrypt('hello', 'pw');
  await encrypt('hello', 'pw'); // discarded
  const result = await decrypt(a, 'pw');
  assert.equal(result, 'hello');
});

test('round-trips multi-line HTML', async () => {
  const html = '<p>line 1</p>\n<p>line 2</p>\n<strong>bold</strong>';
  const blob = await encrypt(html, 'pw');
  const result = await decrypt(blob, 'pw');
  assert.equal(result, html);
});
