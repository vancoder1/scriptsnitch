// The previous run's evidence (design §12 "Code diffs"): the report job downloads the latest earlier
// run's artifact (the `actions: read` permission) for the old copies of changed scripts. Runs that
// failed only because of a finding (fail-on) still count; their artifact holds the evidence.
import { readZip } from '../util/zip.js';

const LOOK_BACK = 5;

export async function previousEvidence(github, { workflowFile, currentRunId, artifactName = 'scriptsnitch' }) {
  const empty = (note = null) => ({ files: new Map(), urls: new Map(), runId: null, note });
  let runs;
  try { runs = await github.listWorkflowRuns({ workflowFile, status: 'completed' }); } catch (e) { return empty(`could not list earlier runs: ${e.message}`); }
  const earlier = runs.filter((r) => r.id !== currentRunId && (!currentRunId || r.id < currentRunId)).sort((a, b) => b.id - a.id);
  for (const run of earlier.slice(0, LOOK_BACK)) {
    const artifact = (await github.listRunArtifacts(run.id).catch(() => [])).find((a) => a.name === artifactName && !a.expired);
    if (!artifact) continue;
    try {
      const entries = readZip(await github.downloadArtifact(artifact.id));
      const files = new Map();
      for (const [name, data] of entries) {
        const m = /^evidence\/([0-9a-f]{64})\.js$/.exec(name);
        if (m) files.set(m[1], data);
      }
      const urls = new Map();
      const snapshot = entries.get('snapshot.json');
      if (snapshot) {
        try {
          for (const [hash, e] of Object.entries(JSON.parse(snapshot.toString('utf8')).evidence ?? {})) if (e?.url) urls.set(e.url, hash);
        } catch { /* an unreadable snapshot only loses the URL index */ }
      }
      return { files, urls, runId: run.id, note: null };
    } catch (e) {
      return empty(`the evidence of run ${run.id} could not be read (${e.message})`);
    }
  }
  return empty();
}
