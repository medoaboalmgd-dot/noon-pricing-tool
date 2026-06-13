import { useState, useEffect, useCallback } from "react";

// ===================== CONFIG =====================
const SUPABASE_URL = "https://mxddjewxppkwhlkvejtx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZGRqZXd4cHBrd2hsa3ZlanR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTk3NTQsImV4cCI6MjA5NjU5NTc1NH0.SBojidbDLTlcMi04BDGJlcsuq_V2kpXC0uN8Lcufwic";
const APIFY_UAE = "shahidirfan~noon-com-scraper";
const APIFY_EG = "saswave~noon-seller-monitoring";
const MY_ACCOUNT = "BESTQUALITYBESTPRICE";
const UAE_COOLDOWN_HOURS = 73;
const EG_COOLDOWN_HOURS = 24;
const PAGE_SIZE = 50;

// ===================== SUPABASE =====================
const sb = async (path, opts = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "return=representation",
      ...opts.headers,
    },
    ...opts,
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Supabase: ${res.status} ${err}`); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const db = {
  getProducts: async () => {
    const pageSize = 1000;
    let all = [];
    let from = 0;
    while (true) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/products?order=created_at.desc&select=*`, {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
          "Range-Unit": "items",
          "Range": `${from}-${from + pageSize - 1}`,
        }
      });
      if (!res.ok) break;
      const page = await res.json();
      if (!page || page.length === 0) break;
      all = [...all, ...page];
      if (page.length < pageSize) break;
      from += pageSize;
    }
    return all;
  },
  upsertProducts: (arr) => sb("products", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: JSON.stringify(arr) }),
  updateProduct: (id, data) => sb(`products?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteProduct: (id) => sb(`products?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" }),
  getSetting: async (key) => { const r = await sb(`settings?key=eq.${encodeURIComponent(key)}&select=value`); return r?.[0]?.value ?? null; },
  getFriendlySellers: () => sb("friendly_sellers?order=created_at.desc&select=*"),
  addFriendlySeller: (data) => sb("friendly_sellers", { method: "POST", prefer: "return=representation", body: JSON.stringify(data) }),
  deleteFriendlySeller: (id) => sb(`friendly_sellers?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" }),
  setSetting: (key, value) => sb("settings", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: JSON.stringify({ key, value }) }),
};

// ===================== UTILS =====================
const extractSKU = (url) => { if (!url) return null; const m = url.match(/\/([NZ][A-Z0-9]{5,})\//i); return m ? m[1].toUpperCase() : null; };
const buildEgyptUrl = (sku, uaeUrl) => {
  if (uaeUrl) return uaeUrl.replace("noon.com/uae-en/", "noon.com/egypt-en/").split("?")[0];
  return sku ? `https://www.noon.com/egypt-en/${sku}/p/` : null;
};
const skuType = (sku) => !sku ? "?" : sku.startsWith("N") ? "N" : sku.startsWith("Z") ? "Z" : "?";
const calcCost = (price, aedRate, shipping) => parseFloat(price) * parseFloat(aedRate) + parseFloat(shipping || 0);
const calcCostWithShop = (p, aedRate) => {
  const shipping = parseFloat(p.shipping || 0);
  if (p.shop_price && p.shop_price > 0) {
    return parseFloat(p.shop_price) * parseFloat(aedRate) + shipping;
  }
  return p.uae_price > 0 ? calcCost(p.uae_price, aedRate, shipping) : null;
};

const roundPrice = (price) => {
  if (!price || price <= 0) return price;
  const candidates = [];
  const base = Math.floor(price / 100) * 100;
  for (let i = -1; i <= 2; i++) {
    candidates.push(base + i * 100 + 49);
    candidates.push(base + i * 100 + 99);
  }
  let best = candidates[0];
  let bestDiff = Math.abs(price - candidates[0]);
  for (const c of candidates) {
    const diff = Math.abs(price - c);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return best;
};
const calcSelling = (cost) => roundPrice(cost * 1.6);
const calcMaxPrice = (cost) => roundPrice(cost * 1.65);
const calcMinPrice = (cost) => cost * 1.35; // No rounding for min (floor check)

const calcSuggestedPrice = (cost, competitorPrice) => {
  if (!cost) return null;
  const minPrice = cost * 1.35;
  const maxPrice = roundPrice(cost * 1.65);
  // No competitor or competitor above max → use max
  if (!competitorPrice || competitorPrice > maxPrice) return maxPrice;
  // Competitor below min → can't compete, use min
  if (competitorPrice <= minPrice) return roundPrice(minPrice);
  // Competitor between min and max → undercut by 20
  const suggested = competitorPrice - 20;
  return suggested < minPrice ? roundPrice(minPrice) : roundPrice(suggested);
};
const calcMargin = (sell, cost) => cost > 0 ? (((sell - cost) / sell) * 100).toFixed(1) : 0;
const calcNetProfit = (sell, cost, commissionPct) => sell * (1 - commissionPct / 100) - cost;
const fmtEGP = (n) => n != null ? `${Math.round(n).toLocaleString("ar-EG")} ج.م` : "—";
const fmtAED = (n) => n != null ? `${parseFloat(n).toFixed(2)} د.إ` : "—";
const today = () => new Date().toISOString().split("T")[0];
const hoursAgo = (ts) => ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : 99999;
const normalizeSellerName = (name) => (name || "").toUpperCase().replace(/\s+/g, "");

// ===================== TELEGRAM =====================
const sendTelegram = async (text) => {
  try {
    const tg = await db.getSetting("telegram");
    if (!tg?.botToken || !tg?.chatId) return false;
    const res = await fetch("/api/send-telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: tg.botToken, chatId: tg.chatId, text }),
    });
    return res.ok;
  } catch { return false; }
};

// ===================== APIFY =====================
const apifyRun = async (actorId, input, token, retries = 3) => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 5000 * attempt));
      const runRes = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      });
      if (!runRes.ok) throw new Error(`Actor run failed: ${runRes.status}`);
      const runData = await runRes.json();
      const runId = runData.data?.id;
      const datasetId = runData.data?.defaultDatasetId;
      let finalStatus = "";
      for (let a = 0; a < 40; a++) {
        await new Promise(r => setTimeout(r, 4000));
        const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } });
        const stData = await st.json();
        finalStatus = stData.data?.status;
        if (finalStatus === "SUCCEEDED" || finalStatus === "FAILED" || finalStatus === "ABORTED") break;
      }
      // FAILED can mean "0 products found" for this actor — return dataset anyway (may be empty)
      const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=1000`, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
    }
  }
};

// ===================== LOGIN GATE =====================
const LoginGate = ({ onAuth }) => {
  const [code, setCode] = useState("");
  const [mode, setMode] = useState("loading"); // loading | login | setup
  const [error, setError] = useState("");

  useEffect(() => {
    db.getSetting("access_code").then(v => setMode(v?.code ? "login" : "setup")).catch(() => setMode("login"));
  }, []);

  const submit = async () => {
    setError("");
    if (!code.trim()) return;
    if (mode === "setup") {
      await db.setSetting("access_code", { code: code.trim() });
      localStorage.setItem("noon_access", "ok");
      onAuth();
    } else {
      const v = await db.getSetting("access_code");
      if (v?.code === code.trim()) {
        localStorage.setItem("noon_access", "ok");
        onAuth();
      } else setError("❌ الكود غلط");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#1e1b4b,#4338ca)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI',Tahoma,sans-serif" }} dir="rtl">
      <div style={{ background: "#fff", borderRadius: 20, padding: 36, width: 360, textAlign: "center", boxShadow: "0 25px 60px rgba(0,0,0,0.4)" }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🛒</div>
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Noon Pricing Tool</div>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 24 }}>
          {mode === "setup" ? "🔐 أول مرة — اعمل كود دخول للأداة" : "🔐 اكتب كود الدخول"}
        </div>
        {mode !== "loading" && (
          <>
            <input
              type="password"
              value={code}
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              placeholder={mode === "setup" ? "اختار كود سري" : "كود الدخول"}
              style={{ width: "100%", padding: "12px 16px", border: "2px solid #e2e8f0", borderRadius: 10, fontSize: 15, textAlign: "center", boxSizing: "border-box", marginBottom: 12 }}
              autoFocus
            />
            {error && <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 10 }}>{error}</div>}
            <button onClick={submit} style={{ width: "100%", background: "#6366f1", color: "#fff", border: "none", padding: "12px", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
              {mode === "setup" ? "✅ إنشاء الكود والدخول" : "دخول"}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

// ===================== SKU IMPORT MODAL =====================
const SkuImportModal = ({ onClose, onDone, userName, products }) => {
  const [skus, setSkus] = useState([]);
  const [fileName, setFileName] = useState("");
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const log = (msg, type = "info") => setLogs(l => [...l, { msg, type, time: new Date().toLocaleTimeString("ar-EG") }]);

  const cleanSKU = (raw) => {
    if (!raw) return null;
    const cleaned = raw.toString().trim().replace(/-\d+$/, "").toUpperCase();
    if (!/^[NZ]/i.test(cleaned)) return null;
    return cleaned;
  };

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
    if (isExcel) {
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          script.onload = resolve; script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      const reader = new FileReader();
      reader.onload = (evt) => {
        const wb = window.XLSX.read(evt.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1 });
        const parsed = [];
        for (const row of rows) {
          for (const cell of row) {
            const sku = cleanSKU(String(cell || ''));
            if (sku && !parsed.includes(sku)) parsed.push(sku);
          }
        }
        setSkus(parsed);
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target.result;
        const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
        const parsed = [];
        for (const line of lines) {
          const parts = line.split(/[,\t]/);
          for (const part of parts) {
            const sku = cleanSKU(part);
            if (sku && !parsed.includes(sku)) parsed.push(sku);
          }
        }
        setSkus(parsed);
      };
      reader.readAsText(file);
    }
  };

  const run = async () => {
    if (skus.length === 0) { alert("مفيش SKUs"); return; }
    const token = localStorage.getItem(`apify_token_${userName}`);
    if (!token) { alert("سجل الـ API Token في الإعدادات"); return; }
    setRunning(true);

    // Cooldown check
    const productMap = {};
    products.forEach(p => { if (p.sku) productMap[p.sku.toUpperCase()] = p; });
    const toScrape = [];
    let skipped = 0;
    for (const sku of skus) {
      const existing = productMap[sku];
      if (existing && hoursAgo(existing.last_uae_scrape) < UAE_COOLDOWN_HOURS) {
        skipped++;
      } else if (sku.startsWith("Z") && existing?.i_am_seller) {
        skipped++; // Skip Z products we sell in Egypt
      } else {
        toScrape.push(sku);
      }
    }
    log(`📋 إجمالي: ${skus.length} | هيتسكرب: ${toScrape.length} | متخطي (اتسكرب آخر ${UAE_COOLDOWN_HOURS} ساعة): ${skipped}`);

    const aedSetting = await db.getSetting("aed_rate");
    const aedRate = aedSetting?.rate || 13.6;
    const existingSkus = new Set(products.map(p => p.sku?.toUpperCase()));
    const allProducts = [];

    for (let i = 0; i < toScrape.length; i++) {
      const sku = toScrape[i];
      setProgress(Math.round(((i + 1) / toScrape.length) * 100));
      try {
        const url = `https://www.noon.com/uae-en/search/?q=${sku}`;
        const items = await apifyRun(APIFY_UAE, { startUrl: url, maxProducts: 1, maxPages: 1 }, token);
        if (items.length > 0) {
          const item = items[0];
          const realSku = extractSKU(item.url) || sku;
          const egUrl = buildEgyptUrl(realSku, item.url);
          const uaePrice = parseFloat(item.currentPrice || 0);
          const cost = uaePrice > 0 ? calcCost(uaePrice, aedRate, 0) : null;
          allProducts.push({ id: realSku, sku: realSku, sku_type: skuType(realSku), title: item.title || "", brand: item.brand || "", image: item.image || "", uae_url: item.url || url, egypt_url: egUrl, uae_price: uaePrice || null, noon_eg_price: null, prev_noon_eg_price: null, is_available: null, shipping: 0, cost, selling_price: cost ? calcSelling(cost) : null, sellers: null, rating: null, review_count: null, buy_box_seller: null, i_have_buy_box: false, i_am_seller: false, my_price: null, added_date: today(), added_by: userName, last_updated: today(), price_changed_at: null, last_uae_scrape: new Date().toISOString(), not_found_uae: false, not_found_eg: false });
          log(`  ✅ [${i + 1}/${toScrape.length}] ${realSku} — ${item.title?.slice(0, 30) || ""}`, "success");
        } else {
          allProducts.push({ id: sku, sku, sku_type: skuType(sku), title: `غير موجود: ${sku}`, brand: "", image: "", uae_url: "", egypt_url: buildEgyptUrl(sku), uae_price: null, noon_eg_price: null, prev_noon_eg_price: null, is_available: null, shipping: 0, cost: null, selling_price: null, sellers: null, rating: null, review_count: null, buy_box_seller: null, i_have_buy_box: false, i_am_seller: false, my_price: null, added_date: today(), added_by: userName, last_updated: today(), price_changed_at: null, last_uae_scrape: new Date().toISOString(), not_found_uae: true, not_found_eg: false });
          log(`  ⚠️ [${i + 1}/${toScrape.length}] ${sku} — مش لاقيه على نون UAE`);
        }
      } catch (e) { log(`  ❌ ${sku} — ${e.message}`, "error"); }
    }

    const toAdd = allProducts.filter(p => !existingSkus.has(p.sku?.toUpperCase()));
    const toUpdate = allProducts.filter(p => existingSkus.has(p.sku?.toUpperCase()));
    // Save in batches of 100
    const saveBatch = 100;
    for (let b = 0; b < toAdd.length; b += saveBatch) {
      await db.upsertProducts(toAdd.slice(b, b + saveBatch));
      log(`  💾 حفظ ${Math.min(b + saveBatch, toAdd.length)}/${toAdd.length}...`);
    }
    for (const p of toUpdate) await db.updateProduct(p.id, { uae_price: p.uae_price, cost: p.cost, selling_price: p.selling_price, last_uae_scrape: p.last_uae_scrape, not_found_uae: p.not_found_uae });
    setProgress(100);
    log(`🎉 أضاف ${toAdd.length} جديد — حدّث ${toUpdate.length} موجود — تخطى ${skipped}`, "success");
    setDone(true); setRunning(false); onDone();
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 560 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>📋 استيراد SKUs من Excel</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>
        {!running && !done && (
          <div style={S.card}>
            <label style={S.label}>📁 ارفع ملف Excel أو CSV أو TXT</label>
            <input type="file" accept=".xlsx,.xls,.csv,.txt" onChange={handleFile} style={{ marginBottom: 8 }} />
            {fileName && <p style={{ fontSize: 12, color: "#059669" }}>✅ {fileName}</p>}
            {skus.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: 12, color: "#6366f1", fontWeight: 600 }}>📦 لقى {skus.length} SKU</p>
                <div style={{ background: "#0f172a", borderRadius: 6, padding: 8, maxHeight: 80, overflowY: "auto", fontFamily: "monospace", fontSize: 11, color: "#94a3b8", marginTop: 6 }}>
                  {skus.slice(0, 15).join(" | ")}{skus.length > 15 ? ` ... +${skus.length - 15}` : ""}
                </div>
              </div>
            )}
            <p style={{ ...S.hint, marginTop: 8, background: "#fffbeb", padding: 8, borderRadius: 6, color: "#92400e" }}>
              ⚠️ المنتجات اللي اتسكربت آخر {UAE_COOLDOWN_HOURS} ساعة هتتخطى تلقائي
            </p>
          </div>
        )}
        {(running || done) && (
          <>
            <div style={S.progWrap}><div style={{ ...S.progBar, width: `${progress}%` }} /></div>
            <div style={{ textAlign: "center", color: "#6366f1", fontWeight: 700, marginBottom: 8 }}>{progress}%</div>
            <div style={S.logBox}>{logs.map((l, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}><span style={{ color: "#475569", fontSize: 10, minWidth: 55 }}>{l.time}</span><span style={{ fontSize: 12, color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8" }}>{l.msg}</span></div>)}</div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          {!running && <button onClick={onClose} style={S.btnGhost}>{done ? "إغلاق" : "إلغاء"}</button>}
          {!running && !done && skus.length > 0 && <button onClick={run} style={{ ...S.btnPrimary, background: "#0891b2" }}>🚀 ابدأ ({skus.length} SKU)</button>}
        </div>
      </div>
    </div>
  );
};

// ===================== SCRAPE UAE CATEGORY MODAL =====================
const ScrapeUrlModal = ({ onClose, onDone, userName, products }) => {
  const [url, setUrl] = useState("");
  const [maxProducts, setMaxProducts] = useState(50);
  const [maxPages, setMaxPages] = useState(3);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const log = (msg, type = "info") => setLogs(l => [...l, { msg, type, time: new Date().toLocaleTimeString("ar-EG") }]);

  const run = async () => {
    if (!url.trim()) { alert("حط لينك الكاتيجوري أولاً"); return; }
    const token = localStorage.getItem(`apify_token_${userName}`);
    if (!token) { alert("سجل الـ Apify API Token في الإعدادات أولاً"); return; }
    setRunning(true);
    setProgress(10);
    log(`🚀 بدأ السكراب: ${url}`);

    try {
      setProgress(20);
      log("⏳ بيشغّل الـ Actor...");
      const items = await apifyRun(APIFY_UAE, { startUrl: url.trim(), maxProducts: parseInt(maxProducts), maxPages: parseInt(maxPages) }, token);
      log(`✅ جاب ${items.length} منتج`);
      setProgress(80);

      const aedSetting = await db.getSetting("aed_rate");
      const aedRate = aedSetting?.rate || 13.6;
      const productMap = {};
      products.forEach(p => { if (p.sku) productMap[p.sku.toUpperCase()] = p; });

      const newProducts = items
        .filter(item => item.url)
        .map(item => {
          const sku = extractSKU(item.url) || "";
          const egUrl = buildEgyptUrl(sku, item.url);
          const uaePrice = parseFloat(item.currentPrice || 0);
          const cost = uaePrice > 0 ? calcCost(uaePrice, aedRate, 0) : null;
          return {
            id: sku, sku, sku_type: skuType(sku), title: item.title || "", brand: item.brand || "", image: item.image || "",
            uae_url: item.url || "", egypt_url: egUrl, uae_price: uaePrice || null,
            noon_eg_price: null, prev_noon_eg_price: null, is_available: null, shipping: 0, cost,
            selling_price: cost ? calcSelling(cost) : null,
            sellers: null, rating: null, review_count: null, buy_box_seller: null,
            i_have_buy_box: false, i_am_seller: false, my_price: null,
            added_date: today(), added_by: userName, last_updated: today(), price_changed_at: null,
            last_uae_scrape: new Date().toISOString(), not_found_uae: false, not_found_eg: false,
          };
        })
        .filter(p => p.sku && p.sku.length >= 5);

      const toAdd = newProducts.filter(p => !productMap[p.sku?.toUpperCase()]);
      const toUpdateAll = newProducts.filter(p => productMap[p.sku?.toUpperCase()]);
      const toUpdate = toUpdateAll.filter(p => {
        const existing = productMap[p.sku.toUpperCase()];
        if (existing?.sku_type === "Z" && existing?.i_am_seller) return false; // Skip Z products we sell
        return hoursAgo(existing?.last_uae_scrape) >= UAE_COOLDOWN_HOURS;
      });
      const skipped = toUpdateAll.length - toUpdate.length;

      if (toAdd.length > 0) await db.upsertProducts(toAdd);
      for (const p of toUpdate) {
        await db.updateProduct(p.id, { uae_price: p.uae_price, cost: p.cost, selling_price: p.selling_price, last_uae_scrape: p.last_uae_scrape });
      }

      setProgress(100);
      log(`🎉 أضاف ${toAdd.length} جديد — حدّث ${toUpdate.length} — تخطى ${skipped} (cooldown)`, "success");
      setDone(true);
      onDone();
    } catch (e) {
      log(`❌ خطأ: ${e.message}`, "error");
    }
    setRunning(false);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 580 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>🔍 سكراب كاتيجوري نون UAE</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>
        {!running && !done && (
          <>
            <div style={S.card}>
              <label style={S.label}>🔗 لينك الكاتيجوري</label>
              <input value={url} onChange={e => setUrl(e.target.value)} style={{ ...S.input, direction: "ltr" }}
                placeholder="https://www.noon.com/uae-en/..." />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div style={S.card}>
                <label style={S.label}>📦 عدد المنتجات</label>
                <input type="number" value={maxProducts} onChange={e => setMaxProducts(e.target.value)} style={S.input} min={1} max={500} />
              </div>
              <div style={S.card}>
                <label style={S.label}>📄 عدد الصفحات</label>
                <input type="number" value={maxPages} onChange={e => setMaxPages(e.target.value)} style={S.input} min={1} max={20} />
              </div>
            </div>
          </>
        )}
        {(running || done) && (
          <>
            <div style={S.progWrap}><div style={{ ...S.progBar, width: `${progress}%` }} /></div>
            <div style={{ textAlign: "center", color: "#6366f1", fontWeight: 700, marginBottom: 10 }}>{progress}%</div>
            <div style={S.logBox}>
              {logs.map((l, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <span style={{ color: "#475569", fontSize: 10, minWidth: 55 }}>{l.time}</span>
                <span style={{ fontSize: 12, color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8" }}>{l.msg}</span>
              </div>)}
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          {!running && <button onClick={onClose} style={S.btnGhost}>{done ? "إغلاق" : "إلغاء"}</button>}
          {!running && !done && <button onClick={run} style={{ ...S.btnPrimary, background: "#7c3aed" }}>🚀 ابدأ السكراب</button>}
        </div>
      </div>
    </div>
  );
};

// ===================== SCRAPE EGYPT MODAL =====================
const ScrapeEgyptModal = ({ onClose, products, onDone, userName, forceUpdate = false }) => {
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const log = (msg, type = "info") => setLogs(l => [...l, { msg, type, time: new Date().toLocaleTimeString("ar-EG") }]);

  const run = async () => {
    const token = localStorage.getItem(`apify_token_${userName}`);
    if (!token) { alert("سجل الـ Apify API Token في الإعدادات أولاً"); return; }
    setRunning(true);
    const toScrape = products.filter(p => {
      if (!p.egypt_url) return false;
      if (forceUpdate) return true;
      return hoursAgo(p.last_eg_scrape) >= EG_COOLDOWN_HOURS;
    });
    const skippedEg = products.filter(p => p.egypt_url && hoursAgo(p.last_eg_scrape) < EG_COOLDOWN_HOURS).length;
    if (skippedEg > 0) log(`⏭️ متخطي (اتسكرب آخر ${EG_COOLDOWN_HOURS} ساعة): ${skippedEg} منتج`);
    log(`🚀 بدأ السكراب — ${toScrape.length} منتج`);
    const aedSetting = await db.getSetting("aed_rate");
    const aedRate = aedSetting?.rate || 13.6;
    const batchSize = 10;
    const alerts = [];

    for (let i = 0; i < toScrape.length; i += batchSize) {
      const batch = toScrape.slice(i, i + batchSize);
      setProgress(Math.round(((i + batch.length) / toScrape.length) * 100));
      log(`📦 batch [${i + 1}–${i + batch.length}] من ${toScrape.length}`);
      try {
        const items = await apifyRun(APIFY_EG, {
          asins: batch.map(p => p.sku).filter(Boolean),
          noon_domain: "www.noon.com/egypt-en",
          use_apify_dataset: true
        }, token);
        log(`  ✅ جاب ${items.length} نتيجة`);

        const processedSkus = new Set();
        for (const item of items) {
          const itemSku = (item.sku_config || item.sku)?.toUpperCase();
          const p = batch.find(x => x.sku?.toUpperCase() === itemSku);
          if (!p) continue;
          // Skip duplicate SKUs already processed
          if (processedSkus.has(itemSku)) continue;
          processedSkus.add(itemSku);

          // saswave actor: each item is one seller offer
          // Group all items by SKU to get all sellers
          const skuItems = items.filter(x => x.sku_config?.toUpperCase() === itemSku);
          const sortedOffers = [...skuItems].sort((a, b) => (a.position || 99) - (b.position || 99));
          const offers = sortedOffers.map(o => ({
            seller: o.store_name || "",
            price: String(o.sale_price || o.price || ""),
            availability: o.is_buyable ? "https://schema.org/InStock" : "",
            rating: o.partner_ratings_sellerlab?.partner_rating || null,
            num_ratings: o.partner_ratings_sellerlab?.num_of_rating || null,
            position: o.position || 99,
          }));
          const lowestPrice = offers.length > 0 ? Math.min(...offers.map(o => parseFloat(o.price || 999999))) : null;
          const buyBoxOffer = offers[0];
          const buyBoxSeller = buyBoxOffer?.seller || null;
          const iHaveBuyBox = normalizeSellerName(buyBoxSeller) === normalizeSellerName(MY_ACCOUNT);
          const myOffer = offers.find(o => normalizeSellerName(o.seller) === normalizeSellerName(MY_ACCOUNT));
          const iAmSeller = !!myOffer;
          const myPrice = myOffer ? parseFloat(myOffer.price) : null;

          // Telegram alerts
          if (p.i_have_buy_box && !iHaveBuyBox && iAmSeller) {
            alerts.push(`😱 <b>خسرت الـ Buy Box!</b>\n${p.title?.slice(0, 50)}\nSKU: ${p.sku}\nالواخدها: ${buyBoxSeller} بسعر ${buyBoxOffer?.price} ج.م`);
          }
          if (iAmSeller && lowestPrice && myPrice && lowestPrice < myPrice) {
            alerts.push(`⚠️ <b>في أرخص منك!</b>\n${p.title?.slice(0, 50)}\nSKU: ${p.sku}\nسعرك: ${myPrice} | الأرخص: ${lowestPrice}`);
          }

          const newPrice = lowestPrice;
          const prevPrice = p.noon_eg_price;
          const priceChanged = prevPrice !== null && prevPrice !== newPrice;
          if (priceChanged) {
            alerts.push(`📊 <b>تغير سعر</b>\n${p.title?.slice(0, 50)}\nSKU: ${p.sku}\nمن ${prevPrice} → ${newPrice} ج.م`);
          }
          const cost = calcCostWithShop(p, aedRate) || p.cost;
          const selling_price = cost ? calcSelling(cost) : p.selling_price;

          // price history
          const history = Array.isArray(p.price_history) ? [...p.price_history] : [];
          if (newPrice != null && (history.length === 0 || history[history.length - 1].p !== newPrice)) {
            history.push({ d: today(), p: newPrice });
            if (history.length > 30) history.shift();
          }

          // Update buybox history
          const buyboxHistory = Array.isArray(p.buybox_history) ? [...p.buybox_history] : [];
          const lastBBEntry = buyboxHistory[buyboxHistory.length - 1];
          if (!lastBBEntry || lastBBEntry.seller !== buyBoxSeller) {
            buyboxHistory.push({ d: today(), seller: buyBoxSeller, price: offers[0]?.price || null });
            if (buyboxHistory.length > 30) buyboxHistory.shift();
          }

          await db.updateProduct(p.id, {
            noon_eg_price: newPrice,
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
            buybox_history: buyboxHistory,
            cost, selling_price, last_updated: today(), last_eg_scrape: new Date().toISOString(),
          });
          log(`  ✅ ${p.sku} — ${newPrice} ج.م ${iHaveBuyBox ? "🏆" : ""}`, "success");
        }

        const foundSkus = new Set(items.map(x => (x.sku_config || x.sku)?.toUpperCase()));
        for (const p of batch) {
          if (!foundSkus.has(p.sku?.toUpperCase())) {
            await db.updateProduct(p.id, { is_available: false, not_found_eg: true, last_updated: today(), last_eg_scrape: new Date().toISOString() });
            log(`  ⚠️ ${p.sku} — مش موجود على نون مصر`);
          }
        }
      } catch (e) {
        log(`  ❌ ${e.message}`, "error");
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    // Send Telegram summary
    if (alerts.length > 0) {
      log(`📨 بيبعت ${alerts.length} تنبيه على Telegram...`);
      const chunks = [];
      let current = "";
      for (const a of alerts) {
        if ((current + "\n\n" + a).length > 3800) { chunks.push(current); current = a; }
        else current = current ? current + "\n\n" + a : a;
      }
      if (current) chunks.push(current);
      for (const chunk of chunks) {
        const sent = await sendTelegram(chunk);
        if (!sent) { log("  ⚠️ Telegram مش متظبط — راجع الإعدادات"); break; }
      }
    }

    setDone(true);
    setRunning(false);
    log("🏁 انتهى!", "success");
    onDone();
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 540 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>🇪🇬 تحديث أسعار نون مصر</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>
        <p style={S.hint}>سيشتغل على <strong>{products.filter(p => p.egypt_url).length}</strong> منتج</p>
        {!running && !done && <button onClick={run} style={{ ...S.btnPrimary, width: "100%", background: "#059669" }}>🚀 ابدأ</button>}
        {(running || done) && (
          <>
            <div style={S.progWrap}><div style={{ ...S.progBar, width: `${progress}%` }} /></div>
            <div style={{ textAlign: "center", color: "#6366f1", fontWeight: 700, marginBottom: 8 }}>{progress}%</div>
            <div style={S.logBox}>
              {logs.map((l, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                <span style={{ color: "#475569", fontSize: 10, minWidth: 55 }}>{l.time}</span>
                <span style={{ fontSize: 12, color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8" }}>{l.msg}</span>
              </div>)}
            </div>
          </>
        )}
        {done && <button onClick={onClose} style={{ ...S.btnPrimary, marginTop: 12, width: "100%" }}>✅ إغلاق</button>}
      </div>
    </div>
  );
};

// ===================== SELLERS POPUP =====================
const SellersPopup = ({ sellers, onClose }) => {
  if (!sellers?.length) return null;
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>🏪 البائعين ({sellers.length})</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>
        {sellers.map((s, i) => {
          const isMe = normalizeSellerName(s.seller) === normalizeSellerName(MY_ACCOUNT);
          const isBuyBox = i === 0;
          return (
            <div key={i} style={{ ...S.sellerRow, background: isMe ? "#f0fdf4" : isBuyBox ? "#eff6ff" : "#f8fafc", border: isMe ? "1px solid #86efac" : isBuyBox ? "1px solid #93c5fd" : "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {isBuyBox && <span style={S.buyBoxBadge}>Buy Box</span>}
                {isMe && <span style={S.meBadge}>أنت</span>}
                <span style={{ fontWeight: isMe ? 700 : 400, fontSize: 13 }}>{s.seller}</span>
              </div>
              <span style={{ fontWeight: 700, color: isMe ? "#059669" : "#374151" }}>{parseFloat(s.price).toLocaleString("ar-EG")} ج.م</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ===================== PRICE HISTORY POPUP =====================
const HistoryPopup = ({ history, title, onClose }) => {
  if (!history?.length) return null;
  const max = Math.max(...history.map(h => h.p));
  const min = Math.min(...history.map(h => h.p));
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>📊 تاريخ السعر</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>
        <p style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>{title?.slice(0, 60)}</p>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120, marginBottom: 12, padding: "0 4px" }}>
          {history.map((h, i) => {
            const pct = max === min ? 50 : ((h.p - min) / (max - min)) * 80 + 20;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                <div style={{ width: "100%", height: `${pct}%`, background: i === history.length - 1 ? "#6366f1" : "#c7d2fe", borderRadius: "3px 3px 0 0", minHeight: 4 }} title={`${h.d}: ${h.p} ج.م`} />
              </div>
            );
          })}
        </div>
        {history.slice().reverse().map((h, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: "1px solid #f1f5f9" }}>
            <span style={{ color: "#94a3b8" }}>{h.d}</span>
            <strong>{h.p.toLocaleString("ar-EG")} ج.م</strong>
          </div>
        ))}
      </div>
    </div>
  );
};

// ===================== SETTINGS =====================
const SettingsPanel = ({ onClose, userName, setUserName, aedRate, setAedRate, commission, setCommission }) => {
  const [rate, setRate] = useState(aedRate);
  const [comm, setComm] = useState(commission);
  const [token, setToken] = useState(localStorage.getItem(`apify_token_${userName}`) || "");
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [serverToken, setServerToken] = useState("");
  const [history, setHistory] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    db.getSetting("aed_rate").then(v => { if (v?.history) setHistory(v.history); });
    db.getSetting("telegram").then(v => { if (v) { setTgToken(v.botToken || ""); setTgChat(v.chatId || ""); } });
    db.getSetting("server").then(v => { if (v?.apifyToken) setServerToken(v.apifyToken); });
  }, []);

  const saveRate = async () => {
    setSaving(true);
    const newHistory = [{ rate: parseFloat(rate), date: new Date().toLocaleString("ar-EG"), user: userName }, ...history.slice(0, 9)];
    await db.setSetting("aed_rate", { rate: parseFloat(rate), history: newHistory });
    setAedRate(parseFloat(rate));
    setHistory(newHistory);
    setSaving(false);
    alert("✅ تم حفظ سعر الدرهم");
  };

  const saveCommission = async () => {
    await db.setSetting("commission", { percent: parseFloat(comm) });
    setCommission(parseFloat(comm));
    alert("✅ تم حفظ العمولة");
  };

  const saveTelegram = async () => {
    await db.setSetting("telegram", { botToken: tgToken.trim(), chatId: tgChat.trim() });
    alert("✅ تم حفظ إعدادات Telegram");
  };

  const testTelegram = async () => {
    await db.setSetting("telegram", { botToken: tgToken.trim(), chatId: tgChat.trim() });
    const ok = await sendTelegram("✅ <b>Noon Pricing Tool</b>\nالبوت شغال تمام! 🎉");
    alert(ok ? "✅ اتبعتت رسالة تجريبية — شوف Telegram" : "❌ فشل — راجع الـ Token والـ Chat ID");
  };

  const saveServer = async () => {
    await db.setSetting("server", { apifyToken: serverToken.trim() });
    alert("✅ تم حفظ توكن السيرفر — التحديث التلقائي اليومي هيشتغل");
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 500 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>⚙️ الإعدادات</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>
        <div style={S.card}>
          <label style={S.label}>👤 اسم المستخدم</label>
          <div style={S.row}>
            <input value={userName} onChange={e => setUserName(e.target.value)} style={S.input} />
            <button onClick={() => { localStorage.setItem("noon_username", userName); alert("✅ تم"); }} style={S.btnSm}>حفظ</button>
          </div>
        </div>
        <div style={S.card}>
          <label style={S.label}>🔑 Apify API Token (للجهاز ده)</label>
          <div style={S.row}>
            <input value={token} onChange={e => setToken(e.target.value)} style={S.input} type="password" placeholder="apify_api_..." />
            <button onClick={() => { localStorage.setItem(`apify_token_${userName}`, token); alert("✅ تم"); }} style={S.btnSm}>حفظ</button>
          </div>
        </div>
        <div style={S.card}>
          <label style={S.label}>🇦🇪 سعر الدرهم</label>
          <div style={S.row}>
            <input value={rate} onChange={e => setRate(e.target.value)} style={{ ...S.input, maxWidth: 100 }} type="number" step="0.01" />
            <span style={{ color: "#64748b", fontSize: 13 }}>ج.م</span>
            <button onClick={saveRate} disabled={saving} style={S.btnSm}>💾 حفظ</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: "#059669", fontWeight: 600 }}>الحالي: {aedRate} ج.م</div>
          {history.length > 0 && <div style={{ marginTop: 8 }}>
            {history.slice(0, 5).map((h, i) => <div key={i} style={S.histRow}><strong>{h.rate}</strong><span style={{ color: "#94a3b8" }}>{h.date}</span><span style={{ color: "#94a3b8" }}>{h.user}</span></div>)}
          </div>}
        </div>
        <div style={S.card}>
          <label style={S.label}>💰 عمولة نون مصر %</label>
          <div style={S.row}>
            <input value={comm} onChange={e => setComm(e.target.value)} style={{ ...S.input, maxWidth: 100 }} type="number" step="0.5" />
            <span style={{ color: "#64748b", fontSize: 13 }}>%</span>
            <button onClick={saveCommission} style={S.btnSm}>💾 حفظ</button>
          </div>
          <p style={S.hint}>بتُخصم من سعر البيع لحساب صافي الربح</p>
        </div>
        <div style={{ ...S.card, border: "1px solid #93c5fd", background: "#eff6ff" }}>
          <label style={S.label}>🤖 Telegram تنبيهات</label>
          <input value={tgToken} onChange={e => setTgToken(e.target.value)} style={{ ...S.input, marginBottom: 8 }} type="password" placeholder="Bot Token من @BotFather" />
          <input value={tgChat} onChange={e => setTgChat(e.target.value)} style={{ ...S.input, marginBottom: 8 }} placeholder="Chat ID" />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveTelegram} style={S.btnSm}>💾 حفظ</button>
            <button onClick={testTelegram} style={{ ...S.btnSm, background: "#059669" }}>📨 اختبار</button>
          </div>
          <p style={S.hint}>هيبعتلك تنبيه لما تخسر Buy Box أو حد ينزل سعره عنك</p>
        </div>
        <div style={{ ...S.card, border: "1px solid #c4b5fd", background: "#f5f3ff" }}>
          <label style={S.label}>🔄 التحديث التلقائي اليومي (سيرفر)</label>
          <div style={S.row}>
            <input value={serverToken} onChange={e => setServerToken(e.target.value)} style={S.input} type="password" placeholder="Apify Token للسيرفر" />
            <button onClick={saveServer} style={S.btnSm}>💾 حفظ</button>
          </div>
          <p style={S.hint}>هيحدّث أسعار نون مصر تلقائي كل يوم الساعة 8 صباحاً ويبعت تنبيهات Telegram</p>
        </div>
        <button onClick={onClose} style={{ ...S.btnPrimary, width: "100%", marginTop: 4 }}>إغلاق</button>
      </div>
    </div>
  );
};

// ===================== DASHBOARD =====================
const Dashboard = ({ products, commission }) => {
  const total = products.length;
  const losers = products.filter(p => { if (!p.noon_eg_price || !p.cost) return false; return parseFloat(p.noon_eg_price) < p.cost * 1.35; }).length;
  const margins = products.filter(p => p.selling_price && p.cost).map(p => parseFloat(calcMargin(p.selling_price, p.cost)));
  const avgMargin = margins.length ? (margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(1) : 0;
  const sellingProducts = products.filter(p => p.i_am_seller).length;
  const iHaveBuyBox = products.filter(p => p.i_have_buy_box).length;
  const notSelling = products.filter(p => p.noon_eg_price != null && !p.i_am_seller).length;
  const cheaperExists = products.filter(p => p.i_am_seller && !p.i_have_buy_box).length;
  const notFound = products.filter(p => p.not_found_uae || p.not_found_eg).length;

  const cards = [
    { v: total, lbl: "إجمالي المنتجات", icon: "📦", c: "#6366f1" },
    { v: iHaveBuyBox, lbl: "Buy Box عندك", icon: "🏆", c: "#f59e0b" },
    { v: `${sellingProducts > 0 ? ((iHaveBuyBox / sellingProducts) * 100).toFixed(0) : 0}%`, lbl: "نسبة Buy Box", icon: "📊", c: "#6366f1" },
    { v: cheaperExists, lbl: "في أرخص منك", icon: "⚠️", c: "#ef4444" },
    { v: notSelling, lbl: "مش عارضها", icon: "🚫", c: "#8b5cf6" },
    { v: losers, lbl: "خاسرة", icon: "🔴", c: "#dc2626" },
    { v: `${avgMargin}%`, lbl: "متوسط الهامش", icon: "📈", c: "#059669" },
    { v: notFound, lbl: "مش موجودة", icon: "❓", c: "#a855f7" },
    { v: `${commission}%`, lbl: "عمولة نون", icon: "💰", c: "#0891b2" },
  ];

  return (
    <div style={S.dashGrid}>
      {cards.map((c, i) => (
        <div key={i} style={{ ...S.dashCard, borderTop: `3px solid ${c.c}` }}>
          <div style={{ fontSize: 22 }}>{c.icon}</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: c.c, margin: "6px 0 2px" }}>{c.v}</div>
          <div style={{ fontSize: 11, color: "#64748b" }}>{c.lbl}</div>
        </div>
      ))}
    </div>
  );
};

// ===================== PRODUCT ROW =====================
const ProductRow = ({ p, aedRate, commission, onShipChange, onDelete }) => {
  const [exp, setExp] = useState(false);
  const [showSellers, setShowSellers] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const cost = calcCostWithShop(p, aedRate);
  const sell = cost ? calcSelling(cost) : null;
  const netProfit = sell && cost ? calcNetProfit(sell, cost, commission) : null;
  const minPrice = cost ? calcMinPrice(cost) : null;
  const maxPrice = cost ? calcMaxPrice(cost) : null;
  const netProfitPct = sell && cost ? ((sell * (1 - commission/100) - cost) / sell) * 100 : null;
  const isLoser = p.noon_eg_price != null && minPrice && parseFloat(p.noon_eg_price) < minPrice;
  const isLowMargin = netProfitPct != null && netProfitPct < 10;
  // Suggested price: based on lowest competitor price
  const lowestCompetitor = Array.isArray(p.sellers) && p.sellers.length > 0
    ? Math.min(...p.sellers.filter(s => normalizeSellerName(s.seller) !== normalizeSellerName(MY_ACCOUNT)).map(s => parseFloat(s.price || 999999)))
    : null;
  const suggestedPrice = cost ? calcSuggestedPrice(cost, lowestCompetitor === 999999 ? null : lowestCompetitor) : null;
  const priceChanged = p.prev_noon_eg_price != null && p.prev_noon_eg_price !== p.noon_eg_price;
  const cheaperExists = p.i_am_seller && !p.i_have_buy_box;
  const hasHistory = Array.isArray(p.price_history) && p.price_history.length > 1;

  return (
    <>
      <tr style={{ ...S.tr, background: isLoser ? "#fff5f5" : isLowMargin ? "#fff8f0" : cheaperExists ? "#fffbeb" : (p.not_found_uae || p.not_found_eg) ? "#f5f3ff" : "white" }}>
        <td style={S.td}>
          {p.image ? <img src={p.image} alt="" style={S.thumb} onError={e => e.target.style.display = "none"} />
            : <div style={S.noThumb}>📦</div>}
        </td>
        <td style={{ ...S.td, maxWidth: 240 }}>
          <div style={S.prodTitle}>{p.title || "—"}</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
            <span style={{ ...S.badge, background: p.sku_type === "N" ? "#d1fae5" : "#dbeafe", color: p.sku_type === "N" ? "#065f46" : "#1e40af" }}>{p.sku_type}</span>
            <span style={{ ...S.badge, background: "#f1f5f9", color: "#475569" }}>{p.sku}</span>
            {p.brand && <span style={{ ...S.badge, background: "#fef3c7", color: "#92400e" }}>{p.brand}</span>}
            {p.rating && <span style={{ ...S.badge, background: "#fef9c3", color: "#713f12" }}>⭐ {p.rating}</span>}
            {p.shop_price && <span style={{ ...S.badge, background: "#dcfce7", color: "#15803d" }}>🏪 {p.shop_price} د.إ</span>}
            {p.not_found_uae && <span style={{ ...S.badge, background: "#ede9fe", color: "#7c3aed" }}>❓ UAE</span>}
            {p.not_found_eg && <span style={{ ...S.badge, background: "#ede9fe", color: "#7c3aed" }}>❓ مصر</span>}
          </div>
        </td>
        <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>{fmtAED(p.uae_price)}</td>
        <td style={{ ...S.td, textAlign: "center" }}>
          <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "center" }}>
            <input type="number" value={p.shipping || ""} onChange={e => onShipChange(p.id, e.target.value)} style={S.shipInput} placeholder="0" />
          </div>
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>{fmtEGP(cost)}</td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {sell ? (
            <div>
              <strong style={{ color: "#059669" }}>{fmtEGP(sell)}</strong>
              {minPrice && <div style={{ fontSize: 10, color: "#94a3b8" }}>أدنى: {fmtEGP(minPrice)} | أقصى: {fmtEGP(maxPrice)}</div>}
            </div>
          ) : "—"}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {netProfit != null
            ? <span style={{ color: netProfit > 0 ? "#059669" : "#ef4444", fontWeight: 600 }}>{fmtEGP(netProfit)}</span>
            : "—"}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {p.noon_eg_price != null ? (
            <div>
              <div style={{ color: isLoser ? "#ef4444" : "#059669", fontWeight: 600, display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                {fmtEGP(p.noon_eg_price)}{isLoser && " 🔴"}
                {hasHistory && <button onClick={() => setShowHistory(true)} style={{ ...S.iconBtn, padding: "1px 4px", fontSize: 11 }}>📊</button>}
              </div>
              {priceChanged && <div style={{ fontSize: 10, color: "#94a3b8" }}>كان: {fmtEGP(p.prev_noon_eg_price)}{parseFloat(p.noon_eg_price) > parseFloat(p.prev_noon_eg_price) ? " 📈" : " 📉"}</div>}
              {suggestedPrice && (
                <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 600, marginTop: 2 }}>
                  💡 {fmtEGP(suggestedPrice)}
                </div>
              )}
            </div>
          ) : <span style={{ color: "#d1d5db", fontSize: 11 }}>لم يُسكرب</span>}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {p.sellers ? (
            <button onClick={() => setShowSellers(true)} style={{ ...S.iconBtn, position: "relative" }}>
              🏪 {p.sellers.length}
              {p.i_have_buy_box && <span style={S.greenDot} />}
              {cheaperExists && <span style={S.redDot} />}
            </button>
          ) : <span style={{ color: "#d1d5db", fontSize: 11 }}>—</span>}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {p.i_am_seller ? (
            <div>
              {p.i_have_buy_box ? <span style={{ color: "#059669", fontWeight: 700 }}>🏆 Buy Box</span>
                : <span style={{ color: "#f59e0b", fontWeight: 700 }}>⚠️ مش أنت</span>}
              <div style={{ fontSize: 11, color: "#6b7280" }}>{fmtEGP(p.my_price)}</div>
            </div>
          ) : p.noon_eg_price != null ? (
            <span style={{ color: "#8b5cf6", fontSize: 12 }}>🚫 مش عارض</span>
          ) : <span style={{ color: "#d1d5db" }}>—</span>}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>
            <button onClick={() => setExp(!exp)} style={S.iconBtn}>👁️</button>
            {p.egypt_url && <a href={p.egypt_url} target="_blank" rel="noreferrer" style={S.iconBtn}>🇪🇬</a>}
            {p.uae_url && <a href={p.uae_url} target="_blank" rel="noreferrer" style={S.iconBtn}>🇦🇪</a>}
            <button onClick={() => onDelete(p.id)} style={{ ...S.iconBtn, color: "#ef4444" }}>🗑️</button>
          </div>
        </td>
      </tr>
      {exp && (
        <tr>
          <td colSpan={11} style={{ background: "#f8fafc", padding: "10px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px,1fr))", gap: 8 }}>
              {p.shop_price && <div><span style={{ color: "#94a3b8" }}>سعر المحل: </span>{p.shop_price} د.إ {p.shop_name ? `(${p.shop_name})` : ""}</div>}
              <div><span style={{ color: "#94a3b8" }}>تاريخ الإضافة: </span>{p.added_date}</div>
              <div><span style={{ color: "#94a3b8" }}>أضافه: </span>{p.added_by}</div>
              <div><span style={{ color: "#94a3b8" }}>آخر تحديث: </span>{p.last_updated}</div>
              <div><span style={{ color: "#94a3b8" }}>آخر سكراب UAE: </span>{p.last_uae_scrape ? new Date(p.last_uae_scrape).toLocaleString("ar-EG") : "—"}</div>
              {p.price_changed_at && <div><span style={{ color: "#94a3b8" }}>تغير السعر: </span>{p.price_changed_at}</div>}
              <div><span style={{ color: "#94a3b8" }}>Buy Box: </span>{p.buy_box_seller || "—"}</div>
              <div><span style={{ color: "#94a3b8" }}>تقييم: </span>{p.rating ? `⭐ ${p.rating} (${p.review_count})` : "—"}</div>
            </div>
          </td>
        </tr>
      )}
      {showSellers && <SellersPopup sellers={p.sellers} onClose={() => setShowSellers(false)} />}
      {showHistory && <HistoryPopup history={p.price_history} title={p.title} onClose={() => setShowHistory(false)} />}
    </>
  );
};



// ===================== BUYBOX REVIEW MODAL =====================
const BuyBoxReviewModal = ({ onClose, products, onDone, userName }) => {
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState(null);

  const log = (msg, type = "info") => setLogs(l => [...l, { msg, type, time: new Date().toLocaleTimeString("ar-EG") }]);

  // Only products where i_am_seller=true and i_have_buy_box=false
  const toReview = products.filter(p => p.i_am_seller && !p.i_have_buy_box && p.egypt_url);
  const sellingProducts = products.filter(p => p.i_am_seller);
  const buyboxCount = products.filter(p => p.i_have_buy_box).length;
  const buyboxPct = sellingProducts.length > 0 ? ((buyboxCount / sellingProducts.length) * 100).toFixed(1) : 0;

  const run = async () => {
    const token = localStorage.getItem(`apify_token_${userName}`);
    if (!token) { alert("سجل الـ Apify API Token في الإعدادات أولاً"); return; }
    setRunning(true);
    log(`🔍 مراجعة ${toReview.length} منتج مش واخد فيها Buy Box`);
    const aedSetting = await db.getSetting("aed_rate");
    const aedRate = aedSetting?.rate || 13.6;
    const batchSize = 10;
    let lostBuyBox = 0;
    let gainedBuyBox = 0;

    for (let i = 0; i < toReview.length; i += batchSize) {
      const batch = toReview.slice(i, i + batchSize);
      setProgress(Math.round(((i + batch.length) / toReview.length) * 100));
      log(`📦 batch [${i + 1}–${i + batch.length}] من ${toReview.length}`);
      try {
        const items = await apifyRun("saswave~noon-seller-monitoring", {
          asins: batch.map(p => p.sku).filter(Boolean),
          noon_domain: "www.noon.com/egypt-en",
          use_apify_dataset: true
        }, token);

        const processedSkus = new Set();
        for (const item of items) {
          const itemSku = (item.sku_config || item.sku)?.toUpperCase();
          const p = batch.find(x => x.sku?.toUpperCase() === itemSku);
          if (!p || processedSkus.has(itemSku)) continue;
          processedSkus.add(itemSku);

          const skuItems = items.filter(x => (x.sku_config || x.sku)?.toUpperCase() === itemSku);
          const sortedOffers = [...skuItems].sort((a, b) => (a.position || 99) - (b.position || 99));
          const offers = sortedOffers.map(o => ({
            seller: o.store_name || "",
            price: String(o.sale_price || o.price || ""),
            availability: o.is_buyable ? "https://schema.org/InStock" : "",
            rating: o.partner_ratings_sellerlab?.partner_rating || null,
            num_ratings: o.partner_ratings_sellerlab?.num_of_rating || null,
            position: o.position || 99,
          }));

          const buyBoxSeller = offers[0]?.seller || null;
          const iHaveBuyBox = normalizeSellerName(buyBoxSeller) === normalizeSellerName(MY_ACCOUNT);
          const myOffer = offers.find(o => normalizeSellerName(o.seller) === normalizeSellerName(MY_ACCOUNT));
          const myPrice = myOffer ? parseFloat(myOffer.price) : null;
          const lowestPrice = offers.length > 0 ? Math.min(...offers.map(o => parseFloat(o.price || 999999))) : null;
          const cost = p.uae_price > 0 ? (p.uae_price * aedRate) + (p.shipping || 0) : p.cost;
          const selling_price = cost ? cost * 1.6 : p.selling_price;

          if (iHaveBuyBox) gainedBuyBox++;

          await db.updateProduct(p.id, {
            noon_eg_price: lowestPrice,
            sellers: offers,
            buy_box_seller: buyBoxSeller,
            i_have_buy_box: iHaveBuyBox,
            my_price: myPrice,
            cost, selling_price,
            last_updated: today(),
            last_eg_scrape: new Date().toISOString(),
          });

          log(`  ${iHaveBuyBox ? "🏆" : "❌"} ${p.sku} — Buy Box: ${buyBoxSeller || "؟"} | سعرك: ${myPrice} ج.م`, iHaveBuyBox ? "success" : "info");
        }

        const foundSkus = new Set(items.map(x => (x.sku_config || x.sku)?.toUpperCase()));
        for (const p of batch) {
          if (!foundSkus.has(p.sku?.toUpperCase())) {
            log(`  ⚠️ ${p.sku} — مش موجود`);
          }
        }
      } catch (e) {
        log(`  ❌ ${e.message}`, "error");
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    setStats({ gained: gainedBuyBox, total: toReview.length });
    setDone(true);
    setRunning(false);
    log(`🏁 انتهى! استردت Buy Box في ${gainedBuyBox} منتج`, "success");
    onDone();
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 560 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>🔍 مراجعة Buy Box</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>

        {!running && !done && (
          <div style={S.card}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div style={{ textAlign: "center", background: "#f0fdf4", borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#059669" }}>{buyboxPct}%</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>نسبة Buy Box</div>
              </div>
              <div style={{ textAlign: "center", background: "#fff5f5", borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#ef4444" }}>{toReview.length}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>محتاج مراجعة</div>
              </div>
            </div>
            <p style={S.hint}>هيسكرب المنتجات اللي أنت عارضها بس مش واخد فيها Buy Box</p>
          </div>
        )}

        {(running || done) && (
          <>
            <div style={S.progWrap}><div style={{ ...S.progBar, width: `${progress}%` }} /></div>
            <div style={{ textAlign: "center", color: "#6366f1", fontWeight: 700, marginBottom: 8 }}>{progress}%</div>
            <div style={S.logBox}>
              {logs.map((l, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                <span style={{ color: "#475569", fontSize: 10, minWidth: 55 }}>{l.time}</span>
                <span style={{ fontSize: 12, color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8" }}>{l.msg}</span>
              </div>)}
            </div>
          </>
        )}

        {done && stats && (
          <div style={{ ...S.card, background: "#f0fdf4", border: "1px solid #86efac", marginTop: 10 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#059669" }}>
                استردت Buy Box في {stats.gained} من {stats.total} منتج
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          {!running && <button onClick={onClose} style={S.btnGhost}>{done ? "إغلاق" : "إلغاء"}</button>}
          {!running && !done && toReview.length > 0 && (
            <button onClick={run} style={{ ...S.btnPrimary, background: "#f59e0b" }}>
              🔍 ابدأ المراجعة ({toReview.length} منتج)
            </button>
          )}
          {!running && !done && toReview.length === 0 && (
            <div style={{ color: "#059669", fontWeight: 600 }}>✅ كل منتجاتك عندها Buy Box!</div>
          )}
          {done && <button onClick={onClose} style={{ ...S.btnPrimary, marginTop: 0 }}>✅ إغلاق</button>}
        </div>
      </div>
    </div>
  );
};


const exportSellersCSV = (sellers) => {
  const headers = ["البائع", "تقييم", "عدد التقييمات", "منتجات مشتركة"];
  const rows = sellers.map(s => [s.name, s.rating || "", s.num_ratings || "", s.products.length]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${c ?? ""}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sellers_${today()}.csv`; a.click();
};

const exportSellerProductsCSV = (sellerName, products) => {
  if (!products) return;
  const headers = ["SKU", "الاسم", "سعر UAE", "سعر مصر", "سعر البائع", "الفرق", "لينك مصر"];
  const rows = products.map(p => {
    const so = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(sellerName));
    const mo = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(MY_ACCOUNT));
    const sp = so ? parseFloat(so.price) : null;
    const mp = mo ? parseFloat(mo.price) : null;
    return [p.sku, p.title, p.uae_price, p.noon_eg_price, sp || "", sp && mp ? mp - sp : "", p.egypt_url || ""];
  });
  const csv = [headers, ...rows].map(r => r.map(c => `"${c ?? ""}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `seller_${sellerName}_${today()}.csv`; a.click();
};




// ===================== SHOP IMPORT MODAL =====================
const ShopImportModal = ({ onClose, onDone, userName, products }) => {
  const [rows, setRows] = useState([{ sku: "", shop_price: "", shop_name: "" }]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const addRow = () => setRows(prev => [...prev, { sku: "", shop_price: "", shop_name: "" }]);
  const removeRow = (i) => setRows(prev => prev.filter((_, idx) => idx !== i));
  const updateRow = (i, field, value) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r));

  const handlePaste = (e) => {
    // Support pasting from Excel: SKU TAB price TAB shop_name
    const text = e.clipboardData.getData("text");
    const lines = text.trim().split(/[\r\n]+/);
]+/);
    if (lines.length > 1) {
      e.preventDefault();
      const parsed = lines.map(line => {
        const parts = line.split(/[	,]/);
        return {
          sku: (parts[0] || "").trim().replace(/-\d+$/, "").toUpperCase(),
          shop_price: (parts[1] || "").trim(),
          shop_name: (parts[2] || "").trim(),
        };
      }).filter(r => r.sku);
      setRows(parsed);
    }
  };

  const save = async () => {
    const valid = rows.filter(r => r.sku && r.shop_price);
    if (valid.length === 0) { alert("مفيش بيانات صح"); return; }
    setSaving(true);
    setMsg(`⏳ جاري حفظ ${valid.length} منتج...`);

    let updated = 0;
    let notFound = 0;
    const productMap = {};
    products.forEach(p => { if (p.sku) productMap[p.sku.toUpperCase()] = p; });

    for (const row of valid) {
      const sku = row.sku.toUpperCase();
      const p = productMap[sku];
      if (p) {
        await db.updateProduct(p.id, {
          shop_price: parseFloat(row.shop_price),
          shop_name: row.shop_name || null,
        });
        updated++;
      } else {
        notFound++;
      }
    }

    setMsg(`✅ تم تحديث ${updated} منتج${notFound > 0 ? ` | مش موجود في الداتابيز: ${notFound}` : ""}`);
    setSaving(false);
    onDone();
  };

  const clearShopPrices = async () => {
    if (!window.confirm("هتمسح سعر المحل من كل المنتجات؟")) return;
    setSaving(true);
    setMsg("⏳ جاري المسح...");
    // Get all products with shop_price
    const withShop = products.filter(p => p.shop_price);
    for (const p of withShop) {
      await db.updateProduct(p.id, { shop_price: null, shop_name: null });
    }
    setMsg(`✅ تم مسح سعر المحل من ${withShop.length} منتج`);
    setSaving(false);
    onDone();
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 640 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>🏪 أسعار المحل (UAE)</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>

        <div style={{ ...S.card, background: "#f0fdf4", border: "1px solid #86efac" }}>
          <p style={{ fontSize: 12, color: "#15803d" }}>
            💡 لو عندك سعر شراء من محل في UAE أرخص من نون — حطه هنا وهيتحسب منه التكلفة وسعر البيع بدل سعر نون UAE
          </p>
        </div>

        <p style={S.hint}>ممكن تلصق من Excel: SKU | سعر بالدرهم | اسم المحل</p>

        <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <th style={S.th}>SKU</th>
                <th style={S.th}>سعر المحل (د.إ)</th>
                <th style={S.th}>اسم المحل</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td style={S.td}>
                    <input value={row.sku} onChange={e => updateRow(i, "sku", e.target.value.toUpperCase())}
                      onPaste={i === 0 ? handlePaste : undefined}
                      style={{ ...S.input, fontSize: 12 }} placeholder="N70xxxxx" dir="ltr" />
                  </td>
                  <td style={S.td}>
                    <input type="number" value={row.shop_price} onChange={e => updateRow(i, "shop_price", e.target.value)}
                      style={{ ...S.input, fontSize: 12 }} placeholder="0.00" step="0.01" />
                  </td>
                  <td style={S.td}>
                    <input value={row.shop_name} onChange={e => updateRow(i, "shop_name", e.target.value)}
                      style={{ ...S.input, fontSize: 12 }} placeholder="اسم المحل" />
                  </td>
                  <td style={S.td}>
                    <button onClick={() => removeRow(i)} style={{ ...S.iconBtn, color: "#ef4444" }}>🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button onClick={addRow} style={{ ...S.btnGhost, width: "100%", marginBottom: 10 }}>➕ إضافة سطر</button>

        {msg && <div style={{ ...S.statusMsg, marginBottom: 10 }}>{msg}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
          <button onClick={clearShopPrices} style={{ ...S.btnGhost, borderColor: "#ef4444", color: "#ef4444", fontSize: 12 }}>
            🗑️ مسح كل أسعار المحل
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={S.btnGhost}>إغلاق</button>
            <button onClick={save} disabled={saving} style={{ ...S.btnPrimary, background: "#059669" }}>
              💾 حفظ ({rows.filter(r => r.sku && r.shop_price).length} منتج)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ===================== FRIENDLY SELLERS PAGE =====================
const FriendlySellersPage = ({ products, onBack }) => {
  const [friendlySellers, setFriendlySellers] = useState([]);
  const [selectedSeller, setSelectedSeller] = useState(null);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    db.getFriendlySellers().then(data => {
      setFriendlySellers(data || []);
      setLoading(false);
    });
  }, []);

  const addSeller = async () => {
    if (!newName.trim()) { alert("اكتب اسم البائع"); return; }
    setAdding(true);
    const data = {
      seller_name: newName.trim(),
      partner_code: newCode.trim() || null,
      notes: newNotes.trim() || null,
    };
    const result = await db.addFriendlySeller(data);
    setFriendlySellers(prev => [...(result || []), ...prev]);
    setNewName(""); setNewCode(""); setNewNotes("");
    setShowAddForm(false);
    setAdding(false);
  };

  const deleteSeller = async (id) => {
    if (!window.confirm("مسح البائع ده من قايمة الأصدقاء؟")) return;
    await db.deleteFriendlySeller(id);
    setFriendlySellers(prev => prev.filter(s => s.id !== id));
    if (selectedSeller?.id === id) setSelectedSeller(null);
  };

  // Get shared products for a friendly seller
  const getSharedProducts = (sellerName) => {
    return products.filter(p =>
      Array.isArray(p.sellers) &&
      p.sellers.some(s => normalizeSellerName(s.seller) === normalizeSellerName(sellerName))
    );
  };

  if (selectedSeller) {
    const shared = getSharedProducts(selectedSeller.seller_name);
    return (
      <div style={S.app} dir="rtl">
        <div style={{ ...S.actions, alignItems: "center", gap: 8 }}>
          <button onClick={() => setSelectedSeller(null)} style={S.btnGhost}>← رجوع</button>
          <strong style={{ fontSize: 15 }}>🤝 {selectedSeller.seller_name}</strong>
          {selectedSeller.partner_code && <span style={{ ...S.badge, background: "#f1f5f9", color: "#475569" }}>p-{selectedSeller.partner_code}</span>}
          <span style={{ color: "#64748b", fontSize: 13 }}>{shared.length} منتج مشترك</span>
          {selectedSeller.notes && <span style={{ fontSize: 12, color: "#94a3b8" }}>📝 {selectedSeller.notes}</span>}
        </div>
        {shared.length === 0 ? (
          <div style={S.empty}>مفيش منتجات مشتركة دلوقتي — اعمل سكراب نون مصر عشان تظهر</div>
        ) : (
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["صورة", "المنتج", "SKU", "سعر مصر", "سعره", "أنت عارضه؟", ""].map(h => <th key={h} style={S.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {shared.map(p => {
                  const friendOffer = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(selectedSeller.seller_name));
                  const friendPrice = friendOffer ? parseFloat(friendOffer.price) : null;
                  return (
                    <tr key={p.id} style={S.tr}>
                      <td style={S.td}>{p.image ? <img src={p.image} alt="" style={S.thumb} onError={e => e.target.style.display="none"} /> : <div style={S.noThumb}>📦</div>}</td>
                      <td style={{ ...S.td, maxWidth: 220 }}>
                        <div style={S.prodTitle}>{p.title || "—"}</div>
                        {p.egypt_url && <a href={p.egypt_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#6366f1" }}>فتح في نون مصر ↗</a>}
                      </td>
                      <td style={S.td}><span style={{ ...S.badge, background: "#f1f5f9", color: "#475569" }}>{p.sku}</span></td>
                      <td style={{ ...S.td, textAlign: "center" }}>{fmtEGP(p.noon_eg_price)}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        {friendPrice ? <strong style={{ color: "#6366f1" }}>{fmtEGP(friendPrice)}</strong> : "—"}
                      </td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        {p.i_am_seller
                          ? <span style={{ color: "#f59e0b", fontWeight: 600 }}>⚠️ نعم</span>
                          : <span style={{ color: "#059669", fontWeight: 600 }}>✅ لأ</span>}
                      </td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        {p.egypt_url && <a href={p.egypt_url} target="_blank" rel="noreferrer" style={S.iconBtn}>🇪🇬</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={S.app} dir="rtl">
      <div style={{ ...S.actions, alignItems: "center", gap: 8 }}>
        <button onClick={onBack} style={S.btnGhost}>← رجوع</button>
        <strong style={{ fontSize: 15 }}>🤝 البائعين الأصدقاء ({friendlySellers.length})</strong>
        <button onClick={() => setShowAddForm(!showAddForm)} style={{ ...S.btnPrimary, background: "#059669" }}>➕ إضافة بائع</button>
      </div>

      {showAddForm && (
        <div style={{ padding: "12px 20px", background: "#f0fdf4", borderBottom: "1px solid #86efac" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 2fr auto", gap: 8, alignItems: "end" }}>
            <div>
              <label style={{ ...S.label, marginBottom: 4 }}>اسم البائع</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} style={S.input} placeholder="اسم البائع على نون" />
            </div>
            <div>
              <label style={{ ...S.label, marginBottom: 4 }}>Partner Code</label>
              <input value={newCode} onChange={e => setNewCode(e.target.value)} style={S.input} placeholder="43181" dir="ltr" />
            </div>
            <div>
              <label style={{ ...S.label, marginBottom: 4 }}>ملاحظات</label>
              <input value={newNotes} onChange={e => setNewNotes(e.target.value)} style={S.input} placeholder="اختياري" />
            </div>
            <button onClick={addSeller} disabled={adding} style={{ ...S.btnPrimary, background: "#059669", height: 38 }}>
              {adding ? "..." : "✅ حفظ"}
            </button>
          </div>
        </div>
      )}

      <div style={S.tableWrap}>
        {loading ? <div style={S.empty}>⏳ جاري التحميل...</div>
          : friendlySellers.length === 0 ? (
            <div style={S.empty}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>🤝</div>
              <div>مفيش بائعين أصدقاء لسه — اضغط «➕ إضافة بائع» للبدء</div>
            </div>
          ) : (
            <table style={S.table}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["البائع", "Partner Code", "منتجات مشتركة", "أنت عارض منها", "ملاحظات", ""].map(h => <th key={h} style={S.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {friendlySellers.map(s => {
                  const shared = getSharedProducts(s.seller_name);
                  const iAmSelling = shared.filter(p => p.i_am_seller).length;
                  return (
                    <tr key={s.id} style={{ ...S.tr, background: iAmSelling > 0 ? "#fffbeb" : "white" }}>
                      <td style={S.td}><strong>{s.seller_name}</strong></td>
                      <td style={S.td}>
                        {s.partner_code
                          ? <span style={{ ...S.badge, background: "#f1f5f9", color: "#475569" }}>p-{s.partner_code}</span>
                          : <span style={{ color: "#d1d5db" }}>—</span>}
                      </td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        <span style={{ ...S.badge, background: "#dbeafe", color: "#1d4ed8" }}>{shared.length}</span>
                      </td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        {iAmSelling > 0
                          ? <span style={{ ...S.badge, background: "#fef3c7", color: "#92400e" }}>⚠️ {iAmSelling} منتج</span>
                          : <span style={{ color: "#059669", fontWeight: 600 }}>✅ لأ</span>}
                      </td>
                      <td style={{ ...S.td, color: "#64748b", fontSize: 12 }}>{s.notes || "—"}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                          {shared.length > 0 && (
                            <button onClick={() => setSelectedSeller(s)} style={S.btnPrimary}>عرض المنتجات</button>
                          )}
                          <button onClick={() => deleteSeller(s.id)} style={{ ...S.iconBtn, color: "#ef4444" }}>🗑️</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
};

// ===================== COMPETITOR SCRAPE MODAL =====================
const CompetitorScrapeModal = ({ onClose, onDone, userName, products }) => {
  const [partnerCode, setPartnerCode] = useState("");
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [results, setResults] = useState(null);

  const log = (msg, type = "info") => setLogs(l => [...l, { msg, type, time: new Date().toLocaleTimeString("ar-EG") }]);

  const run = async () => {
    const code = partnerCode.trim().replace(/^p-/, "");
    if (!code) { alert("حط الـ partner code أولاً"); return; }
    const token = localStorage.getItem(`apify_token_${userName}`);
    if (!token) { alert("سجل الـ Apify API Token في الإعدادات أولاً"); return; }

    setRunning(true);
    log(`🔍 بيجيب منتجات البائع: p-${code}`);

    try {
      // Use noon seller monitoring to get seller products
      const url = `https://www.noon.com/egypt-en/p-${code}/`;
      log(`📦 بيسكرب: ${url}`);

      const items = await apifyRun(APIFY_UAE, {
        startUrl: url,
        maxProducts: 500,
        maxPages: 20,
      }, token);

      log(`✅ جاب ${items.length} منتج من المنافس`);
      setProgress(50);

      const mySkus = new Set(products.map(p => p.sku?.toUpperCase()));
      const inMyStore = items.filter(item => {
        const sku = extractSKU(item.url);
        return sku && mySkus.has(sku.toUpperCase());
      });
      const notInMyStore = items.filter(item => {
        const sku = extractSKU(item.url);
        return sku && !mySkus.has(sku.toUpperCase());
      });

      log(`📊 مشتركة معاك: ${inMyStore.length} | مش في كاتالوجك: ${notInMyStore.length}`, "success");
      setProgress(100);
      setResults({ all: items, shared: inMyStore, missing: notInMyStore, partnerCode: code });
      setDone(true);
    } catch (e) {
      log(`❌ خطأ: ${e.message}`, "error");
    }
    setRunning(false);
  };

  const exportMissing = () => {
    if (!results?.missing) return;
    const headers = ["SKU", "الاسم", "السعر", "لينك UAE"];
    const rows = results.missing.map(item => {
      const sku = extractSKU(item.url) || "";
      return [sku, item.title || "", item.currentPrice || "", item.url || ""];
    });
    const csv = [headers, ...rows].map(r => r.map(c => `"${c ?? ""}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `competitor_p${results.partnerCode}_missing_${today()}.csv`;
    a.click();
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 580 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>🕵️ سكراب منافس</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>

        {!running && !done && (
          <div style={S.card}>
            <label style={S.label}>🏪 Partner Code للمنافس</label>
            <div style={S.row}>
              <span style={{ color: "#64748b", fontSize: 13, whiteSpace: "nowrap" }}>p-</span>
              <input value={partnerCode} onChange={e => setPartnerCode(e.target.value)}
                style={S.input} placeholder="43181" dir="ltr" />
            </div>
            <p style={S.hint}>بتلاقيه في لينك صفحة البائع على نون: noon.com/egypt-en/p-XXXXX/</p>
          </div>
        )}

        {(running || done) && (
          <>
            <div style={S.progWrap}><div style={{ ...S.progBar, width: `${progress}%` }} /></div>
            <div style={{ textAlign: "center", color: "#6366f1", fontWeight: 700, marginBottom: 8 }}>{progress}%</div>
            <div style={S.logBox}>
              {logs.map((l, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                <span style={{ color: "#475569", fontSize: 10, minWidth: 55 }}>{l.time}</span>
                <span style={{ fontSize: 12, color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8" }}>{l.msg}</span>
              </div>)}
            </div>
          </>
        )}

        {done && results && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
              <div style={{ ...S.dashCard, borderTop: "3px solid #6366f1" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#6366f1" }}>{results.all.length}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>إجمالي منتجاته</div>
              </div>
              <div style={{ ...S.dashCard, borderTop: "3px solid #10b981" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#10b981" }}>{results.shared.length}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>مشتركة معاك</div>
              </div>
              <div style={{ ...S.dashCard, borderTop: "3px solid #f59e0b" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#f59e0b" }}>{results.missing.length}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>مش في كاتالوجك</div>
              </div>
            </div>
            {results.missing.length > 0 && (
              <button onClick={exportMissing} style={{ ...S.btnPrimary, width: "100%", background: "#f59e0b" }}>
                💾 Export المنتجات المش عندك ({results.missing.length})
              </button>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          {!running && <button onClick={onClose} style={S.btnGhost}>{done ? "إغلاق" : "إلغاء"}</button>}
          {!running && !done && <button onClick={run} style={{ ...S.btnPrimary, background: "#7c3aed" }}>🚀 ابدأ</button>}
        </div>
      </div>
    </div>
  );
};

// ===================== SELLERS PAGE =====================
const SellersPage = ({ products, onBack }) => {
  const [selectedSeller, setSelectedSeller] = useState(null);

  // Build sellers map with partner_code
  const sellersMap = {};
  for (const p of products) {
    if (!Array.isArray(p.sellers)) continue;
    for (const s of p.sellers) {
      const name = s.seller || "";
      if (!name) continue;
      const isMe = normalizeSellerName(name) === normalizeSellerName(MY_ACCOUNT);
      if (isMe) continue;
      if (!sellersMap[name]) {
        sellersMap[name] = {
          name,
          rating: s.rating || null,
          num_ratings: s.num_ratings || null,
          partner_code: s.partner_code || null,
          products: [],
        };
      }
      // Update partner_code if found
      if (s.partner_code && !sellersMap[name].partner_code) {
        sellersMap[name].partner_code = s.partner_code;
      }
      sellersMap[name].products.push(p);
    }
  }

  const sellers = Object.values(sellersMap).sort((a, b) => b.products.length - a.products.length);

  const [sellerSearch, setSellerSearch] = useState("");
  const [sellerPriceFilter, setSellerPriceFilter] = useState("");
  const filteredSellers = sellers.filter(s => s.name.toLowerCase().includes(sellerSearch.toLowerCase()));

  if (selectedSeller) {
    const sel = sellersMap[selectedSeller];
    return (
      <div style={S.app} dir="rtl">
        <div style={{ ...S.actions, alignItems: "center" }}>
          <button onClick={() => setSelectedSeller(null)} style={S.btnGhost}>← رجوع للبائعين</button>
          <button onClick={() => exportSellerProductsCSV(selectedSeller, sel?.products)} style={S.btnGhost}>💾 Export</button>
          <strong style={{ fontSize: 15 }}>🏪 {selectedSeller}</strong>
          {sel?.rating && <span style={{ ...S.badge, background: "#fef9c3", color: "#713f12", fontSize: 13 }}>⭐ {sel.rating} ({sel.num_ratings})</span>}
          <span style={{ color: "#64748b", fontSize: 13 }}>{sel?.products.length} منتج مشترك</span>
        </div>
        <div style={{ display:"flex", gap:8, padding:"10px 20px", background:"#fff", borderBottom:"1px solid #e2e8f0" }}>
          <select onChange={e => setSellerPriceFilter(e.target.value)} style={S.sel}>
            <option value="">كل المنتجات</option>
            <option value="cheaper_than_me">أرخص مني</option>
            <option value="more_than_me">أغلى مني</option>
          </select>
          {sellerPriceFilter && (
            <span style={{ fontSize: 13, color: "#6366f1", alignSelf:"center" }}>
              {sellerPriceFilter === "cheaper_than_me"
                ? `أرخص منك في ${sel?.products.filter(p => { const so = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(selectedSeller)); const mo = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(MY_ACCOUNT)); return so && mo && parseFloat(so.price) < parseFloat(mo.price); }).length} منتج`
                : `أغلى منك في ${sel?.products.filter(p => { const so = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(selectedSeller)); const mo = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(MY_ACCOUNT)); return so && mo && parseFloat(so.price) > parseFloat(mo.price); }).length} منتج`
              }
            </span>
          )}
        </div>
      <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {["صورة", "المنتج", "SKU", "سعر UAE", "سعر مصر", "سعره", "الفرق", "تاريخ Buy Box"].map(h => <th key={h} style={S.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {sel?.products.filter(p => {
                if (!sellerPriceFilter) return true;
                const so = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(selectedSeller));
                const mo = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(MY_ACCOUNT));
                if (!so || !mo) return false;
                if (sellerPriceFilter === "cheaper_than_me") return parseFloat(so.price) < parseFloat(mo.price);
                if (sellerPriceFilter === "more_than_me") return parseFloat(so.price) > parseFloat(mo.price);
                return true;
              }).map(p => {
                const sellerOffer = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(selectedSeller));
                const sellerPrice = sellerOffer ? parseFloat(sellerOffer.price) : null;
                const myOffer = p.sellers?.find(s => normalizeSellerName(s.seller) === normalizeSellerName(MY_ACCOUNT));
                const myPrice = myOffer ? parseFloat(myOffer.price) : null;
                const diff = myPrice && sellerPrice ? myPrice - sellerPrice : null;
                return (
                  <tr key={p.id} style={S.tr}>
                    <td style={S.td}>{p.image ? <img src={p.image} alt="" style={S.thumb} onError={e => e.target.style.display="none"} /> : <div style={S.noThumb}>📦</div>}</td>
                    <td style={{ ...S.td, maxWidth: 220 }}><div style={S.prodTitle}>{p.title || "—"}</div></td>
                    <td style={S.td}><span style={{ ...S.badge, background: "#f1f5f9", color: "#475569" }}>{p.sku}</span></td>
                    <td style={{ ...S.td, textAlign: "center" }}>{fmtAED(p.uae_price)}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>{fmtEGP(p.noon_eg_price)}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>{sellerPrice ? <strong style={{ color: "#ef4444" }}>{fmtEGP(sellerPrice)}</strong> : "—"}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      {diff != null ? (
                        <span style={{ color: diff > 0 ? "#059669" : "#ef4444", fontWeight: 600 }}>
                          {diff > 0 ? "+" : ""}{fmtEGP(diff)}
                        </span>
                      ) : "—"}
                    </td>
                    <td style={{ ...S.td, textAlign: "center" }}>
                      {Array.isArray(p.buybox_history) && p.buybox_history.length > 0 ? (
                        <div style={{ fontSize: 10, maxWidth: 120 }}>
                          {p.buybox_history.slice(-3).reverse().map((h, i) => (
                            <div key={i} style={{ color: normalizeSellerName(h.seller) === normalizeSellerName(selectedSeller) ? "#ef4444" : "#94a3b8", marginBottom: 2 }}>
                              {h.d}: {h.seller?.slice(0,15)}
                            </div>
                          ))}
                        </div>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div style={S.app} dir="rtl">
      <div style={{ ...S.actions, alignItems: "center" }}>
        <button onClick={onBack} style={S.btnGhost}>← رجوع</button>
        <strong style={{ fontSize: 15 }}>🏪 البائعين المنافسين ({sellers.length})</strong>
      </div>
      <div style={S.tableWrap}>
        {sellers.length === 0 ? (
          <div style={S.empty}>مفيش بائعين منافسين — اعمل سكراب نون مصر الأول</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {["البائع", "تقييم", "منتجات مشتركة", ""].map(h => <th key={h} style={S.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredSellers.map((s, i) => (
                <tr key={i} style={S.tr}>
                  <td style={S.td}>
                    <div><strong>{s.name}</strong></div>
                    {s.partner_code && <div style={{ fontSize: 11, color: "#94a3b8" }}>p-{s.partner_code.replace("p-","")}</div>}
                  </td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    {s.rating ? <span style={{ ...S.badge, background: "#fef9c3", color: "#713f12" }}>⭐ {s.rating} ({s.num_ratings || "—"})</span> : "—"}
                  </td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <span style={{ ...S.badge, background: "#dbeafe", color: "#1d4ed8", fontSize: 13 }}>{s.products.length} منتج</span>
                  </td>
                  <td style={{ ...S.td, textAlign: "center" }}>
                    <button onClick={() => setSelectedSeller(s.name)} style={S.btnPrimary}>عرض المنتجات</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ===================== MAIN APP =====================
export default function App() {
  const [authed, setAuthed] = useState(localStorage.getItem("noon_access") === "ok");
  const [products, setProducts] = useState([]);
  const [aedRate, setAedRate] = useState(13.6);
  const [commission, setCommission] = useState(15);
  const [userName, setUserName] = useState(localStorage.getItem("noon_username") || "");
  const [loading, setLoading] = useState(true);
  const [showSellers, setShowSellers] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSkuImport, setShowSkuImport] = useState(false);
  const [showBuyBoxReview, setShowBuyBoxReview] = useState(false);
  const [showCompetitor, setShowCompetitor] = useState(false);
  const [showFriendly, setShowFriendly] = useState(false);
  const [showShopImport, setShowShopImport] = useState(false);
  const [showScrapeUrl, setShowScrapeUrl] = useState(false);
  const [showScrapeEgypt, setShowScrapeEgypt] = useState(false);
  const [showScrapeEgyptForce, setShowScrapeEgyptForce] = useState(false);
  const [showDash, setShowDash] = useState(true);
  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [page, setPage] = useState(1);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [prods, rateSetting, commSetting] = await Promise.all([
        db.getProducts(),
        db.getSetting("aed_rate"),
        db.getSetting("commission"),
      ]);
      setProducts(prods || []);
      if (rateSetting?.rate) setAedRate(rateSetting.rate);
      if (commSetting?.percent != null) setCommission(commSetting.percent);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authed) return;
    if (!userName) { const n = prompt("👋 اكتب اسمك:"); if (n) { setUserName(n); localStorage.setItem("noon_username", n); } }
    loadData();
  }, [authed]);

  useEffect(() => { setPage(1); }, [activeTab, search, filterBrand, filterDate, filterStatus]);

  if (!authed) return <LoginGate onAuth={() => setAuthed(true)} />;

  const handleShipChange = async (id, value) => {
    const ship = parseFloat(value) || 0;
    const p = products.find(x => x.id === id);
    if (!p) return;
    const cost = p.uae_price > 0 ? calcCost(p.uae_price, aedRate, ship) : p.cost;
    const selling_price = cost ? calcSelling(cost) : p.selling_price;
    setProducts(prev => prev.map(x => x.id === id ? { ...x, shipping: ship, cost, selling_price } : x));
    await db.updateProduct(id, { shipping: ship, cost, selling_price });
  };

  const handleDelete = async (id) => {
    if (!window.confirm("مسح المنتج ده؟")) return;
    await db.deleteProduct(id);
    setProducts(prev => prev.filter(p => p.id !== id));
  };

  const exportCSV = (data) => {
    const headers = ["SKU", "النوع", "الاسم", "البراند", "سعر UAE", "شحن", "تكلفة", "سعر البيع", "صافي الربح", "حد أدنى", "حد أقصى", "سعر مقترح", "سعر نون مصر", "Buy Box", "أنت البائع", "سعرك", "عدد البائعين", "تقييم", "متاح", "تاريخ الإضافة"];
    const rows = data.map(p => {
      const cost = p.uae_price > 0 ? calcCost(p.uae_price, aedRate, p.shipping || 0) : "";
      const sell = cost ? calcSelling(cost) : "";
      const minP = cost ? Math.round(cost * 1.35) : "";
      const maxP = cost ? Math.round(cost * 1.65) : "";
      const competitors = Array.isArray(p.sellers) ? p.sellers.filter(s => normalizeSellerName(s.seller) !== normalizeSellerName(MY_ACCOUNT)) : [];
      const lowestComp = competitors.length > 0 ? Math.min(...competitors.map(s => parseFloat(s.price || 999999))) : null;
      const suggested = cost ? calcSuggestedPrice(cost, lowestComp === 999999 ? null : lowestComp) : "";
      const net = sell && cost ? calcNetProfit(sell, cost, commission) : "";
      return [p.sku, p.sku_type, p.title, p.brand, p.uae_price, p.shipping, cost ? Math.round(cost) : "", sell ? Math.round(sell) : "", net ? Math.round(net) : "", minP, maxP, suggested || "", p.noon_eg_price, p.buy_box_seller, p.i_am_seller ? "نعم" : "لأ", p.my_price, p.sellers?.length || "", p.rating, p.is_available ? "نعم" : "لأ", p.added_date];
    });
    const csv = [headers, ...rows].map(r => r.map(c => `"${c ?? ""}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `noon_${activeTab}_${today()}.csv`;
    a.click();
  };

  const brands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort();
  const dates = [...new Set(products.map(p => p.added_date).filter(Boolean))].sort().reverse();

  const filtered = products.filter(p => {
    if (activeTab === "N" && p.sku_type !== "N") return false;
    if (activeTab === "Z" && p.sku_type !== "Z") return false;
    if (activeTab === "losers") { const min = p.cost ? p.cost * 1.35 : null; if (!p.noon_eg_price || !min || parseFloat(p.noon_eg_price) >= min) return false; }
    if (activeTab === "changed" && !(p.prev_noon_eg_price != null && p.prev_noon_eg_price !== p.noon_eg_price)) return false;
    if (activeTab === "not_found" && !(p.not_found_uae || p.not_found_eg)) return false;
    if (activeTab === "z_uae_only" && !(p.sku_type === "Z" && !p.i_am_seller && (p.noon_eg_price === null || p.not_found_eg))) return false;
    if (activeTab === "needs_listing_no_sellers" && !(p.sku_type === "N" && !p.i_am_seller && (p.noon_eg_price === null || p.not_found_eg || (Array.isArray(p.sellers) && p.sellers.length === 0)))) return false;
    if (activeTab === "needs_listing_has_sellers" && !(p.sku_type === "N" && !p.i_am_seller && p.noon_eg_price != null && !p.not_found_eg && Array.isArray(p.sellers) && p.sellers.length > 0)) return false;
    if (activeTab === "not_selling" && !(p.noon_eg_price != null && !p.i_am_seller)) return false;
    if (activeTab === "cheaper_exists" && !(p.i_am_seller && !p.i_have_buy_box)) return false;
    if (activeTab === "buybox" && !p.i_have_buy_box) return false;
    if (search && !(p.title?.toLowerCase().includes(search.toLowerCase()) || p.sku?.toLowerCase().includes(search.toLowerCase()))) return false;
    if (filterBrand && p.brand !== filterBrand) return false;
    if (filterDate && p.added_date !== filterDate) return false;
    if (filterStatus === "available" && !p.is_available) return false;
    if (filterStatus === "unavailable" && p.is_available !== false) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageData = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const tc = {
    all: products.length,
    N: products.filter(p => p.sku_type === "N").length,
    Z: products.filter(p => p.sku_type === "Z").length,
    buybox: products.filter(p => p.i_have_buy_box).length,
    cheaper_exists: products.filter(p => p.i_am_seller && !p.i_have_buy_box).length,
    not_selling: products.filter(p => p.noon_eg_price != null && !p.i_am_seller).length,
    losers: products.filter(p => { if (!p.noon_eg_price || !p.cost) return false; const min = p.cost * 1.35; return parseFloat(p.noon_eg_price) < min; }).length,
    changed: products.filter(p => p.prev_noon_eg_price != null && p.prev_noon_eg_price !== p.noon_eg_price).length,
    not_found: products.filter(p => p.not_found_uae || p.not_found_eg).length,
    z_uae_only: products.filter(p => p.sku_type === "Z" && !p.i_am_seller && (p.noon_eg_price === null || p.not_found_eg)).length,
    needs_listing_no_sellers: products.filter(p => p.sku_type === "N" && !p.i_am_seller && (p.noon_eg_price === null || p.not_found_eg || (Array.isArray(p.sellers) && p.sellers.length === 0))).length,
    needs_listing_has_sellers: products.filter(p => p.sku_type === "N" && !p.i_am_seller && p.noon_eg_price != null && !p.not_found_eg && Array.isArray(p.sellers) && p.sellers.length > 0).length,
  };

  return (
    <div style={S.app} dir="rtl">
      {showFriendly ? <FriendlySellersPage products={products} onBack={() => setShowFriendly(false)} /> : showSellers ? <SellersPage products={products} onBack={() => setShowSellers(false)} /> : <>
      <header style={S.header}>
        <div style={S.hLeft}>
          <div style={S.logo}>🛒</div>
          <div><div style={S.logoText}>Noon Pricing Tool</div><div style={S.logoSub}>أداة تسعير نون</div></div>
          {userName && <div style={S.userPill}>👤 {userName}</div>}
        </div>
        <div style={S.hRight}>
          <div style={S.ratePill}>🇦🇪 1 د.إ = <strong>{aedRate}</strong> ج.م</div>
          <button onClick={loadData} style={S.hBtn}>🔄</button>
          <button onClick={() => setShowSettings(true)} style={S.hBtn}>⚙️</button>
          <button onClick={() => { localStorage.removeItem("noon_access"); setAuthed(false); }} style={S.hBtn}>🚪</button>
        </div>
      </header>

      <div style={S.actions}>
        <button onClick={() => setShowScrapeUrl(true)} style={{ ...S.btnPrimary, background: "#7c3aed" }}>🔍 سكراب كاتيجوري</button>
        <button onClick={() => setShowSkuImport(true)} style={{ ...S.btnPrimary, background: "#0891b2" }}>📋 استيراد SKUs</button>
        <button onClick={() => setShowScrapeEgypt(true)} style={{ ...S.btnPrimary, background: "#059669" }}>🇪🇬 تحديث أسعار مصر</button>
        <button onClick={() => setShowScrapeEgyptForce(true)} style={{ ...S.btnGhost, borderColor: "#059669", color: "#059669" }}>⚡ تحديث إجباري</button>
        <button onClick={() => setShowBuyBoxReview(true)} style={{ ...S.btnPrimary, background: "#f59e0b" }}>🔍 مراجعة Buy Box</button>
        <button onClick={() => setShowCompetitor(true)} style={{ ...S.btnPrimary, background: "#7c3aed" }}>🕵️ سكراب منافس</button>
        <button onClick={() => setShowFriendly(true)} style={{ ...S.btnPrimary, background: "#059669" }}>🤝 البائعين الأصدقاء</button>
        <button onClick={() => setShowShopImport(true)} style={{ ...S.btnGhost, borderColor: "#059669", color: "#059669" }}>🏪 أسعار المحل</button>
        <button onClick={() => exportCSV(filtered)} style={S.btnGhost}>💾 تصدير CSV</button>
        <button onClick={() => setShowSellers(true)} style={{ ...S.btnGhost, borderColor: "#8b5cf6", color: "#8b5cf6" }}>🏪 البائعين</button>
        <button onClick={() => setShowDash(!showDash)} style={S.btnGhost}>📊</button>
      </div>

      {showDash && <Dashboard products={products} commission={commission} />}

      <div style={S.filters}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث..." style={S.searchInput} />
        <select value={filterBrand} onChange={e => setFilterBrand(e.target.value)} style={S.sel}>
          <option value="">🏷️ كل البراندات</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={filterDate} onChange={e => setFilterDate(e.target.value)} style={S.sel}>
          <option value="">📅 كل التواريخ</option>
          {dates.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={S.sel}>
          <option value="">📦 كل الحالات</option>
          <option value="available">✅ متاح</option>
          <option value="unavailable">❌ غير متاح</option>
        </select>
        {(search || filterBrand || filterDate || filterStatus) && (
          <button onClick={() => { setSearch(""); setFilterBrand(""); setFilterDate(""); setFilterStatus(""); }} style={S.clearBtn}>✖ مسح</button>
        )}
      </div>

      <div style={S.tabs}>
        {[
          ["all", `الكل (${tc.all})`],
          ["N", `N (${tc.N})`],
          ["Z", `Z (${tc.Z})`],
          ["buybox", `🏆 Buy Box (${tc.buybox})`],
          ["cheaper_exists", `⚠️ في أرخص (${tc.cheaper_exists})`],
          ["not_selling", `🚫 مش عارضها (${tc.not_selling})`],
          ["losers", `🔴 خاسرة (${tc.losers})`],
          ["changed", `📉 تغير سعرها (${tc.changed})`],
          ["not_found", `❓ مش موجود (${tc.not_found})`],
          ["z_uae_only", `🔵 Z في UAE مش في مصر (${tc.z_uae_only})`],
          ["needs_listing_no_sellers", `🆕 محتاجة تتعرض — مفيش تجار (${tc.needs_listing_no_sellers})`],
          ["needs_listing_has_sellers", `🏪 محتاجة تتعرض — في تجار (${tc.needs_listing_has_sellers})`],
        ].map(([id, lbl]) => (
          <button key={id} onClick={() => setActiveTab(id)} style={{ ...S.tab, ...(activeTab === id ? S.tabOn : {}) }}>{lbl}</button>
        ))}
      </div>

      <div style={S.tableWrap}>
        {loading ? <div style={S.empty}>⏳ جاري التحميل...</div>
          : pageData.length === 0 ? (
            <div style={S.empty}>
              {products.length === 0
                ? <div><div style={{ fontSize: 40, marginBottom: 12 }}>🛒</div><div>اضغط «سكراب كاتيجوري» أو «استيراد SKUs» للبدء</div></div>
                : "🔍 مفيش نتائج"}
            </div>
          ) : (
            <table style={S.table}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["صورة", "المنتج", "سعر UAE", "شحن", "تكلفة", "سعر البيع", "صافي الربح", "نون مصر / مقترح", "بائعين", "حالتك", "إجراءات"].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageData.map(p => (
                  <ProductRow key={p.id} p={p} aedRate={aedRate} commission={commission} onShipChange={handleShipChange} onDelete={handleDelete} />
                ))}
              </tbody>
            </table>
          )}
      </div>

      <div style={S.footer}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12 }}>
          <button onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage <= 1} style={{ ...S.btnGhost, padding: "4px 12px", opacity: safePage <= 1 ? 0.4 : 1 }}>→ السابق</button>
          <span>صفحة {safePage} من {totalPages} — عرض {pageData.length} من {filtered.length} منتج</span>
          <button onClick={() => setPage(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages} style={{ ...S.btnGhost, padding: "4px 12px", opacity: safePage >= totalPages ? 0.4 : 1 }}>التالي ←</button>
        </div>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} userName={userName} setUserName={setUserName} aedRate={aedRate} setAedRate={setAedRate} commission={commission} setCommission={setCommission} />}
      {showScrapeUrl && <ScrapeUrlModal onClose={() => setShowScrapeUrl(false)} onDone={loadData} userName={userName} products={products} />}
      {showScrapeEgypt && <ScrapeEgyptModal onClose={() => setShowScrapeEgypt(false)} products={products} onDone={loadData} userName={userName} forceUpdate={false} />}
      {showScrapeEgyptForce && <ScrapeEgyptModal onClose={() => setShowScrapeEgyptForce(false)} products={products} onDone={loadData} userName={userName} forceUpdate={true} />}
      {showShopImport && <ShopImportModal onClose={() => setShowShopImport(false)} onDone={loadData} userName={userName} products={products} />}
      {showFriendly && <FriendlySellersPage products={products} onBack={() => setShowFriendly(false)} />}
      {showCompetitor && <CompetitorScrapeModal onClose={() => setShowCompetitor(false)} onDone={loadData} userName={userName} products={products} />}
      {showBuyBoxReview && <BuyBoxReviewModal onClose={() => setShowBuyBoxReview(false)} products={products} onDone={loadData} userName={userName} />}
      {showSkuImport && <SkuImportModal onClose={() => setShowSkuImport(false)} onDone={loadData} userName={userName} products={products} />}
    </>
    }</div>
  );
}

// ===================== STYLES =====================
const S = {
  app: { fontFamily: "'Segoe UI',Tahoma,Arial,sans-serif", minHeight: "100vh", background: "#f1f5f9", color: "#1e293b" },
  header: { background: "linear-gradient(135deg,#1e1b4b,#4338ca)", color: "#fff", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.25)" },
  hLeft: { display: "flex", alignItems: "center", gap: 12 },
  hRight: { display: "flex", alignItems: "center", gap: 10 },
  logo: { fontSize: 28 },
  logoText: { fontSize: 18, fontWeight: 800 },
  logoSub: { fontSize: 11, color: "rgba(255,255,255,0.6)" },
  userPill: { background: "rgba(255,255,255,0.15)", padding: "4px 12px", borderRadius: 20, fontSize: 12 },
  ratePill: { background: "rgba(255,255,255,0.1)", padding: "5px 12px", borderRadius: 8, fontSize: 13, border: "1px solid rgba(255,255,255,0.2)" },
  hBtn: { background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
  actions: { display: "flex", gap: 8, padding: "12px 20px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" },
  btnPrimary: { background: "#6366f1", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  btnGhost: { background: "#fff", color: "#374151", border: "1px solid #d1d5db", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
  btnSm: { background: "#6366f1", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  dashGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 10, padding: "14px 20px" },
  dashCard: { background: "#fff", borderRadius: 10, padding: "14px 10px", textAlign: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" },
  filters: { display: "flex", gap: 8, padding: "10px 20px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap", alignItems: "center" },
  searchInput: { padding: "7px 12px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, minWidth: 180 },
  sel: { padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, background: "#fff" },
  clearBtn: { padding: "7px 12px", background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12 },
  tabs: { display: "flex", background: "#fff", borderBottom: "2px solid #e2e8f0", padding: "0 20px", overflowX: "auto" },
  tab: { padding: "10px 14px", border: "none", background: "none", cursor: "pointer", fontSize: 12, color: "#64748b", borderBottom: "2px solid transparent", marginBottom: -2, whiteSpace: "nowrap" },
  tabOn: { color: "#6366f1", borderBottomColor: "#6366f1", fontWeight: 700 },
  tableWrap: { padding: "0 20px 24px", overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", marginTop: 12 },
  th: { padding: "10px 12px", textAlign: "right", fontSize: 12, fontWeight: 600, color: "#64748b", borderBottom: "1px solid #e2e8f0", whiteSpace: "nowrap" },
  tr: { borderBottom: "1px solid #f1f5f9" },
  td: { padding: "10px 12px", fontSize: 13, verticalAlign: "middle" },
  thumb: { width: 50, height: 50, objectFit: "contain", borderRadius: 8, border: "1px solid #e2e8f0" },
  noThumb: { width: 50, height: 50, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, background: "#f8fafc", borderRadius: 8 },
  prodTitle: { fontWeight: 500, fontSize: 13, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badge: { padding: "2px 7px", borderRadius: 10, fontSize: 11, fontWeight: 600 },
  shipInput: { width: 65, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12, textAlign: "center" },
  iconBtn: { background: "none", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", padding: "4px 6px", fontSize: 13, textDecoration: "none", display: "inline-block", position: "relative" },
  greenDot: { position: "absolute", top: -3, right: -3, width: 8, height: 8, borderRadius: "50%", background: "#22c55e" },
  redDot: { position: "absolute", top: -3, right: -3, width: 8, height: 8, borderRadius: "50%", background: "#ef4444" },
  sellerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 8, marginBottom: 6 },
  buyBoxBadge: { background: "#dbeafe", color: "#1d4ed8", fontSize: 10, padding: "2px 6px", borderRadius: 6, fontWeight: 700 },
  meBadge: { background: "#dcfce7", color: "#15803d", fontSize: 10, padding: "2px 6px", borderRadius: 6, fontWeight: 700 },
  empty: { textAlign: "center", padding: "60px 20px", color: "#9ca3af", fontSize: 15 },
  footer: { textAlign: "center", padding: "12px", color: "#64748b", fontSize: 12, background: "#fff", borderTop: "1px solid #e2e8f0" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 },
  modal: { background: "#fff", borderRadius: 16, padding: 24, width: "100%", maxWidth: 440, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 25px 60px rgba(0,0,0,0.3)" },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { fontSize: 17, fontWeight: 700 },
  closeBtn: { background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#9ca3af" },
  card: { background: "#f8fafc", borderRadius: 10, padding: "14px", marginBottom: 12 },
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 8 },
  input: { width: "100%", padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, boxSizing: "border-box" },
  row: { display: "flex", gap: 8, alignItems: "center" },
  hint: { fontSize: 11, color: "#94a3b8", margin: "6px 0 0" },
  histRow: { display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: "1px solid #e2e8f0" },
  progWrap: { width: "100%", height: 8, background: "#e2e8f0", borderRadius: 99, overflow: "hidden", margin: "10px 0 4px" },
  progBar: { height: "100%", background: "linear-gradient(90deg,#6366f1,#8b5cf6)", borderRadius: 99, transition: "width 0.3s ease" },
  logBox: { background: "#0f172a", borderRadius: 8, padding: "10px 12px", maxHeight: 220, overflowY: "auto", fontFamily: "monospace" },
};
