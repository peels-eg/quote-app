// GitHub Contents API client
// Reads and writes JSON data files in the configured repo

const GitHub = (() => {
  const API = 'https://api.github.com';

  // sha cache: { 'data/orders.json': 'abc123...' }
  const shaCache = {};

  function cfg() {
    return {
      token: localStorage.getItem('gh_token') || '',
      repo: localStorage.getItem('gh_repo') || '',
    };
  }

  function headers() {
    const { token } = cfg();
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  async function readFile(path) {
    const { repo } = cfg();
    if (!repo) throw new Error('GitHub repo ikke konfigurert');
    const res = await fetch(`${API}/repos/${repo}/contents/${path}`, { headers: headers() });
    if (!res.ok) throw new Error(`GitHub les feilet (${res.status}): ${path}`);
    const data = await res.json();
    shaCache[path] = data.sha;
    const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  }

  async function writeFile(path, content, message) {
    const { repo } = cfg();
    if (!repo) throw new Error('GitHub repo ikke konfigurert');
    const body = {
      message: message || `oppdater ${path}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
    };
    if (shaCache[path]) body.sha = shaCache[path];
    const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GitHub skriv feilet (${res.status}): ${err.message || path}`);
    }
    const data = await res.json();
    shaCache[path] = data.content.sha;
    return data;
  }

  async function testConnection() {
    const { repo } = cfg();
    if (!repo) throw new Error('Repo ikke konfigurert');
    const res = await fetch(`${API}/repos/${repo}`, { headers: headers() });
    if (!res.ok) throw new Error(`Tilkobling feilet (${res.status})`);
    return await res.json();
  }

  return { readFile, writeFile, testConnection };
})();
