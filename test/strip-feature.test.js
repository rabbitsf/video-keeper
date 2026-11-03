import test from 'node:test';
import assert from 'node:assert/strict';
import { stripFeature } from '../tools/strip-feature.mjs';

test('removes JS, HTML and CSS blocks including their marker lines', () => {
  const js = 'a();\n  // #if youtube\n  b();\n  // #endif\nc();\n';
  assert.equal(stripFeature(js, 'youtube'), 'a();\nc();\n');
  const html = '<p>x</p>\n<!-- #if youtube -->\n<section>y</section>\n<!-- #endif -->\n<p>z</p>\n';
  assert.equal(stripFeature(html, 'youtube'), '<p>x</p>\n<p>z</p>\n');
  const css = 'a {}\n/* #if youtube */\n#y {}\n/* #endif */\nb {}\n';
  assert.equal(stripFeature(css, 'youtube'), 'a {}\nb {}\n');
});

test('leaves text without markers and other features untouched', () => {
  const text = 'one\n// #if other\ntwo\n// #endif\nthree\n';
  assert.equal(stripFeature('plain\ntext\n', 'youtube'), 'plain\ntext\n');
  assert.equal(stripFeature(text, 'youtube'), text);
});

test('handles several blocks and blank lines', () => {
  const text = 'a\n// #if youtube\nb\n\n// #endif\nc\n// #if youtube\nd\n// #endif\n';
  assert.equal(stripFeature(text, 'youtube'), 'a\nc\n');
});

test('rejects unbalanced or nested markers', () => {
  assert.throws(() => stripFeature('// #if youtube\na\n', 'youtube'), /unclosed/);
  assert.throws(() => stripFeature('a\n// #endif\n', 'youtube'), /without/);
  assert.throws(() => stripFeature('// #if youtube\n// #if youtube\n// #endif\n// #endif\n', 'youtube'), /nested/);
});
