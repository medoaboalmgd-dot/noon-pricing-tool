// Receives Apify run-succeeded webhook, syncs results to Supabase, sends Telegram alerts
const SUPABASE_URL = "https://mxddjewxppkwhlkvejtx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZGRqZXd4cHBrd2hsa3ZlanR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTk3NTQsImV4cCI6MjA5NjU5NTc1NH0.SBojidbDLTlcMi04BDGJlcsuq_V2kpXC0uN8Lcufwic";
const MY_ACCOUNT = "BESTQUALITYBESTPRICE";

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
};

const norm = (n) => (n || "").toUpperCase().replace(/\s+/g, "");
const today = () => new Date().toISOString().split("T")[0];

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const datasetId = req.body?.resource?.defaultDatasetId;
    if (!datasetId) return res.status(400).json({ error: "No dataset ID in webhook" });

    // 1. Get server token + telegram settings
    const setRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=in.(server,telegram)&select=key,value`, { headers: sbHeaders });
    const allSettings = await setRes.json();
    const apifyToken = allSettings.find(s => s.key === "server")?.value?.apifyToken;
    const tg = allSettings.find(s => s.key === "telegram")?.value;

    // 2. Fetch dataset items
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=2000`, {
      headers: apifyToken ? { Authorization: `Bearer ${apifyToken}` } : {},
    });
    const items = await itemsRes.json();
    if (!Array.isArray(items)) return res.status(500).json({ error: "Bad dataset response" });

    // 3. Fetch all products
    const prodRes = await fetch(`${SUPABASE_URL}/rest/v1/products?select=*`, { headers: sbHeaders });
    const products = await prodRes.json();
    const bySku = {};
    products.forEach(p => { if (p.sku) bySku[p.sku.toUpperCase()] = p; });

    // 4. Build updates + alerts
    const updates = [];
    const alerts = [];
    const foundSkus = new Set();

    for (const item of items) {
      const sku = item.sku?.toUpperCase();
      const p = bySku[sku];
      if (!p) continue;
      foundSkus.add(sku);

      const offers = item.offers || [];
      const lowestPrice = offers.length > 0 ? Math.min(...offers.map(o => parseFloat(o.price || 999999))) : null;
      const buyBoxSeller = offers[0]?.seller || null;
      const iHaveBuyBox = norm(buyBoxSeller) === norm(MY_ACCOUNT);
      const myOffer = offers.find(o => norm(o.seller) === norm(MY_ACCOUNT));
      const iAmSeller = !!myOffer;
      const myPrice = myOffer ? parseFloat(myOffer.price) : null;
      const prevPrice = p.noon_eg_price;
      const priceChanged = prevPrice !== null && prevPrice !== lowestPrice;

      if (p.i_have_buy_box && !iHaveBuyBox && iAmSeller) {
        alerts.push(`😱 خسرت الـ Buy Box!\n${(p.title || "").slice(0, 50)}\nSKU: ${p.sku}\nالواخدها: ${buyBoxSeller}`);
      }
      if (iAmSeller && lowestPrice && myPrice && lowestPrice < myPrice) {
        alerts.push(`⚠️ في أرخص منك!\n${(p.title || "").slice(0, 50)}\nSKU: ${p.sku}\nسعرك: ${myPrice} | الأرخص: ${lowestPrice}`);
      }

      const history = Array.isArray(p.price_history) ? [...p.price_history] : [];
      if (lowestPrice != null && (history.length === 0 || history[history.length - 1].p !== lowestPrice)) {
        history.push({ d: today(), p: lowestPrice });
        if (history.length > 30) history.shift();
      }

      updates.push({
        id: p.id,
        noon_eg_price: lowestPrice,
        prev_noon_eg_price: priceChanged ? prevPrice : p.prev_noon_eg_price,
        is_available: offers.some(o => o.availability?.includes("InStock")),
        price_changed_at: priceChanged ? today() : p.price_changed_at,
        sellers: offers,
        rating: item.aggregate_rating?.rating_value || null,
        review_count: item.aggregate_rating?.review_count || null,
        buy_box_seller: buyBoxSeller,
        i_have_buy_box: iHaveBuyBox,
        i_am_seller: iAmSeller,
        my_price: myPrice,
        not_found_eg: false,
        price_history: history,
        last_updated: today(),
      });
    }

    // Mark not found
    for (const p of products) {
      if (p.egypt_url && p.sku && !foundSkus.has(p.sku.toUpperCase())) {
        updates.push({ id: p.id, is_available: false, not_found_eg: true, last_updated: today() });
      }
    }

    // 5. Batch upsert (merge-duplicates updates only provided columns)
    if (updates.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/products`, {
        method: "POST",
        headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(updates),
      });
    }

    // 6. Telegram
    let sentAlerts = 0;
    if (tg?.botToken && tg?.chatId) {
      const summary = `🌅 التحديث اليومي خلص\n📦 اتحدّث: ${updates.length} منتج\n🔔 تنبيهات: ${alerts.length}`;
      const messages = [summary, ...alerts];
      let buffer = "";
      const chunks = [];
      for (const m of messages) {
        if ((buffer + "\n\n" + m).length > 3800) { chunks.push(buffer); buffer = m; }
        else buffer = buffer ? buffer + "\n\n" + m : m;
      }
      if (buffer) chunks.push(buffer);
      for (const chunk of chunks.slice(0, 5)) {
        await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tg.chatId, text: chunk }),
        });
        sentAlerts++;
      }
    }

    return res.json({ updated: updates.length, alerts: alerts.length, telegramMessages: sentAlerts });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
