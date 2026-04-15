// Quote App — main application logic
// State is kept in memory; persisted via GitHub API

const App = (() => {
  // ── State ────────────────────────────────────────────────────────────
  let state = {
    products: {},   // { PDA: [...], POS: [...], ... }
    prices: {},     // { 'CT45': { kundepris, varenummer }, ... }
    customers: {},  // { chains: { 'XL-Bygg': { stores, prices }, ... } }
    orders: [],     // [ { id, date, chain, store, status, items, total, margin } ]
    cart: {
      id: '',
      chain: '',
      store: '',
      items: [],  // [ { name, qty, unitPrice, innpris, category, isSetup, overridden } ]
    },
    activeCategory: '',
    ghLoaded: false,  // whether data has been loaded from GitHub
  };

  const SETUP_PRICES = { PDA: 1800, POS: 4950, Printer: 1490 };
  const STATUSES = ['Gitt tilbud', 'Godskjent tilbud', 'Bestilt'];
  const CAT_LABELS = { PDA: 'PDA', POS: 'POS / Kasse', Printer: 'Printer', Etiketter: 'Etiketter', Periferi: 'Periferi', Strom: 'Strøm' };

  // ── Toast ────────────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.className = '', 3000);
  }

  // ── Formatting helpers ───────────────────────────────────────────────
  function fmt(n) {
    if (n == null || isNaN(n)) return '–';
    return n.toLocaleString('nb-NO') + ',-';
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // ── Routing ──────────────────────────────────────────────────────────
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    const view = document.getElementById('view-' + name);
    if (view) view.classList.add('active');
    const btn = document.querySelector(`nav button[data-view="${name}"]`);
    if (btn) btn.classList.add('active');
    if (name === 'oversikt') renderOversikt();
    if (name === 'produkter') renderProdukter();
    if (name === 'kunder') renderKunder();
    if (name === 'priser') renderPriser();
  }

  // ── Data loading ─────────────────────────────────────────────────────
  async function loadData() {
    const token = localStorage.getItem('gh_token');
    const repo = localStorage.getItem('gh_repo');
    if (!token || !repo) {
      // Load from local data/ files (for local dev)
      await loadLocalData();
      return;
    }
    try {
      [state.products, state.prices, state.customers, state.orders] = await Promise.all([
        GitHub.readFile('data/products.json'),
        GitHub.readFile('data/prices.json'),
        GitHub.readFile('data/customers.json'),
        GitHub.readFile('data/orders.json').then(d => d.orders || []),
      ]);
      state.ghLoaded = true;
    } catch (e) {
      toast('GitHub-lasting feilet, bruker lokale data: ' + e.message, 'error');
      await loadLocalData();
    }
    initCart();
    renderCartView();
  }

  async function loadLocalData() {
    try {
      const [p, pr, c, o] = await Promise.all([
        fetch('data/products.json').then(r => r.json()),
        fetch('data/prices.json').then(r => r.json()),
        fetch('data/customers.json').then(r => r.json()),
        fetch('data/orders.json').then(r => r.json()),
      ]);
      state.products = p;
      state.prices = pr;
      state.customers = c;
      state.orders = o.orders || [];
    } catch (e) {
      toast('Kunne ikke laste lokale data: ' + e.message, 'error');
    }
  }

  async function saveFile(file, data, message) {
    if (!state.ghLoaded) return;
    await GitHub.writeFile(file, data, message);
  }

  // ── Cart helpers ─────────────────────────────────────────────────────
  function initCart() {
    state.cart = { id: '', chain: Object.keys(state.customers.chains || {})[0] || '', store: '', items: [] };
    state.activeCategory = Object.keys(state.products)[0] || '';
  }

  function effectivePrice(productName, chain) {
    const chainData = state.customers.chains?.[chain];
    if (chainData?.prices?.[productName] != null) {
      return { price: chainData.prices[productName], source: 'customer' };
    }
    const p = state.prices[productName];
    return { price: p?.kundepris ?? null, source: 'standard' };
  }

  function addToCart(name, category) {
    const { price, source } = effectivePrice(name, state.cart.chain);
    const item = {
      id: Date.now() + Math.random(),
      name,
      qty: 1,
      unitPrice: price,
      innpris: null,
      category,
      isSetup: false,
      overridden: false,
      priceSource: source,
    };
    state.cart.items.push(item);
    // Add setup price automatically
    const setupAmt = SETUP_PRICES[category];
    if (setupAmt) {
      state.cart.items.push({
        id: Date.now() + Math.random() + 1,
        name: 'Oppsettspris',
        qty: 1,
        unitPrice: setupAmt,
        innpris: null,
        category,
        isSetup: true,
        overridden: false,
        priceSource: 'standard',
      });
    }
    renderCartItems();
  }

  function removeFromCart(id) {
    state.cart.items = state.cart.items.filter(i => i.id !== id);
    renderCartItems();
  }

  function updateCartItem(id, field, value) {
    const item = state.cart.items.find(i => i.id === id);
    if (!item) return;
    if (field === 'qty') {
      const qty = Math.max(1, parseInt(value) || 1);
      item.qty = qty;
      // Sync setup item qty
      if (!item.isSetup && SETUP_PRICES[item.category]) {
        const setup = state.cart.items.find(s => s.isSetup && s.category === item.category);
        if (setup) setup.qty = qty;
      }
    } else if (field === 'unitPrice') {
      item.unitPrice = parseFloat(value) || 0;
      item.overridden = true;
    } else if (field === 'innpris') {
      item.innpris = parseFloat(value) || null;
    }
    renderCartItems();
  }

  function cartTotal() {
    return state.cart.items.reduce((s, i) => s + (i.qty * (i.unitPrice || 0)), 0);
  }

  function cartMargin() {
    const items = state.cart.items.filter(i => !i.isSetup);
    if (items.every(i => i.innpris == null)) return null;
    return items.reduce((s, i) => {
      if (i.innpris == null) return s;
      return s + (i.unitPrice - i.innpris) * i.qty;
    }, 0);
  }

  // ── Cart rendering ───────────────────────────────────────────────────
  function renderCartView() {
    renderChainSelector();
    renderCategoryTabs();
    renderProductList();
    renderCartItems();
  }

  function renderChainSelector() {
    const sel = document.getElementById('cart-chain');
    const chains = Object.keys(state.customers.chains || {});
    sel.innerHTML = chains.map(c => `<option value="${c}"${c === state.cart.chain ? ' selected' : ''}>${c}</option>`).join('');
    renderStoreSelector();
  }

  function renderStoreSelector() {
    const chain = state.cart.chain;
    const storeWrap = document.getElementById('cart-store-wrap');
    const storeSel = document.getElementById('cart-store');
    const stores = state.customers.chains?.[chain]?.stores || [];
    if (stores.length === 0) {
      storeWrap.style.display = 'none';
    } else {
      storeWrap.style.display = '';
      storeSel.innerHTML = `<option value="">– velg butikk –</option>` +
        stores.map(s => `<option value="${s}"${s === state.cart.store ? ' selected' : ''}>${s}</option>`).join('');
    }
  }

  function renderCategoryTabs() {
    const container = document.getElementById('category-tabs');
    container.innerHTML = Object.keys(state.products).map(cat =>
      `<button class="cat-btn${cat === state.activeCategory ? ' active' : ''}" data-cat="${cat}">${CAT_LABELS[cat] || cat}</button>`
    ).join('');
  }

  function renderProductList() {
    const container = document.getElementById('product-list');
    const products = state.products[state.activeCategory] || [];
    container.innerHTML = products.map(p =>
      `<button class="product-chip" data-name="${escHtml(p)}" data-cat="${state.activeCategory}">${escHtml(p)}</button>`
    ).join('') +
    `<button class="product-chip" data-name="__custom__" data-cat="${state.activeCategory}" style="color:var(--text-muted);font-style:italic">+ Annet</button>`;
  }

  function renderCartItems() {
    const tbody = document.getElementById('cart-tbody');
    const items = state.cart.items;

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Handlekurven er tom — klikk på produkter ovenfor for å legge til</td></tr>`;
    } else {
      tbody.innerHTML = items.map(item => {
        const total = (item.qty * (item.unitPrice || 0));
        const priceClass = item.overridden ? 'price-overridden' : item.priceSource === 'customer' ? 'price-customer' : '';
        const priceTitle = item.overridden ? 'Overstyr' : item.priceSource === 'customer' ? 'Kundepris' : 'Standardpris';
        return `<tr data-id="${item.id}" ${item.isSetup ? 'style="background:#fafafa;color:var(--text-muted)"' : ''}>
  <td>${escHtml(item.name)}${item.isSetup ? '' : ''}</td>
  <td><input type="number" class="inline" min="1" value="${item.qty}" onchange="App.updateItem('${item.id}','qty',this.value)"></td>
  <td>
    <input type="number" class="inline price-input ${priceClass}" title="${priceTitle}" value="${item.unitPrice ?? ''}" placeholder="pris"
      onchange="App.updateItem('${item.id}','unitPrice',this.value)">
  </td>
  <td>${item.isSetup ? '' : `<input type="number" class="inline" style="width:80px" value="${item.innpris ?? ''}" placeholder="innpris"
      onchange="App.updateItem('${item.id}','innpris',this.value)">`}</td>
  <td class="text-right">${fmt(total)}</td>
  <td><button class="btn btn-ghost btn-icon btn-sm" onclick="App.removeItem('${item.id}')" title="Fjern">✕</button></td>
</tr>`;
      }).join('');
    }

    // Totals
    document.getElementById('cart-total').textContent = fmt(cartTotal());
    const margin = cartMargin();
    document.getElementById('cart-margin').textContent = margin != null ? fmt(margin) : '–';

    // Publish button state
    const canPublish = state.cart.id && state.cart.chain && items.length > 0;
    document.getElementById('btn-publiser').disabled = !canPublish;
    document.getElementById('btn-kopier').disabled = items.length === 0;
  }

  // ── Cart actions ─────────────────────────────────────────────────────
  async function publiserTilbud() {
    const btn = document.getElementById('btn-publiser');
    if (!state.cart.id) { toast('Angi saksnummer', 'error'); return; }
    if (state.cart.items.length === 0) { toast('Legg til produkter', 'error'); return; }

    btn.innerHTML = '<span class="spinner"></span> Publiserer...';
    btn.disabled = true;

    const order = buildOrder();

    try {
      await Confluence.publishOrder(order);
      order.confluenceSynced = true;
    } catch (e) {
      order.confluenceSynced = false;
      if (e.message.includes('CORS') || e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
        showCopyFallback(order);
      } else {
        toast('Confluence feilet: ' + e.message, 'error');
      }
    }

    // Save order to GitHub regardless of Confluence result
    try {
      state.orders.unshift(order);
      await saveFile('data/orders.json', { orders: state.orders }, `ny ordre ${order.id}`);
      toast('Tilbud lagret!', 'success');
      initCart();
      renderCartView();
    } catch (e) {
      toast('GitHub lagring feilet: ' + e.message, 'error');
    }

    btn.innerHTML = 'Publiser til Confluence';
    btn.disabled = false;
  }

  function buildOrder() {
    const nonSetup = state.cart.items.filter(i => !i.isSetup);
    const setupItems = state.cart.items.filter(i => i.isSetup);
    return {
      id: state.cart.id,
      date: today(),
      chain: state.cart.chain,
      store: state.cart.store || null,
      status: 'Gitt tilbud',
      items: [...nonSetup, ...setupItems].map(i => ({
        name: i.name,
        qty: i.qty,
        unitPrice: i.unitPrice || 0,
        innpris: i.innpris,
        category: i.category,
        isSetup: i.isSetup,
      })),
      total: cartTotal(),
      margin: cartMargin(),
      confluenceSynced: false,
    };
  }

  function kopierKundemelding() {
    if (state.cart.items.length === 0) return;
    const lines = state.cart.items.map(i =>
      `- ${i.name} x${i.qty} — ${fmt(i.qty * (i.unitPrice || 0))}`
    ).join('\n');
    const text = `Hei,\n\nTakk for henvendelsen! Her er tilbudet vi har satt opp for dere:\n\n${lines}\n\nTotal eks. mva og frakt: ${fmt(cartTotal())}\n\nTa gjerne kontakt om det er spørsmål, eller om dere ønsker å godkjenne tilbudet.\n\nMed vennlig hilsen,\nPetter Bratli Elseth`;
    navigator.clipboard.writeText(text).then(() => toast('Kundemelding kopiert!', 'success'));
  }

  function showCopyFallback(order) {
    const html = Confluence.generateHtml(order);
    document.getElementById('copy-html-content').value = html;
    document.getElementById('copy-modal').classList.add('open');
  }

  // ── Oversikt ─────────────────────────────────────────────────────────
  function renderOversikt() {
    const tbody = document.getElementById('oversikt-tbody');
    if (state.orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Ingen tilbud ennå</td></tr>`;
      return;
    }
    tbody.innerHTML = state.orders.map(o => {
      const customer = o.store ? `${o.chain} ${o.store}` : o.chain;
      const badgeClass = o.status === 'Gitt tilbud' ? 'badge-gitt' : o.status === 'Godskjent tilbud' ? 'badge-godskjent' : 'badge-bestilt';
      return `<tr class="order-row" data-id="${o.id}">
  <td>${escHtml(o.id)}</td>
  <td>${escHtml(customer)}</td>
  <td>${o.date}</td>
  <td class="text-right">${fmt(o.total)}</td>
  <td>
    <div class="status-dropdown">
      <span class="badge ${badgeClass}" onclick="App.toggleStatusMenu('${o.id}',this)">${escHtml(o.status)}</span>
      <div class="status-menu" id="smenu-${o.id}">
        ${STATUSES.map(s => `<button onclick="App.setStatus('${o.id}','${s}')">${s}</button>`).join('')}
      </div>
    </div>
  </td>
  <td><button class="btn btn-ghost btn-sm" onclick="App.toggleDetail('${o.id}')">▼ Detaljer</button></td>
</tr>
<tr class="order-detail" id="detail-${o.id}">
  <td colspan="6">
    <strong>Varelinjer:</strong><br>
    ${o.items.map(i => `${escHtml(i.name)} x${i.qty} — ${fmt(i.qty * i.unitPrice)}`).join('<br>')}
    ${o.margin != null ? `<br><strong>Margin:</strong> ${fmt(o.margin)}` : ''}
  </td>
</tr>`;
    }).join('');
  }

  function toggleStatusMenu(orderId, badge) {
    const menu = document.getElementById('smenu-' + orderId);
    document.querySelectorAll('.status-menu').forEach(m => { if (m !== menu) m.classList.remove('open'); });
    menu.classList.toggle('open');
  }

  async function setStatus(orderId, newStatus) {
    document.getElementById('smenu-' + orderId)?.classList.remove('open');
    const order = state.orders.find(o => o.id === orderId);
    if (!order) return;
    const oldStatus = order.status;
    order.status = newStatus;

    try {
      await Confluence.updateStatus(orderId, newStatus);
    } catch (e) {
      toast('Confluence oppdatering feilet: ' + e.message, 'error');
      order.status = oldStatus;
      renderOversikt();
      return;
    }

    try {
      await saveFile('data/orders.json', { orders: state.orders }, `status ${orderId} → ${newStatus}`);
    } catch (e) {
      toast('GitHub feilet: ' + e.message, 'error');
    }

    renderOversikt();
    toast('Status oppdatert: ' + newStatus, 'success');
  }

  function toggleDetail(orderId) {
    const row = document.getElementById('detail-' + orderId);
    row.classList.toggle('open');
  }

  // ── Produkter view ───────────────────────────────────────────────────
  function renderProdukter() {
    const container = document.getElementById('produkter-content');
    container.innerHTML = Object.entries(state.products).map(([cat, items]) => `
<div class="category-group">
  <h3>${CAT_LABELS[cat] || cat}</h3>
  <table>
    <thead><tr><th>Produktnavn</th><th>Standardpris</th><th></th></tr></thead>
    <tbody>
      ${items.map(name => {
        const pr = state.prices[name];
        return `<tr>
  <td>${escHtml(name)}</td>
  <td>${pr?.kundepris != null ? fmt(pr.kundepris) : '<em class="text-muted">–</em>'}</td>
  <td class="text-right">
    <button class="btn btn-ghost btn-sm btn-danger" onclick="App.deleteProduct('${cat}','${escHtml(name).replace(/'/g,"\\'")}')">Slett</button>
  </td>
</tr>`;
      }).join('')}
    </tbody>
  </table>
  <div class="mt1">
    <button class="btn btn-secondary btn-sm" onclick="App.showAddProduct('${cat}')">+ Legg til i ${CAT_LABELS[cat] || cat}</button>
  </div>
</div>`).join('');
  }

  function showAddProduct(cat) {
    const name = prompt(`Nytt produktnavn i ${CAT_LABELS[cat] || cat}:`);
    if (!name?.trim()) return;
    const priceStr = prompt(`Standardpris for "${name}" (Enter for å hoppe over):`);
    const price = priceStr ? parseFloat(priceStr) : null;
    if (!state.products[cat]) state.products[cat] = [];
    state.products[cat].push(name.trim());
    state.prices[name.trim()] = { kundepris: price, varenummer: null };
    Promise.all([
      saveFile('data/products.json', state.products, `legg til produkt ${name}`),
      saveFile('data/prices.json', state.prices, `legg til pris ${name}`),
    ]).then(() => toast('Produkt lagt til', 'success')).catch(e => toast(e.message, 'error'));
    renderProdukter();
    renderProductList();
  }

  function deleteProduct(cat, name) {
    if (!confirm(`Slett "${name}"?`)) return;
    state.products[cat] = (state.products[cat] || []).filter(p => p !== name);
    delete state.prices[name];
    Promise.all([
      saveFile('data/products.json', state.products, `slett produkt ${name}`),
      saveFile('data/prices.json', state.prices, `slett pris ${name}`),
    ]).then(() => toast('Produkt slettet', 'success')).catch(e => toast(e.message, 'error'));
    renderProdukter();
  }

  // ── Kunder view ──────────────────────────────────────────────────────
  function renderKunder() {
    const container = document.getElementById('kunder-content');
    const chains = state.customers.chains || {};
    container.innerHTML = Object.entries(chains).map(([chain, data]) => `
<div class="card" style="margin-bottom:1rem">
  <div class="section-header">
    <strong>${escHtml(chain)}</strong>
    <button class="btn btn-ghost btn-sm btn-danger" onclick="App.deleteChain('${escHtml(chain)}')">Fjern kjede</button>
  </div>
  <div class="row" style="gap:2rem;align-items:flex-start;flex-wrap:wrap">
    <div style="min-width:160px">
      <div class="card-title">Butikker</div>
      ${(data.stores || []).map(s => `
        <div class="row row-center" style="margin-bottom:4px">
          <span>${escHtml(s)}</span>
          <button class="btn btn-ghost btn-sm" style="color:var(--eg-accent)" onclick="App.deleteStore('${escHtml(chain)}','${escHtml(s)}')">✕</button>
        </div>`).join('') || '<em class="text-muted">Ingen butikker</em>'}
      <button class="btn btn-secondary btn-sm mt1" onclick="App.addStore('${escHtml(chain)}')">+ Butikk</button>
    </div>
    <div style="flex:1;min-width:280px">
      <div class="card-title">Kundepriser (overskriver standard)</div>
      <table style="font-size:13px">
        <thead><tr><th>Produkt</th><th>Standardpris</th><th>Kundepris</th><th></th></tr></thead>
        <tbody>
          ${Object.entries(data.prices || {}).map(([prod, price]) => `
            <tr>
              <td>${escHtml(prod)}</td>
              <td class="text-muted">${fmt(state.prices[prod]?.kundepris)}</td>
              <td><input type="number" class="inline" style="width:90px" value="${price}"
                  onchange="App.updateChainPrice('${escHtml(chain)}','${escHtml(prod)}',this.value)"></td>
              <td><button class="btn btn-ghost btn-sm" onclick="App.removeChainPrice('${escHtml(chain)}','${escHtml(prod)}')">✕</button></td>
            </tr>`).join('') || `<tr><td colspan="4" class="text-muted" style="font-style:italic;padding:0.5rem 0">Ingen prisoverstyrelser – bruker standardpriser</td></tr>`}
        </tbody>
      </table>
      <button class="btn btn-secondary btn-sm mt1" onclick="App.addChainPrice('${escHtml(chain)}')">+ Legg til kundepris</button>
    </div>
  </div>
</div>`).join('') || '<p class="text-muted">Ingen kjeder registrert</p>';
  }

  function addChain() {
    const name = prompt('Navn på ny kjede:');
    if (!name?.trim()) return;
    if (state.customers.chains[name.trim()]) { toast('Kjeden finnes allerede', 'error'); return; }
    state.customers.chains[name.trim()] = { stores: [], prices: {} };
    saveFile('data/customers.json', state.customers, `legg til kjede ${name}`).catch(e => toast(e.message, 'error'));
    renderKunder();
    renderChainSelector();
  }

  function deleteChain(chain) {
    if (!confirm(`Fjern kjede "${chain}"?`)) return;
    delete state.customers.chains[chain];
    saveFile('data/customers.json', state.customers, `fjern kjede ${chain}`).catch(e => toast(e.message, 'error'));
    renderKunder();
    renderChainSelector();
  }

  function addStore(chain) {
    const name = prompt(`Ny butikk under ${chain}:`);
    if (!name?.trim()) return;
    state.customers.chains[chain].stores.push(name.trim());
    saveFile('data/customers.json', state.customers, `legg til butikk ${name}`).catch(e => toast(e.message, 'error'));
    renderKunder();
  }

  function deleteStore(chain, store) {
    state.customers.chains[chain].stores = state.customers.chains[chain].stores.filter(s => s !== store);
    saveFile('data/customers.json', state.customers, `fjern butikk ${store}`).catch(e => toast(e.message, 'error'));
    renderKunder();
  }

  function addChainPrice(chain) {
    const allProducts = Object.values(state.products).flat();
    const prod = prompt(`Produktnavn (feks. CT45):`);
    if (!prod?.trim() || !allProducts.includes(prod.trim())) { toast('Produkt ikke funnet', 'error'); return; }
    const priceStr = prompt(`Kundepris for ${prod} (standard: ${state.prices[prod.trim()]?.kundepris ?? '–'}):`);
    if (!priceStr) return;
    state.customers.chains[chain].prices[prod.trim()] = parseFloat(priceStr);
    saveFile('data/customers.json', state.customers, `kundepris ${chain} ${prod}`).catch(e => toast(e.message, 'error'));
    renderKunder();
  }

  function updateChainPrice(chain, prod, val) {
    state.customers.chains[chain].prices[prod] = parseFloat(val) || 0;
    saveFile('data/customers.json', state.customers, `oppdater kundepris ${chain} ${prod}`).catch(e => toast(e.message, 'error'));
  }

  function removeChainPrice(chain, prod) {
    delete state.customers.chains[chain].prices[prod];
    saveFile('data/customers.json', state.customers, `fjern kundepris ${chain} ${prod}`).catch(e => toast(e.message, 'error'));
    renderKunder();
  }

  // ── Priser view ──────────────────────────────────────────────────────
  function renderPriser() {
    const tbody = document.getElementById('priser-tbody');
    tbody.innerHTML = Object.entries(state.prices).map(([name, p]) => `
<tr>
  <td>${escHtml(name)}</td>
  <td><input type="number" class="inline" style="width:100px" value="${p.kundepris ?? ''}" placeholder="–"
      onchange="App.updatePrice('${escHtml(name)}','kundepris',this.value)"></td>
  <td><input type="text" class="inline" style="width:110px" value="${p.varenummer ?? ''}" placeholder="–"
      onchange="App.updatePrice('${escHtml(name)}','varenummer',this.value)"></td>
</tr>`).join('');
  }

  function updatePrice(name, field, value) {
    if (!state.prices[name]) return;
    state.prices[name][field] = field === 'kundepris' ? (parseFloat(value) || null) : (value.trim() || null);
    saveFile('data/prices.json', state.prices, `oppdater pris ${name}`).catch(e => toast(e.message, 'error'));
  }

  // ── Settings modal ───────────────────────────────────────────────────
  function openSettings() {
    document.getElementById('set-gh-token').value = localStorage.getItem('gh_token') || '';
    document.getElementById('set-gh-repo').value = localStorage.getItem('gh_repo') || '';
    document.getElementById('set-cf-url').value = localStorage.getItem('cf_url') || 'https://confluence.eg.dk';
    document.getElementById('set-cf-token').value = localStorage.getItem('cf_token') || '';
    document.getElementById('set-cf-space').value = localStorage.getItem('cf_space') || '~peels@eg.no';
    document.getElementById('settings-modal').classList.add('open');
  }

  function saveSettings() {
    localStorage.setItem('gh_token', document.getElementById('set-gh-token').value.trim());
    localStorage.setItem('gh_repo', document.getElementById('set-gh-repo').value.trim());
    localStorage.setItem('cf_url', document.getElementById('set-cf-url').value.trim());
    localStorage.setItem('cf_token', document.getElementById('set-cf-token').value.trim());
    localStorage.setItem('cf_space', document.getElementById('set-cf-space').value.trim());
    document.getElementById('settings-modal').classList.remove('open');
    toast('Innstillinger lagret — laster data på nytt...', 'success');
    loadData();
  }

  async function testGitHub() {
    localStorage.setItem('gh_token', document.getElementById('set-gh-token').value.trim());
    localStorage.setItem('gh_repo', document.getElementById('set-gh-repo').value.trim());
    try {
      const r = await GitHub.testConnection();
      toast(`GitHub OK: ${r.full_name}`, 'success');
    } catch (e) {
      toast('GitHub feilet: ' + e.message, 'error');
    }
  }

  async function testConfluence() {
    localStorage.setItem('cf_url', document.getElementById('set-cf-url').value.trim());
    localStorage.setItem('cf_token', document.getElementById('set-cf-token').value.trim());
    localStorage.setItem('cf_space', document.getElementById('set-cf-space').value.trim());
    try {
      const r = await Confluence.testConnection();
      toast(`Confluence OK: space "${r.name}"`, 'success');
    } catch (e) {
      toast('Confluence feilet: ' + e.message, 'error');
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Close menus on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.status-dropdown')) {
      document.querySelectorAll('.status-menu.open').forEach(m => m.classList.remove('open'));
    }
    if (!e.target.closest('.modal') && !e.target.closest('[onclick*="openSettings"]')) {
      // don't close modal on inside clicks
    }
  });

  // ── Init ─────────────────────────────────────────────────────────────
  function init() {
    // Nav
    document.querySelectorAll('nav button[data-view]').forEach(btn => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });

    // Category tabs
    document.getElementById('category-tabs').addEventListener('click', e => {
      const btn = e.target.closest('.cat-btn');
      if (!btn) return;
      state.activeCategory = btn.dataset.cat;
      renderCategoryTabs();
      renderProductList();
    });

    // Product chips
    document.getElementById('product-list').addEventListener('click', e => {
      const chip = e.target.closest('.product-chip');
      if (!chip) return;
      if (chip.dataset.name === '__custom__') {
        const name = prompt('Produktnavn:');
        if (!name?.trim()) return;
        const priceStr = prompt('Kundepris:');
        const price = parseFloat(priceStr) || null;
        const item = {
          id: Date.now(),
          name: name.trim(),
          qty: 1,
          unitPrice: price,
          innpris: null,
          category: state.activeCategory,
          isSetup: false,
          overridden: true,
          priceSource: 'manual',
        };
        state.cart.items.push(item);
        renderCartItems();
      } else {
        addToCart(chip.dataset.name, chip.dataset.cat);
      }
    });

    // Chain selector
    document.getElementById('cart-chain').addEventListener('change', e => {
      state.cart.chain = e.target.value;
      state.cart.store = '';
      renderStoreSelector();
    });

    document.getElementById('cart-store').addEventListener('change', e => {
      state.cart.store = e.target.value;
    });

    document.getElementById('cart-id').addEventListener('input', e => {
      state.cart.id = e.target.value.trim();
      renderCartItems();
    });

    document.getElementById('btn-kopier').addEventListener('click', kopierKundemelding);
    document.getElementById('btn-publiser').addEventListener('click', publiserTilbud);
    document.getElementById('btn-nullstill').addEventListener('click', () => {
      if (confirm('Nullstill handlekurven?')) { initCart(); renderCartView(); }
    });

    document.getElementById('btn-settings').addEventListener('click', openSettings);
    document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
    document.getElementById('btn-test-gh').addEventListener('click', testGitHub);
    document.getElementById('btn-test-cf').addEventListener('click', testConfluence);
    document.getElementById('btn-close-settings').addEventListener('click', () => {
      document.getElementById('settings-modal').classList.remove('open');
    });

    document.getElementById('btn-add-chain').addEventListener('click', addChain);

    document.getElementById('btn-copy-html').addEventListener('click', () => {
      const ta = document.getElementById('copy-html-content');
      ta.select();
      navigator.clipboard.writeText(ta.value).then(() => toast('HTML kopiert!', 'success'));
    });
    document.getElementById('btn-close-copy').addEventListener('click', () => {
      document.getElementById('copy-modal').classList.remove('open');
    });

    showView('handlekurv');
    loadData();
  }

  return {
    init,
    // Exposed for inline event handlers
    removeItem: removeFromCart,
    updateItem: updateCartItem,
    toggleStatusMenu,
    setStatus,
    toggleDetail,
    deleteProduct,
    showAddProduct,
    addStore,
    deleteStore,
    addChain,
    deleteChain,
    addChainPrice,
    updateChainPrice,
    removeChainPrice,
    updatePrice,
    openSettings,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
