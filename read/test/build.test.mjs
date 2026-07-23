import { test } from 'node:test';
import assert from 'node:assert';
import { processPost } from '../build.js';

test('processPost replaces <private> with .locked div containing crypto attrs', async () => {
  const input = '<p>public</p><private password="x">secret stuff</private><p>more</p>';
  const out = await processPost(input);
  assert.match(out, /<p>public<\/p>/);
  assert.match(out, /<div class="locked"/);
  assert.match(out, /data-ct="[A-Za-z0-9+/=]+"/);
  assert.match(out, /data-salt="[A-Za-z0-9+/=]+"/);
  assert.match(out, /data-iv="[A-Za-z0-9+/=]+"/);
  assert.match(out, /<p>more<\/p>/);
  assert.doesNotMatch(out, /<private/);
  assert.doesNotMatch(out, /secret stuff/);
});

test('processPost with no <private> blocks returns input unchanged structure', async () => {
  const input = '<article><h1>Title</h1><p>Just public content</p></article>';
  const out = await processPost(input);
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<p>Just public content<\/p>/);
  assert.doesNotMatch(out, /class="locked"/);
});

test('processPost handles multiple <private> blocks with distinct ciphertexts', async () => {
  const input =
    '<private password="pw">aaa</private>' +
    '<p>middle</p>' +
    '<private password="pw">bbb</private>';
  const out = await processPost(input);
  const matches = [...out.matchAll(/data-ct="([^"]+)"/g)];
  assert.equal(matches.length, 2);
  assert.notEqual(matches[0][1], matches[1][1]);
});

test('processPost preserves hint attribute', async () => {
  const input = '<private password="pw" hint="for cohort 7">x</private>';
  const out = await processPost(input);
  assert.match(out, /data-hint="for cohort 7"/);
});

test('processPost defaults hint to empty when omitted', async () => {
  const input = '<private password="pw">x</private>';
  const out = await processPost(input);
  assert.match(out, /data-hint=""/);
});

test('processPost throws when password attribute is missing', async () => {
  const input = '<private>secret</private>';
  await assert.rejects(() => processPost(input), /missing required password/);
});

test('processPost escapes special chars in hint', async () => {
  const input = '<private password="pw" hint="A &amp; B &quot;x&quot;">x</private>';
  const out = await processPost(input);
  assert.match(out, /data-hint="A &amp; B &quot;x&quot;"/);
});
