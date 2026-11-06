import { plain, parseCatalog } from './coolpc-catalog.mjs';

export const SOURCES = {
  coolpc: 'https://www.coolpc.com.tw/evaluate.php',
  sinya: 'https://www.sinya.com.tw/diy/',
  autobuy: 'https://www.autobuy.tw/diy'
};
const conditional = /搭板|搭機|限搭|任搭|組裝價|裝機價|裝機配|會員價|組合|套裝|獨家|限組|限購|加購|優惠碼|折價券|折扣碼|coupon|combo/i;
function attribute(s, name) {
  const m = s.match(new RegExp('\\b'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'));
  return m ? plain(m[1] ?? m[2] ?? m[3]) : '';
}
function row(source, id, name, price, group, capturedAt) {
  return { source, sourceProductId: id, name, model: name, price, group,
    priceLabel: 'public_item_price', url: SOURCES[source], capturedAt };
}
export function parseSource(source, html, capturedAt = new Date().toISOString()) {
  if (!SOURCES[source]) throw Error('unsupported_source');
  let products = [];
  if (source === 'coolpc') {
    products = parseCatalog(html).products.map(p => row(source,p.id,p.name,p.price,p.group,capturedAt));
  } else if (source === 'autobuy') {
    // AUTOBUY encodes the actual item price in BOTH option[name] and ☆…元.
    // Require agreement. Never infer a price from CPU/GPU model numbers.
    const seen = new Set();
    for (const select of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      if (!/\bdiy_products\b/.test(attribute(select[1],'class'))) continue;
      let group = '';
      for (const token of select[2].matchAll(/<optgroup\b([^>]*)>|<\/optgroup\s*>|<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/?optgroup\b|$)/gi)) {
        if (token[1] !== undefined) { group = attribute(token[1],'label'); continue; }
        if (token[3] === undefined) { group = ''; continue; }
        const id = attribute(token[2],'value'), value = attribute(token[2],'name');
        const text = plain(token[3]), match = text.match(/☆\s*([\d,]+)\s*元[↘↗↑↓\s]*$/);
        if (!/^\d+$/.test(id) || id==='0' || !/^\d+$/.test(value) || !match || /\bdisabled\b/i.test(token[2])) continue;
        const price = Number(value), name = text.slice(0,match.index).trim();
        if (price !== Number(match[1].replaceAll(',','')) || price <= 0 || conditional.test(name+' '+group) || seen.has(id)) continue;
        seen.add(id); products.push(row(source,id,name,price,group,capturedAt));
      }
    }
  } else {
    // Only accept explicit Product/Offer structured data from Sinya itself.
    // Unknown HTML and error/challenge pages fail closed, never become prices.
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const types = [].concat(value['@type'] || []);
      if (types.includes('Product')) {
        const offers = [].concat(value.offers || []).filter(o => o?.['@type']==='Offer' && o.priceCurrency==='TWD' && /^https:\/\/(?:www\.)?sinya\.com\.tw\//.test(o.url || value.url || ''));
        if (offers.length===1 && !conditional.test(value.name||'')) {
          const offer=offers[0], price=Number(offer.price);
          if (Number.isFinite(price) && price>0 && value.name) products.push({...row(source,String(value.sku||value.url||''),plain(value.name),price,'',capturedAt),url:offer.url||value.url});
        }
      }
      if (value['@graph']) visit(value['@graph']);
      if (value.itemListElement) value.itemListElement.forEach(x=>visit(x.item||x));
    };
    for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { visit(JSON.parse(script[1])); } catch (_) { /* malformed JSON is not evidence */ }
    }
  }
  if (!products.length) throw Error('no_verified_product_prices');
  return {schemaVersion:1,source,capturedAt,products};
}
