const SUPABASE_URL = "https://mxddjewxppkwhlkvejtx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZGRqZXd4cHBrd2hsa3ZlanR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTk3NTQsImV4cCI6MjA5NjU5NTc1NH0.SBojidbDLTlcMi04BDGJlcsuq_V2kpXC0uN8Lcufwic";
const MY_ACCOUNT = "BESTQUALITYBESTPRICE";
const APIFY_EG = "saswave~noon-seller-monitoring";

export const config = { maxDuration: 60 };

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
};

const norm = (n) => (n || "").toUpperCase().replace(/\s+/g, "");
const fmtEGP = (n) => n != null ? `${Math.round(n).toLocaleString()} ج.م` : "—";

const getProducts = async () => {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/products?order=created_at.desc&select=*`, {
      headers: { ...sbHeaders, "Range-Unit": "items", "Range": `${from}-${from + pageSize - 1}` }
    });
    if (!res.ok) break;
    const page = await res.json();
    if (!page || page.length === 0) break;
    all = [...all, ...page];
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return all;
};

const getSetting = async (key) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.${key}&select=value`, { headers: sbHeaders });
  const data = await r.json();
  return data?.[0]?.value ?? null;
};

const sendMsg = async (chatId, text, token) => {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  const tg = await getSetting("telegram");
  const BOT_TOKEN = tg?.botToken;
  const ALLOWED_CHAT = tg?.chatId;
  if (!BOT_TOKEN) return res.status(200).json({ ok: true });

  const { message } = req.body;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = String(message.chat?.id);
  const text = message.text?.trim() || "";

  // Security: only respond to authorized chat
  if (chatId !== String(ALLOWED_CHAT)) {
    return res.status(200).json({ ok: true });
  }

  const reply = async (msg) => sendMsg(chatId, msg, BOT_TOKEN);

  try {
    // /start or /help
    if (text === "/start" || text === "/help") {
      await reply(
`🛒 <b>Noon Pricing Bot</b>

الأوامر المتاحة:
/status — ملخص عام
/buybox — منتجاتك Buy Box
/cheaper — في أرخص منك
/losers — المنتجات الخاسرة
/notfound — مش موجودة على مصر
/product SKU — تفاصيل منتج
/update — تحديث أسعار مصر
/report — تقرير يومي كامل
/scrape [لينك] — سكراب كاتيجوري نون UAE`
      );
    }

    // /status
    else if (text === "/status") {
      const products = await getProducts();
      const total = products.length;
      const buybox = products.filter(p => p.i_have_buy_box).length;
      const cheaper = products.filter(p => p.i_am_seller && !p.i_have_buy_box).length;
      const losers = products.filter(p => p.noon_eg_price && p.selling_price && parseFloat(p.noon_eg_price) < parseFloat(p.selling_price)).length;
      const notFound = products.filter(p => p.not_found_eg).length;
      const notSelling = products.filter(p => p.noon_eg_price != null && !p.i_am_seller).length;
      const scraped = products.filter(p => p.noon_eg_price != null).length;

      await reply(
`📊 <b>ملخص الآن</b>

📦 إجمالي المنتجات: <b>${total}</b>
✅ تم سكرابهم: <b>${scraped}</b>
🏆 Buy Box عندك: <b>${buybox}</b>
⚠️ في أرخص منك: <b>${cheaper}</b>
🔴 منتجات خاسرة: <b>${losers}</b>
🚫 مش عارضها: <b>${notSelling}</b>
❓ مش موجودة: <b>${notFound}</b>`
      );
    }

    // /buybox
    else if (text === "/buybox") {
      const products = await getProducts();
      const list = products.filter(p => p.i_have_buy_box).slice(0, 20);
      if (list.length === 0) return await reply("مفيش منتجات Buy Box دلوقتي");
      const lines = list.map(p => `• ${p.sku} — ${p.title?.slice(0,30)} — ${fmtEGP(p.my_price)}`).join("\n");
      await reply(`🏆 <b>منتجاتك Buy Box (${list.length})</b>\n\n${lines}`);
    }

    // /cheaper
    else if (text === "/cheaper") {
      const products = await getProducts();
      const list = products.filter(p => p.i_am_seller && !p.i_have_buy_box).slice(0, 20);
      if (list.length === 0) return await reply("✅ مفيش حد أرخص منك دلوقتي!");
      const lines = list.map(p => {
        const cheapest = p.noon_eg_price;
        const mine = p.my_price;
        const diff = mine && cheapest ? mine - cheapest : null;
        return `• ${p.sku}\n  سعرك: ${fmtEGP(mine)} | الأرخص: ${fmtEGP(cheapest)} | الفرق: ${diff ? fmtEGP(diff) : "—"}`;
      }).join("\n\n");
      await reply(`⚠️ <b>في أرخص منك (${list.length})</b>\n\n${lines}`);
    }

    // /losers
    else if (text === "/losers") {
      const products = await getProducts();
      const list = products.filter(p => p.noon_eg_price && p.selling_price && parseFloat(p.noon_eg_price) < parseFloat(p.selling_price)).slice(0, 20);
      if (list.length === 0) return await reply("✅ مفيش منتجات خاسرة!");
      const lines = list.map(p => `• ${p.sku}\n  سعر مصر: ${fmtEGP(p.noon_eg_price)} | سعر بيعك: ${fmtEGP(p.selling_price)}`).join("\n\n");
      await reply(`🔴 <b>منتجات خاسرة (${list.length})</b>\n\n${lines}`);
    }

    // /notfound
    else if (text === "/notfound") {
      const products = await getProducts();
      const list = products.filter(p => p.not_found_eg).slice(0, 30);
      if (list.length === 0) return await reply("✅ كل منتجاتك موجودة على نون مصر!");
      const lines = list.map(p => `• ${p.sku} — ${p.title?.slice(0,30)}`).join("\n");
      await reply(`❓ <b>مش موجودة على نون مصر (${list.length})</b>\n\n${lines}`);
    }

    // /product SKU
    else if (text.startsWith("/product ")) {
      const sku = text.replace("/product ", "").trim().toUpperCase();
      const products = await getProducts();
      const p = products.find(x => x.sku?.toUpperCase() === sku);
      if (!p) return await reply(`❌ مش لاقي المنتج: ${sku}`);

      const sellers = Array.isArray(p.sellers) ? p.sellers : [];
      const sellersText = sellers.length > 0
        ? sellers.map((s, i) => `${i === 0 ? "🏆" : "  "} ${s.seller}${norm(s.seller) === norm(MY_ACCOUNT) ? " (أنت)" : ""} — ${fmtEGP(parseFloat(s.price))}${s.rating ? ` ⭐${s.rating}` : ""}`).join("\n")
        : "لم يُسكرب";

      await reply(
`📦 <b>${p.title?.slice(0,50)}</b>
SKU: <code>${p.sku}</code>
براند: ${p.brand || "—"}

💰 سعر UAE: ${p.uae_price ? `${p.uae_price} د.إ` : "—"}
🇪🇬 سعر مصر: ${fmtEGP(p.noon_eg_price)}
💵 سعر بيعك: ${fmtEGP(p.selling_price)}
📈 هامش: ${p.selling_price && p.cost ? `${(((p.selling_price - p.cost) / p.selling_price) * 100).toFixed(1)}%` : "—"}

🏪 البائعين:
${sellersText}

⭐ تقييم: ${p.rating ? `${p.rating} (${p.review_count} تقييم)` : "—"}
📅 آخر تحديث: ${p.last_updated || "—"}`
      );
    }

    // /report
    else if (text === "/report") {
      const products = await getProducts();
      const total = products.length;
      const scraped = products.filter(p => p.noon_eg_price != null).length;
      const buybox = products.filter(p => p.i_have_buy_box).length;
      const cheaper = products.filter(p => p.i_am_seller && !p.i_have_buy_box).length;
      const losers = products.filter(p => p.noon_eg_price && p.selling_price && parseFloat(p.noon_eg_price) < parseFloat(p.selling_price)).length;
      const notFound = products.filter(p => p.not_found_eg).length;
      const notSelling = products.filter(p => p.noon_eg_price != null && !p.i_am_seller).length;
      const changed = products.filter(p => p.prev_noon_eg_price && p.prev_noon_eg_price !== p.noon_eg_price).length;
      const margins = products.filter(p => p.selling_price && p.cost).map(p => ((p.selling_price - p.cost) / p.selling_price) * 100);
      const avgMargin = margins.length ? (margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(1) : 0;

      // Top losers
      const topLosers = products
        .filter(p => p.noon_eg_price && p.selling_price && parseFloat(p.noon_eg_price) < parseFloat(p.selling_price))
        .sort((a, b) => (parseFloat(a.noon_eg_price) - parseFloat(a.selling_price)) - (parseFloat(b.noon_eg_price) - parseFloat(b.selling_price)))
        .slice(0, 5);

      const losersText = topLosers.length > 0
        ? topLosers.map(p => `• ${p.sku} — خسارة ${fmtEGP(parseFloat(p.selling_price) - parseFloat(p.noon_eg_price))}`).join("\n")
        : "لا يوجد";

      await reply(
`📋 <b>التقرير اليومي</b>
${new Date().toLocaleDateString("ar-EG")}

📦 إجمالي: <b>${total}</b> | مسكرب: <b>${scraped}</b>
🏆 Buy Box: <b>${buybox}</b>
⚠️ في أرخص: <b>${cheaper}</b>
🔴 خاسرة: <b>${losers}</b>
🚫 مش عارض: <b>${notSelling}</b>
❓ مش موجود: <b>${notFound}</b>
📉 تغير سعرها: <b>${changed}</b>
📈 متوسط هامش: <b>${avgMargin}%</b>

🔴 <b>أكبر خسائر:</b>
${losersText}`
      );
    }

    // /update
    else if (text === "/update") {
      await reply("⏳ جاري تشغيل التحديث اليومي...");
      const serverSetting = await getSetting("server");
      const apifyToken = serverSetting?.apifyToken;
      if (!apifyToken) return await reply("❌ مفيش Apify Token في الإعدادات");

      const products = await getProducts();
      const toScrape = products.filter(p => p.egypt_url).map(p => p.sku).filter(Boolean);

      const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_EG}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apifyToken}` },
        body: JSON.stringify({
          asins: toScrape.slice(0, 100),
          noon_domain: "www.noon.com/egypt-en",
          use_apify_dataset: true,
        }),
      });

      if (!runRes.ok) return await reply("❌ فشل تشغيل السكراب");
      const runData = await runRes.json();
      await reply(`✅ اتشغّل السكراب على ${Math.min(toScrape.length, 100)} منتج\nRun ID: ${runData.data?.id}\nهتوصلك تنبيه لما يخلص`);
    }

    // /scrape URL
    else if (text.startsWith("/scrape ")) {
      const url = text.replace("/scrape ", "").trim();
      if (!url.startsWith("http")) return await reply("❌ حط لينك صحيح بعد /scrape");

      const serverSetting = await getSetting("server");
      const apifyToken = serverSetting?.apifyToken;
      if (!apifyToken) return await reply("❌ مفيش Apify Token في الإعدادات");

      await reply(`⏳ جاري السكراب على:
${url}`);

      try {
        const runRes = await fetch(`https://api.apify.com/v2/acts/shahidirfan~noon-com-scraper/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apifyToken}` },
          body: JSON.stringify({ startUrl: url, maxProducts: 100, maxPages: 5 }),
        });
        if (!runRes.ok) throw new Error(`فشل تشغيل الـ Actor: ${runRes.status}`);
        const runData = await runRes.json();
        const runId = runData.data?.id;
        const datasetId = runData.data?.defaultDatasetId;

        // Poll
        let succeeded = false;
        for (let a = 0; a < 60; a++) {
          await new Promise(r => setTimeout(r, 5000));
          const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers: { Authorization: `Bearer ${apifyToken}` } });
          const stData = await st.json();
          const status = stData.data?.status;
          const count = stData.data?.stats?.itemCount || 0;
          if (status === "SUCCEEDED") { succeeded = true; break; }
          if (status === "FAILED" || status === "ABORTED") throw new Error(`السكراب ${status}`);
        }
        if (!succeeded) throw new Error("انتهى الوقت");

        // Get results
        const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=500`, { headers: { Authorization: `Bearer ${apifyToken}` } });
        const items = await itemsRes.json();

        // Get AED rate
        const rateSetting = await getSetting("aed_rate");
        const aedRate = rateSetting?.rate || 13.6;

        // Get existing SKUs
        const products = await getProducts();
        const existingSkus = new Set(products.map(p => p.sku?.toUpperCase()));

        const toAdd = [];
        const toUpdate = [];

        for (const item of items) {
          if (!item.url) continue;
          const skuMatch = item.url.match(/\/([NZ][A-Z0-9]{5,})\//i);
          const sku = skuMatch ? skuMatch[1].toUpperCase() : null;
          if (!sku) continue;

          const egUrl = item.url.replace("noon.com/uae-en/", "noon.com/egypt-en/").split("?")[0];
          const uaePrice = parseFloat(item.currentPrice || 0);
          const cost = uaePrice > 0 ? uaePrice * aedRate : null;
          const sellingPrice = cost ? cost * 1.6 : null;

          const product = {
            id: sku, sku, sku_type: sku.startsWith("N") ? "N" : "Z",
            title: item.title || "", brand: item.brand || "", image: item.image || "",
            uae_url: item.url, egypt_url: egUrl,
            uae_price: uaePrice || null, noon_eg_price: null, prev_noon_eg_price: null,
            is_available: null, shipping: 0, cost, selling_price: sellingPrice,
            sellers: null, rating: null, review_count: null,
            buy_box_seller: null, i_have_buy_box: false, i_am_seller: false, my_price: null,
            added_date: new Date().toISOString().split("T")[0],
            added_by: "telegram", last_updated: new Date().toISOString().split("T")[0],
            price_changed_at: null, last_uae_scrape: new Date().toISOString(),
            not_found_uae: false, not_found_eg: false,
          };

          if (existingSkus.has(sku)) toUpdate.push(product);
          else toAdd.push(product);
        }

        // Save in batches of 100
        for (let b = 0; b < toAdd.length; b += 100) {
          await fetch(`${SUPABASE_URL}/rest/v1/products`, {
            method: "POST",
            headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(toAdd.slice(b, b + 100)),
          });
        }
        for (const p of toUpdate) {
          await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${p.id}`, {
            method: "PATCH",
            headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify({ uae_price: p.uae_price, cost: p.cost, selling_price: p.selling_price, last_uae_scrape: p.last_uae_scrape }),
          });
        }

        await reply(
`✅ <b>اتسكرب بنجاح!</b>

📦 إجمالي المنتجات: ${items.length}
➕ أضيف جديد: ${toAdd.length}
🔄 اتحدّث: ${toUpdate.length}
🔗 الكاتيجوري: ${url.slice(0, 60)}`
        );
      } catch (e) {
        await reply(`❌ خطأ في السكراب: ${e.message}`);
      }
    }

    else {
      await reply("❓ أمر مش معروف — اكتب /help لقايمة الأوامر");
    }

  } catch (e) {
    await reply(`❌ خطأ: ${e.message}`);
  }

  return res.status(200).json({ ok: true });
}
