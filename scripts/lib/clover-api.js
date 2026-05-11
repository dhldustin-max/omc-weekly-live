// scripts/lib/clover-api.js
//
// Clover REST API scraper for Hanshin Pocha Oakland. Replaces the
// Playwright-based scraper (which required interactive 2FA every ~7
// days). API token is permanent — Dustin created it in Clover Dashboard
// → Setup → API Tokens with Read permissions on Merchant + Orders +
// Payments. Stored in .env as CLOVER_API_TOKEN.
//
// Methodology:
//   1. Fetch all paid+locked orders in [startTs, endTs] via /orders
//      endpoint (paginated, limit 100/page).
//   2. Sum lineItems.price for revenue-bearing, non-refunded items.
//   3. This matches Clover's UI "SALES" line (Net Sales before tax /
//      tip / service-charge) within ~0.2% (Hanshin May 4-10: API
//      $17,932 vs Playwright UI $17,972).

export const CLOVER_HANSHIN_MERCHANT_ID = '30QNTPJA046M1';

// Fetch a single page of orders matching the date range.
async function fetchOrdersPage({ apiToken, merchantId, startTs, endTs, offset, limit = 100 }) {
  const params = new URLSearchParams({
    filter: `createdTime>=${startTs}`,
    limit: String(limit),
    offset: String(offset),
    expand: 'lineItems,payments',
  });
  // Second filter param needs to be appended manually (URLSearchParams replaces duplicate keys)
  const url = `https://api.clover.com/v3/merchants/${merchantId}/orders?${params}&filter=${encodeURIComponent('createdTime<=' + endTs)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!r.ok) throw new Error(`Clover API ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

// Fetch all orders matching the date range (handles pagination).
async function fetchAllOrders(opts) {
  let all = [];
  let offset = 0;
  while (true) {
    const data = await fetchOrdersPage({ ...opts, offset });
    const els = data.elements || [];
    all = all.concat(els);
    if (els.length < 100) break;
    offset += 100;
    if (offset > 5000) throw new Error('Pagination overflow > 5000 orders — adjust limit');
  }
  return all;
}

// Calculate Net Sales by summing lineItems prices for paid/locked
// revenue-bearing items. Matches Clover UI's "SALES" line.
function calcNetSales(orders) {
  let net = 0;
  let orderCount = 0;
  for (const o of orders) {
    if (o.state !== 'locked' || o.paymentState !== 'PAID') continue;
    for (const li of (o.lineItems?.elements || [])) {
      // isRevenue defaults to true if not present; explicit false means non-revenue
      if (li.isRevenue !== false && !li.refunded && !li.isOrderFee) {
        net += (li.price || 0) / 100;
      }
    }
    orderCount++;
  }
  return { netSales: net, orders: orderCount };
}

// Top-level: scrape Hanshin Net Sales + Orders for [startTs, endTs].
// Hanshin's Clover Business Day End is 11am — the same timestamps used
// by the Playwright scraper (lastBusinessWeekTimestamps) apply here too.
//
// Returns: { netSales, orders, scrapedAt, source: 'clover-api' }
// Throws on auth failure or pagination overflow.
export async function scrapeHanshinViaApi({ apiToken, startTs, endTs, merchantId = CLOVER_HANSHIN_MERCHANT_ID }) {
  if (!apiToken) throw new Error('CLOVER_API_TOKEN missing in .env');
  if (!startTs || !endTs) throw new Error('startTs and endTs are required');

  const allOrders = await fetchAllOrders({ apiToken, merchantId, startTs, endTs });
  const { netSales, orders } = calcNetSales(allOrders);

  return {
    netSales: Math.round(netSales * 100) / 100,
    orders,
    scrapedAt: new Date().toISOString(),
    source: 'clover-api',
  };
}
