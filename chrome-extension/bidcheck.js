(() => {
  const r = {};
  const el = document.querySelector('.current-amount');
  r['1_current-amount_exists'] = !!el;
  r['2_its_text'] = el ? JSON.stringify(el.innerText) : null;
  const card = document.querySelector('.pickArea [data-testid="player-selected"], .pickArea .player-selected, .pickArea');
  r['3_card_found'] = !!card;
  r['4_card_has_current-amount'] = !!(card && card.querySelector('.current-amount'));
  const m = el && el.innerText.match(/\$\s?([\d,]+)/);
  r['5_parsed_bid'] = m ? parseInt(m[1].replace(/,/g,''),10) : null;
  const mx = document.querySelector('.manual-bid');
  r['6_manual-bid_text'] = mx ? JSON.stringify(mx.innerText) : null;
  r['7_EXTENSION_LOADED'] = !!window.__GRIDIRON_EDGE_VERSION__ || 'marker missing — see note';
  console.table(r);
  return r;
})();
