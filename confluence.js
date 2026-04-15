// Confluence REST API client
// Publishes and updates the «Ordre» page in the user's personal space

const Confluence = (() => {
  function cfg() {
    return {
      baseUrl: localStorage.getItem('cf_url') || 'https://confluence.eg.dk',
      token: localStorage.getItem('cf_token') || '',
      space: localStorage.getItem('cf_space') || '~peels@eg.no',
    };
  }

  function headers() {
    const { token } = cfg();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async function apiFetch(path, opts = {}) {
    const { baseUrl } = cfg();
    const res = await fetch(`${baseUrl}/rest/api${path}`, {
      ...opts,
      headers: { ...headers(), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Confluence ${res.status}: ${txt.slice(0, 200)}`);
    }
    return res.json();
  }

  async function findOrdrePage() {
    const { space } = cfg();
    // Attempt 1: exact title + space
    try {
      const r1 = await apiFetch(`/content/search?cql=title%3D%22Ordre%22%20AND%20space%3D%22${encodeURIComponent(space)}%22&expand=version,body.storage`);
      if (r1.results && r1.results.length > 0) return r1.results[0];
    } catch (_) {}
    // Attempt 2: fulltext search
    const r2 = await apiFetch(`/content/search?cql=text%3D%22Ordre%22%20AND%20space%3D%22${encodeURIComponent(space)}%22%20AND%20title%3D%22Ordre%22&expand=version,body.storage`);
    if (r2.results && r2.results.length > 0) return r2.results[0];
    return null;
  }

  // Build table rows for a single order (rowspan on all cols except Vare)
  function buildOrderRows(order) {
    const items = order.items.filter(i => i.category !== '_setup');
    const setupItems = order.items.filter(i => i.category === '_setup');
    const allItems = [...items, ...setupItems];
    const n = allItems.length;
    const customer = order.store ? `${order.chain} ${order.store}` : order.chain;
    const fmt = v => v.toLocaleString('nb-NO') + ',-';

    return allItems.map((item, idx) => {
      const itemTotal = item.qty * item.unitPrice;
      const vareCell = `<td>${item.name} x${item.qty} (${fmt(item.unitPrice)}) = ${fmt(itemTotal)}</td>`;
      if (idx === 0) {
        return `<tr>
  <td rowspan="${n}">${order.id}</td>
  <td rowspan="${n}">${customer}</td>
  <td rowspan="${n}">${order.date}</td>
  ${vareCell}
  <td rowspan="${n}">${fmt(order.total)}</td>
  <td rowspan="${n}">${order.margin != null ? fmt(order.margin) : '–'}</td>
  <td rowspan="${n}">${order.status}</td>
</tr>`;
      }
      return `<tr>${vareCell}</tr>`;
    }).join('\n');
  }

  function buildFullPage(orders) {
    const rows = orders.map(buildOrderRows).join('\n');
    return `<h1>Ordre</h1>
<h2>Statusoversikt</h2>
<table>
<tbody>
<tr>
  <th>Saksnummer</th><th>Kunde</th><th>Dato</th><th>Vare</th>
  <th>Total eks. mva</th><th>Fortjeneste</th><th>Status</th>
</tr>
${rows}
</tbody>
</table>`;
  }

  async function publishOrder(order) {
    const { space } = cfg();
    const page = await findOrdrePage();

    if (page) {
      // Prepend new rows after header row
      let existing = page.body.storage.value;
      const newRows = buildOrderRows(order);
      // Insert after the header <tr>
      existing = existing.replace(
        /(<tr>\s*<th>Saksnummer<\/th>.*?<\/tr>)/s,
        `$1\n${newRows}`
      );
      await apiFetch(`/content/${page.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          version: { number: page.version.number + 1 },
          title: 'Ordre',
          type: 'page',
          body: { storage: { value: existing, representation: 'storage' } },
        }),
      });
    } else {
      // Create page from scratch with just this order
      const content = buildFullPage([order]);
      await apiFetch('/content', {
        method: 'POST',
        body: JSON.stringify({
          type: 'page',
          title: 'Ordre',
          space: { key: space },
          body: { storage: { value: content, representation: 'storage' } },
        }),
      });
    }
  }

  async function updateStatus(orderId, newStatus) {
    const page = await findOrdrePage();
    if (!page) throw new Error('Ordre-siden finnes ikke i Confluence');

    let html = page.body.storage.value;
    // Find the rowspan cell containing orderId and update the last <td> in that rowspan group
    // Strategy: replace status cell in the row that contains orderId
    const idPattern = new RegExp(
      `(<td rowspan="\\d+">${orderId.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}<\\/td>[\\s\\S]*?<td rowspan="\\d+">)(Gitt tilbud|Godskjent tilbud|Bestilt)(<\\/td>)`,
      'i'
    );
    if (!idPattern.test(html)) throw new Error(`Fant ikke saksnummer ${orderId} i Confluence`);
    html = html.replace(idPattern, `$1${newStatus}$3`);

    await apiFetch(`/content/${page.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        version: { number: page.version.number + 1 },
        title: 'Ordre',
        type: 'page',
        body: { storage: { value: html, representation: 'storage' } },
      }),
    });
  }

  async function testConnection() {
    const { space } = cfg();
    const res = await apiFetch(`/space/${encodeURIComponent(space)}`);
    return res;
  }

  // Generate the HTML that would be added to Confluence (for manual copy fallback)
  function generateHtml(order) {
    return buildOrderRows(order);
  }

  return { publishOrder, updateStatus, testConnection, generateHtml, findOrdrePage };
})();
