/**
 * LogTrim self-updater.
 * Compares app files in the user's repo against the public template repo
 * (logtrim/logtrim) and writes any changed files to the user's repo via
 * the GitHub API. Personal data (logs, profile, my-gyms) is never touched.
 *
 * Exposed as global LogTrimUpdater.checkForUpdates(cfg, onStatus).
 */
(function (global) {
  const TEMPLATE_USER = 'logtrim';
  const TEMPLATE_REPO = 'logtrim';
  // Only files matching these prefixes are ever updated.
  const SYNC_PREFIXES = ['index.html', 'scripts/', 'equipment/generic/'];

  function inScope(path) {
    return SYNC_PREFIXES.some(p => path === p || path.startsWith(p));
  }

  // Map of path -> blob sha for every file in a repo's main branch.
  async function repoTree(user, repo, headers) {
    const r = await fetch(`https://api.github.com/repos/${user}/${repo}/git/trees/main?recursive=1`, { headers });
    if (!r.ok) throw new Error(`Could not list files for ${user}/${repo} (HTTP ${r.status})`);
    const j = await r.json();
    const map = {};
    (j.tree || []).forEach(t => { if (t.type === 'blob') map[t.path] = t.sha; });
    return map;
  }

  // Fetch a template file (text or binary) and return base64 for the contents API.
  async function fetchTemplateBase64(path) {
    const url = `https://raw.githubusercontent.com/${TEMPLATE_USER}/${TEMPLATE_REPO}/main/${path}?t=${Date.now()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed: ${path} (HTTP ${r.status})`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function apiPath(path) {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * cfg: { user, repo, pat }
   * onStatus: optional callback(message) for progress display.
   * Returns { updated: n, files: [...] }.
   */
  async function checkForUpdates(cfg, onStatus) {
    onStatus = onStatus || function () {};
    const auth = { Authorization: `Bearer ${cfg.pat}`, Accept: 'application/vnd.github.v3+json' };

    onStatus('Comparing with template…');
    const [tpl, mine] = await Promise.all([
      repoTree(TEMPLATE_USER, TEMPLATE_REPO, {}),      // public, no auth
      repoTree(cfg.user, cfg.repo, auth)
    ]);

    const changed = Object.keys(tpl).filter(p => inScope(p) && tpl[p] !== mine[p]);
    if (!changed.length) {
      onStatus('Already up to date ✓');
      return { updated: 0, files: [] };
    }

    let done = 0;
    for (const p of changed) {
      onStatus(`Updating ${p} (${done + 1}/${changed.length})…`);
      const content = await fetchTemplateBase64(p);
      const body = { message: `Update ${p} from template`, content };
      if (mine[p]) body.sha = mine[p];
      const r = await fetch(`https://api.github.com/repos/${cfg.user}/${cfg.repo}/contents/${apiPath(p)}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error(`Write failed for ${p} (HTTP ${r.status})`);
      done++;
    }

    onStatus(`Updated ${done} file(s) ✓ — hard-refresh the app in ~1 minute to finish.`);
    return { updated: done, files: changed };
  }

  const api = { checkForUpdates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LogTrimUpdater = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
