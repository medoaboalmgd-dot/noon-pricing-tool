import { useState, useEffect, useCallback } from "react";

// ===================== CONFIG =====================
const SUPABASE_URL = "https://mxddjewxppkwhlkvejtx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZGRqZXd4cHBrd2hsa3ZlanR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTk3NTQsImV4cCI6MjA5NjU5NTc1NH0.SBojidbDLTlcMi04BDGJlcsuq_V2kpXC0uN8Lcufwic";
const APIFY_ACTOR = "shahidirfan~noon-com-scraper";

// ===================== SUPABASE CLIENT =====================
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
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${res.status} ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const db = {
  getProducts: () => sb("products?order=created_at.desc&select=*"),
  upsertProducts: (arr) => sb("products", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: JSON.stringify(arr) }),
  updateProduct: (id, data) => sb(`products?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteProduct: (id) => sb(`products?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" }),
  getSetting: async (key) => {
    const r = await sb(`settings?key=eq.${key}&select=value`);
    return r?.[0]?.value ?? null;
  },
  setSetting: (key, value) => sb("settings", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: JSON.stringify({ key, value }) }),
};

// ===================== UTILS =====================
const extractSKU = (url) => {
  if (!url) return null;
  const m = url.match(/\/([NZ][A-Z0-9]{5,})\//i);
  return m ? m[1].toUpperCase() : null;
};
const buildEgyptUrl = (sku, uaeUrl) => {
  if (uaeUrl) {
    return uaeUrl.replace("noon.com/uae-en/", "noon.com/egypt-en/").split("?")[0];
  }
  return sku ? `https://www.noon.com/egypt-en/${sku}/p/` : null;
};
const skuType = (sku) => !sku ? "?" : sku.startsWith("N") ? "N" : sku.startsWith("Z") ? "Z" : "?";
const calcCost = (price, aedRate, shipping) => parseFloat(price) * parseFloat(aedRate) + parseFloat(shipping || 0);
const calcSelling = (cost) => cost * 1.6;
const calcMargin = (sell, cost) => cost > 0 ? (((sell - cost) / sell) * 100).toFixed(1) : 0;
const fmtEGP = (n) => n != null ? `${Math.round(n).toLocaleString("ar-EG")} ج.م` : "—";
const fmtAED = (n) => n != null ? `${parseFloat(n).toFixed(2)} د.إ` : "—";
const today = () => new Date().toISOString().split("T")[0];

// ===================== APIFY SCRAPE MODAL =====================
const ScrapeUrlModal = ({ onClose, onDone, userName }) => {
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
    log(`🚀 بدأ السكراب على: ${url}`);
    log(`📦 عدد المنتجات المطلوبة: ${maxProducts}`);

    try {
      // 1. Run actor
      log("⏳ بيشغّل الـ Actor على Apify...");
      const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          startUrl: url.trim(),
          maxProducts: parseInt(maxProducts),
          maxPages: parseInt(maxPages),
        }),
      });
      if (!runRes.ok) throw new Error(`فشل تشغيل الـ Actor: ${runRes.status}`);
      const runData = await runRes.json();
      const runId = runData.data?.id;
      const datasetId = runData.data?.defaultDatasetId;
      if (!runId) throw new Error("مفيش Run ID");
      log(`✅ اتشغّل — Run ID: ${runId}`);
      setProgress(20);

      // 2. Poll until done
      log("⏳ بينتظر تنتهي العملية...");
      let attempts = 0;
      let succeeded = false;
      while (attempts < 60) {
        await new Promise(r => setTimeout(r, 5000));
        const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const stData = await st.json();
        const status = stData.data?.status;
        const itemCount = stData.data?.stats?.itemCount || 0;
        setProgress(20 + Math.min(50, attempts * 3));
        log(`📊 الحالة: ${status} | منتجات: ${itemCount}`);
        if (status === "SUCCEEDED") { succeeded = true; break; }
        if (status === "FAILED" || status === "ABORTED") throw new Error(`السكراب ${status}`);
        attempts++;
      }
      if (!succeeded) throw new Error("انتهى الوقت — جرب تزود maxPages");

      // 3. Get results
      setProgress(75);
      log("📥 بيجيب النتايج...");
      const resultsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?limit=${maxProducts}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const items = await resultsRes.json();
      log(`✅ جاب ${items.length} منتج`);

      // 4. Process & save
      setProgress(85);
      const aedSetting = await db.getSetting("aed_rate");
      const aedRate = aedSetting?.rate || 13.6;

      const products = items
        .filter(item => item.url || item.sku)
        .map(item => {
          const sku = (item.sku || extractSKU(item.url) || "").toUpperCase();
          const egUrl = buildEgyptUrl(sku, item.url);
          const uaePrice = parseFloat(item.currentPrice || 0);
          const cost = uaePrice > 0 ? calcCost(uaePrice, aedRate, 0) : null;
          const sellingPrice = cost ? calcSelling(cost) : null;
          return {
            id: sku,
            sku: sku || null,
            sku_type: skuType(sku),
            title: item.title || "",
            brand: item.brand || "",
            image: item.image || "",
            uae_url: item.url || "",
            egypt_url: egUrl,
            uae_price: uaePrice || null,
            noon_eg_price: null,
            prev_noon_eg_price: null,
            is_available: null,
            shipping: 0,
            cost,
            selling_price: sellingPrice,
            added_date: today(),
            added_by: userName,
            last_updated: today(),
            price_changed_at: null,
          };
        })
        .filter(p => p.sku && p.sku.length >= 5);

      log(`⬆️ بيرفع ${products.length} منتج على Supabase...`);
      await db.upsertProducts(products);
      setProgress(100);
      log(`🎉 تم! اتضافوا ${products.length} منتج بنجاح`, "success");
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
          <span style={S.modalTitle}>🔍 سكراب منتجات نون UAE</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>

        {!running && !done && (
          <>
            <div style={S.card}>
              <label style={S.label}>🔗 لينك الكاتيجوري على نون UAE</label>
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                style={S.input}
                placeholder="https://www.noon.com/uae-en/electronics-and-mobiles/"
                dir="ltr"
              />
              <p style={S.hint}>حط لينك أي كاتيجوري أو صفحة بحث على noon.com/uae-en/</p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div style={S.card}>
                <label style={S.label}>📦 عدد المنتجات</label>
                <input type="number" value={maxProducts} onChange={e => setMaxProducts(e.target.value)}
                  style={S.input} min={1} max={500} />
              </div>
              <div style={S.card}>
                <label style={S.label}>📄 عدد الصفحات</label>
                <input type="number" value={maxPages} onChange={e => setMaxPages(e.target.value)}
                  style={S.input} min={1} max={20} />
              </div>
            </div>

            <div style={{ ...S.card, background: "#fffbeb", border: "1px solid #fde68a" }}>
              <p style={{ fontSize: 12, color: "#92400e" }}>
                ⚠️ محتاج Apify API Token في الإعدادات — السكراب بياخد من 1 لـ 5 دقايق حسب عدد المنتجات
              </p>
            </div>
          </>
        )}

        {(running || done) && (
          <>
            <div style={S.progWrap}>
              <div style={{ ...S.progBar, width: `${progress}%` }} />
            </div>
            <div style={{ textAlign: "center", color: "#6366f1", fontWeight: 700, marginBottom: 10 }}>{progress}%</div>
            <div style={S.logBox}>
              {logs.map((l, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <span style={{ color: "#475569", fontSize: 10, minWidth: 55 }}>{l.time}</span>
                  <span style={{
                    fontSize: 12,
                    color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8"
                  }}>{l.msg}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          {!running && <button onClick={onClose} style={S.btnGhost}>{done ? "إغلاق" : "إلغاء"}</button>}
          {!running && !done && (
            <button onClick={run} style={{ ...S.btnPrimary, background: "#7c3aed" }}>
              🚀 ابدأ السكراب
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ===================== SETTINGS PANEL =====================
const SettingsPanel = ({ onClose, userName, setUserName, aedRate, setAedRate }) => {
  const [rate, setRate] = useState(aedRate);
  const [token, setToken] = useState(localStorage.getItem(`apify_token_${userName}`) || "");
  const [history, setHistory] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    db.getSetting("aed_rate").then(v => { if (v?.history) setHistory(v.history); });
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

  const saveToken = () => {
    localStorage.setItem(`apify_token_${userName}`, token);
    alert("✅ تم حفظ الـ API Token");
  };

  const saveName = () => {
    localStorage.setItem("noon_username", userName);
    alert("✅ تم حفظ الاسم");
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modal, maxWidth: 480 }}>
        <div style={S.modalHead}>
          <span style={S.modalTitle}>⚙️ الإعدادات</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>

        <div style={S.card}>
          <label style={S.label}>👤 اسم المستخدم</label>
          <div style={S.row}>
            <input value={userName} onChange={e => setUserName(e.target.value)} style={S.input} placeholder="اكتب اسمك" />
            <button onClick={saveName} style={S.btnSm}>حفظ</button>
          </div>
        </div>

        <div style={S.card}>
          <label style={S.label}>🔑 Apify API Token</label>
          <div style={S.row}>
            <input value={token} onChange={e => setToken(e.target.value)} style={S.input} type="password" placeholder="apify_api_..." />
            <button onClick={saveToken} style={S.btnSm}>حفظ</button>
          </div>
          <p style={S.hint}>بيتحفظ على جهازك بس — مش على السيرفر</p>
        </div>

        <div style={S.card}>
          <label style={S.label}>🇦🇪 سعر الدرهم الإماراتي</label>
          <div style={S.row}>
            <input value={rate} onChange={e => setRate(e.target.value)} style={{ ...S.input, maxWidth: 120 }} type="number" step="0.01" />
            <span style={{ color: "#64748b", fontSize: 13 }}>ج.م = 1 د.إ</span>
            <button onClick={saveRate} disabled={saving} style={S.btnSm}>{saving ? "..." : "💾 حفظ"}</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: "#059669", fontWeight: 600 }}>السعر الحالي: {aedRate} ج.م</div>
          {history.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>📋 سجل التحديثات</div>
              {history.map((h, i) => (
                <div key={i} style={S.histRow}>
                  <strong>{h.rate} ج.م</strong>
                  <span style={{ color: "#94a3b8" }}>{h.date}</span>
                  <span style={{ color: "#94a3b8" }}>{h.user}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={onClose} style={{ ...S.btnPrimary, width: "100%", marginTop: 4 }}>إغلاق</button>
      </div>
    </div>
  );
};

// ===================== SCRAPE EGYPT MODAL =====================
const ScrapeEgyptModal = ({ onClose, products, onDone, userName }) => {
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const log = (msg, type = "info") => setLogs(l => [...l, { msg, type, time: new Date().toLocaleTimeString("ar-EG") }]);

  const run = async () => {
    const token = localStorage.getItem(`apify_token_${userName}`);
    if (!token) { alert("سجل الـ Apify API Token في الإعدادات أولاً"); return; }
    setRunning(true);
    const toScrape = products.filter(p => p.egypt_url);
    log(`🚀 بدأ السكراب — ${toScrape.length} منتج`);

    for (let i = 0; i < toScrape.length; i++) {
      const p = toScrape[i];
      setProgress(Math.round(((i + 1) / toScrape.length) * 100));
      log(`[${i + 1}/${toScrape.length}] ${p.sku} — ${p.title?.slice(0, 35) || "—"}`);
      try {
        const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ startUrl: p.egypt_url, maxProducts: 1, maxPages: 1 }),
        });
        if (!runRes.ok) throw new Error(`Run failed ${runRes.status}`);
        const runData = await runRes.json();
        const runId = runData.data?.id;
        const datasetId = runData.data?.defaultDatasetId;
        let ok = false;
        for (let a = 0; a < 25; a++) {
          await new Promise(r => setTimeout(r, 3000));
          const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } });
          const stData = await st.json();
          const status = stData.data?.status;
          if (status === "SUCCEEDED") { ok = true; break; }
          if (status === "FAILED" || status === "ABORTED") throw new Error(`Run ${status}`);
        }
        if (!ok) throw new Error("Timeout");
        const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
        const items = await res.json();
        if (items.length > 0) {
          const item = items[0];
          const newPrice = item.currentPrice ?? null;
          const prevPrice = p.noon_eg_price;
          const priceChanged = prevPrice !== null && prevPrice !== newPrice;
          const aedSetting = await db.getSetting("aed_rate");
          const aedRate = aedSetting?.rate || 13.6;
          const cost = p.uae_price > 0 ? calcCost(p.uae_price, aedRate, p.shipping || 0) : p.cost;
          const selling_price = cost ? calcSelling(cost) : p.selling_price;
          await db.updateProduct(p.id, {
            noon_eg_price: newPrice,
            prev_noon_eg_price: priceChanged ? prevPrice : p.prev_noon_eg_price,
            is_available: item.isBuyable !== false,
            price_changed_at: priceChanged ? today() : p.price_changed_at,
            cost, selling_price, last_updated: today(),
          });
          log(`  ✅ ${newPrice} ج.م | ${item.isBuyable ? "متاح" : "غير متاح"}`, "success");
        } else {
          await db.updateProduct(p.id, { is_available: false, last_updated: today() });
          log(`  ⚠️ مش موجود على نون مصر`);
        }
      } catch (e) {
        log(`  ❌ ${e.message}`, "error");
      }
      await new Promise(r => setTimeout(r, 1200));
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
          <span style={S.modalTitle}>🇪🇬 سكراب أسعار نون مصر</span>
          <button onClick={onClose} style={S.closeBtn}>✖</button>
        </div>
        <p style={S.hint}>سيشتغل على <strong>{products.filter(p => p.egypt_url).length}</strong> منتج</p>
        {!running && !done && (
          <button onClick={run} style={{ ...S.btnPrimary, width: "100%", background: "#059669" }}>🚀 ابدأ السكراب</button>
        )}
        {(running || done) && (
          <>
            <div style={S.progWrap}><div style={{ ...S.progBar, width: `${progress}%` }} /></div>
            <div style={{ textAlign: "center", color: "#6366f1", fontWeight: 700, marginBottom: 8 }}>{progress}%</div>
            <div style={S.logBox}>
              {logs.map((l, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                  <span style={{ color: "#475569", fontSize: 10, minWidth: 55 }}>{l.time}</span>
                  <span style={{ color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8", fontSize: 12 }}>{l.msg}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {done && <button onClick={onClose} style={{ ...S.btnPrimary, marginTop: 12, width: "100%" }}>✅ إغلاق</button>}
      </div>
    </div>
  );
};

// ===================== DASHBOARD =====================
const Dashboard = ({ products }) => {
  const total = products.length;
  const nCount = products.filter(p => p.sku_type === "N").length;
  const zCount = products.filter(p => p.sku_type === "Z").length;
  const losers = products.filter(p => p.noon_eg_price != null && p.selling_price && parseFloat(p.noon_eg_price) < parseFloat(p.selling_price)).length;
  const changed = products.filter(p => p.prev_noon_eg_price != null && p.prev_noon_eg_price !== p.noon_eg_price).length;
  const margins = products.filter(p => p.selling_price && p.cost).map(p => parseFloat(calcMargin(p.selling_price, p.cost)));
  const avgMargin = margins.length ? (margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(1) : 0;
  const available = products.filter(p => p.is_available === true).length;

  const cards = [
    { v: total, lbl: "إجمالي المنتجات", icon: "📦", c: "#6366f1" },
    { v: nCount, lbl: "منتجات N", icon: "🟢", c: "#10b981" },
    { v: zCount, lbl: "منتجات Z", icon: "🔵", c: "#3b82f6" },
    { v: losers, lbl: "منتجات خاسرة", icon: "🔴", c: "#ef4444" },
    { v: `${avgMargin}%`, lbl: "متوسط هامش الربح", icon: "📈", c: "#f59e0b" },
    { v: available, lbl: "متاحة على نون مصر", icon: "✅", c: "#14b8a6" },
    { v: changed, lbl: "تغير سعرها", icon: "📉", c: "#8b5cf6" },
  ];

  return (
    <div style={S.dashGrid}>
      {cards.map((c, i) => (
        <div key={i} style={{ ...S.dashCard, borderTop: `3px solid ${c.c}` }}>
          <div style={{ fontSize: 22 }}>{c.icon}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: c.c, margin: "6px 0 2px" }}>{c.v}</div>
          <div style={{ fontSize: 11, color: "#64748b" }}>{c.lbl}</div>
        </div>
      ))}
    </div>
  );
};

// ===================== PRODUCT ROW =====================
const ProductRow = ({ p, aedRate, onShipChange, onDelete }) => {
  const [exp, setExp] = useState(false);
  const cost = p.uae_price > 0 ? calcCost(p.uae_price, aedRate, p.shipping || 0) : null;
  const sell = cost ? calcSelling(cost) : null;
  const margin = sell && cost ? calcMargin(sell, cost) : null;
  const isLoser = p.noon_eg_price != null && sell && parseFloat(p.noon_eg_price) < sell;
  const priceChanged = p.prev_noon_eg_price != null && p.prev_noon_eg_price !== p.noon_eg_price;

  return (
    <>
      <tr style={{ ...S.tr, background: isLoser ? "#fff5f5" : "white" }}>
        <td style={S.td}>
          {p.image
            ? <img src={p.image} alt="" style={S.thumb} onError={e => e.target.style.display = "none"} />
            : <div style={S.noThumb}>📦</div>}
        </td>
        <td style={{ ...S.td, maxWidth: 240 }}>
          <div style={S.prodTitle}>{p.title || "—"}</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
            <span style={{ ...S.badge, background: p.sku_type === "N" ? "#d1fae5" : "#dbeafe", color: p.sku_type === "N" ? "#065f46" : "#1e40af" }}>{p.sku_type}</span>
            <span style={{ ...S.badge, background: "#f1f5f9", color: "#475569" }}>{p.sku || "—"}</span>
            {p.brand && <span style={{ ...S.badge, background: "#fef3c7", color: "#92400e" }}>{p.brand}</span>}
          </div>
        </td>
        <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>{fmtAED(p.uae_price)}</td>
        <td style={{ ...S.td, textAlign: "center" }}>
          <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "center" }}>
            <input type="number" value={p.shipping || ""} onChange={e => onShipChange(p.id, e.target.value)}
              style={S.shipInput} placeholder="0" />
            <span style={{ fontSize: 10, color: "#9ca3af" }}>ج.م</span>
          </div>
        </td>
        <td style={{ ...S.td, textAlign: "center", whiteSpace: "nowrap" }}>{fmtEGP(cost)}</td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {sell ? <strong style={{ color: "#059669" }}>{fmtEGP(sell)}</strong> : "—"}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {margin != null
            ? <span style={{ color: parseFloat(margin) >= 30 ? "#059669" : parseFloat(margin) >= 20 ? "#f59e0b" : "#ef4444", fontWeight: 600 }}>{margin}%</span>
            : "—"}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {p.noon_eg_price != null ? (
            <div>
              <div style={{ color: isLoser ? "#ef4444" : "#059669", fontWeight: 600 }}>
                {fmtEGP(p.noon_eg_price)}{isLoser && " 🔴"}
              </div>
              {priceChanged && (
                <div style={{ fontSize: 10, color: "#94a3b8" }}>
                  كان: {fmtEGP(p.prev_noon_eg_price)}
                  {parseFloat(p.noon_eg_price) > parseFloat(p.prev_noon_eg_price) ? " 📈" : " 📉"}
                </div>
              )}
            </div>
          ) : <span style={{ color: "#d1d5db", fontSize: 11 }}>لم يُسكرب</span>}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          {p.is_available === null ? <span style={{ color: "#d1d5db" }}>—</span>
            : p.is_available ? "✅" : "❌"}
        </td>
        <td style={{ ...S.td, textAlign: "center" }}>
          <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>
            <button onClick={() => setExp(!exp)} style={S.iconBtn} title="تفاصيل">👁️</button>
            {p.egypt_url && <a href={p.egypt_url} target="_blank" rel="noreferrer" style={S.iconBtn} title="نون مصر">🇪🇬</a>}
            {p.uae_url && <a href={p.uae_url} target="_blank" rel="noreferrer" style={S.iconBtn} title="نون UAE">🇦🇪</a>}
            <button onClick={() => onDelete(p.id)} style={{ ...S.iconBtn, color: "#ef4444" }} title="حذف">🗑️</button>
          </div>
        </td>
      </tr>
      {exp && (
        <tr>
          <td colSpan={10} style={{ background: "#f8fafc", padding: "10px 16px", borderBottom: "1px solid #e2e8f0", fontSize: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px,1fr))", gap: 8 }}>
              <div><span style={{ color: "#94a3b8" }}>تاريخ الإضافة: </span>{p.added_date}</div>
              <div><span style={{ color: "#94a3b8" }}>أضافه: </span>{p.added_by}</div>
              <div><span style={{ color: "#94a3b8" }}>آخر تحديث: </span>{p.last_updated}</div>
              {p.price_changed_at && <div><span style={{ color: "#94a3b8" }}>تغير السعر: </span>{p.price_changed_at}</div>}
              <div><span style={{ color: "#94a3b8" }}>لينك UAE: </span>{p.uae_url ? <a href={p.uae_url} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>فتح ↗</a> : "—"}</div>
              <div><span style={{ color: "#94a3b8" }}>لينك مصر: </span>{p.egypt_url ? <a href={p.egypt_url} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>فتح ↗</a> : "—"}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

// ===================== MAIN APP =====================
export default function App() {
  const [products, setProducts] = useState([]);
  const [aedRate, setAedRate] = useState(13.6);
  const [userName, setUserName] = useState(localStorage.getItem("noon_username") || "");
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showScrapeUrl, setShowScrapeUrl] = useState(false);
  const [showScrapeEgypt, setShowScrapeEgypt] = useState(false);
  const [showDash, setShowDash] = useState(true);
  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");
  const [filterBrand, setFilterBrand] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [prods, rateSetting] = await Promise.all([db.getProducts(), db.getSetting("aed_rate")]);
      setProducts(prods || []);
      if (rateSetting?.rate) setAedRate(rateSetting.rate);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!userName) {
      const n = prompt("👋 أهلاً! اكتب اسمك للبدء:");
      if (n) { setUserName(n); localStorage.setItem("noon_username", n); }
    }
    loadData();
  }, []);

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
    if (!confirm("مسح المنتج ده؟")) return;
    await db.deleteProduct(id);
    setProducts(prev => prev.filter(p => p.id !== id));
  };

  const exportCSV = (data) => {
    const headers = ["SKU", "النوع", "الاسم", "البراند", "سعر UAE (AED)", "شحن (EGP)", "تكلفة (EGP)", "سعر البيع (EGP)", "هامش %", "سعر نون مصر", "متاح", "تاريخ الإضافة", "أضافه", "آخر تحديث", "لينك UAE", "لينك مصر"];
    const rows = data.map(p => {
      const cost = p.uae_price > 0 ? calcCost(p.uae_price, aedRate, p.shipping || 0) : "";
      const sell = cost ? calcSelling(cost) : "";
      const mg = sell && cost ? calcMargin(sell, cost) : "";
      return [p.sku, p.sku_type, p.title, p.brand, p.uae_price, p.shipping, cost ? Math.round(cost) : "", sell ? Math.round(sell) : "", mg, p.noon_eg_price, p.is_available ? "نعم" : p.is_available === false ? "لأ" : "—", p.added_date, p.added_by, p.last_updated, p.uae_url, p.egypt_url];
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
    if (activeTab === "losers" && !(p.noon_eg_price != null && p.selling_price && parseFloat(p.noon_eg_price) < parseFloat(p.selling_price))) return false;
    if (activeTab === "changed" && !(p.prev_noon_eg_price != null && p.prev_noon_eg_price !== p.noon_eg_price)) return false;
    if (search && !(p.title?.toLowerCase().includes(search.toLowerCase()) || p.sku?.toLowerCase().includes(search.toLowerCase()))) return false;
    if (filterBrand && p.brand !== filterBrand) return false;
    if (filterDate && p.added_date !== filterDate) return false;
    if (filterStatus === "available" && !p.is_available) return false;
    if (filterStatus === "unavailable" && p.is_available !== false) return false;
    return true;
  });

  const tabCounts = {
    all: products.length,
    N: products.filter(p => p.sku_type === "N").length,
    Z: products.filter(p => p.sku_type === "Z").length,
    losers: products.filter(p => p.noon_eg_price != null && p.selling_price && parseFloat(p.noon_eg_price) < parseFloat(p.selling_price)).length,
    changed: products.filter(p => p.prev_noon_eg_price != null && p.prev_noon_eg_price !== p.noon_eg_price).length,
  };

  return (
    <div style={S.app} dir="rtl">
      <header style={S.header}>
        <div style={S.hLeft}>
          <div style={S.logo}>🛒</div>
          <div>
            <div style={S.logoText}>Noon Pricing Tool</div>
            <div style={S.logoSub}>أداة تسعير نون</div>
          </div>
          {userName && <div style={S.userPill}>👤 {userName}</div>}
        </div>
        <div style={S.hRight}>
          <div style={S.ratePill}>🇦🇪 1 د.إ = <strong>{aedRate}</strong> ج.م</div>
          <button onClick={loadData} style={S.hBtn} title="تحديث">🔄</button>
          <button onClick={() => setShowSettings(true)} style={S.hBtn}>⚙️ إعدادات</button>
        </div>
      </header>

      <div style={S.actions}>
        <button onClick={() => setShowScrapeUrl(true)} style={{ ...S.btnPrimary, background: "#7c3aed" }}>🔍 سكراب منتجات جديدة</button>
        <button onClick={() => setShowScrapeEgypt(true)} style={{ ...S.btnPrimary, background: "#059669" }}>🇪🇬 تحديث أسعار نون مصر</button>
        <button onClick={() => exportCSV(filtered)} style={S.btnGhost}>💾 تصدير CSV</button>
        {activeTab === "losers" && tabCounts.losers > 0 && (
          <button onClick={() => exportCSV(filtered)} style={{ ...S.btnGhost, borderColor: "#ef4444", color: "#ef4444" }}>🔴 تصدير الخاسرين</button>
        )}
        <button onClick={() => setShowDash(!showDash)} style={S.btnGhost}>{showDash ? "إخفاء الداشبورد 📊" : "إظهار الداشبورد 📊"}</button>
      </div>

      {showDash && <Dashboard products={products} />}

      <div style={S.filters}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث باسم أو SKU..." style={S.searchInput} />
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
        {[["all", `الكل (${tabCounts.all})`], ["N", `منتجات N (${tabCounts.N})`], ["Z", `منتجات Z (${tabCounts.Z})`], ["losers", `🔴 خاسرة (${tabCounts.losers})`], ["changed", `📉 تغير سعرها (${tabCounts.changed})`]].map(([id, lbl]) => (
          <button key={id} onClick={() => setActiveTab(id)} style={{ ...S.tab, ...(activeTab === id ? S.tabOn : {}) }}>{lbl}</button>
        ))}
      </div>

      <div style={S.tableWrap}>
        {loading ? (
          <div style={S.empty}>⏳ جاري تحميل البيانات...</div>
        ) : filtered.length === 0 ? (
          <div style={S.empty}>
            {products.length === 0
              ? <div>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🛒</div>
                  <div style={{ fontSize: 16, marginBottom: 8 }}>مفيش منتجات لسه</div>
                  <div style={{ fontSize: 13, color: "#9ca3af" }}>اضغط «🔍 سكراب منتجات جديدة» وحط لينك كاتيجوري نون للبدء</div>
                </div>
              : "🔍 مفيش نتائج للفلتر ده"}
          </div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {["صورة", "المنتج", "سعر UAE", "شحن", "تكلفة", "سعر البيع", "هامش", "نون مصر", "متاح", "إجراءات"].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <ProductRow key={p.id} p={p} aedRate={aedRate} onShipChange={handleShipChange} onDelete={handleDelete} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={S.footer}>
        عرض {filtered.length} من {products.length} منتج
        {filtered.length !== products.length && " · فلترة مفعلة"}
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} userName={userName} setUserName={setUserName} aedRate={aedRate} setAedRate={setAedRate} />}
      {showScrapeUrl && <ScrapeUrlModal onClose={() => setShowScrapeUrl(false)} onDone={loadData} userName={userName} />}
      {showScrapeEgypt && <ScrapeEgyptModal onClose={() => setShowScrapeEgypt(false)} products={products} onDone={loadData} userName={userName} />}
    </div>
  );
}

// ===================== STYLES =====================
const S = {
  app: { fontFamily: "'Segoe UI',Tahoma,Arial,sans-serif", minHeight: "100vh", background: "#f1f5f9", color: "#1e293b" },
  header: { background: "linear-gradient(135deg,#1e1b4b,#4338ca)", color: "#fff", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.25)" },
  hLeft: { display: "flex", alignItems: "center", gap: 12 },
  hRight: { display: "flex", alignItems: "center", gap: 10 },
  logo: { fontSize: 28 },
  logoText: { fontSize: 18, fontWeight: 800, letterSpacing: -0.5 },
  logoSub: { fontSize: 11, color: "rgba(255,255,255,0.6)" },
  userPill: { background: "rgba(255,255,255,0.15)", padding: "4px 12px", borderRadius: 20, fontSize: 12 },
  ratePill: { background: "rgba(255,255,255,0.1)", padding: "5px 12px", borderRadius: 8, fontSize: 13, border: "1px solid rgba(255,255,255,0.2)" },
  hBtn: { background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
  actions: { display: "flex", gap: 8, padding: "12px 20px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" },
  btnPrimary: { background: "#6366f1", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  btnGhost: { background: "#fff", color: "#374151", border: "1px solid #d1d5db", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13 },
  btnSm: { background: "#6366f1", color: "#fff", border: "none", padding: "6px 14px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  dashGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10, padding: "14px 20px" },
  dashCard: { background: "#fff", borderRadius: 10, padding: "14px 10px", textAlign: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" },
  filters: { display: "flex", gap: 8, padding: "10px 20px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap", alignItems: "center" },
  searchInput: { padding: "7px 12px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, minWidth: 200 },
  sel: { padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, background: "#fff", cursor: "pointer" },
  clearBtn: { padding: "7px 12px", background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12 },
  tabs: { display: "flex", background: "#fff", borderBottom: "2px solid #e2e8f0", padding: "0 20px", overflowX: "auto" },
  tab: { padding: "10px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: "#64748b", borderBottom: "2px solid transparent", marginBottom: -2, whiteSpace: "nowrap" },
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
  iconBtn: { background: "none", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", padding: "4px 6px", fontSize: 13, textDecoration: "none", display: "inline-block" },
  empty: { textAlign: "center", padding: "60px 20px", color: "#9ca3af", fontSize: 15 },
  footer: { textAlign: "center", padding: "10px", color: "#94a3b8", fontSize: 12, background: "#fff", borderTop: "1px solid #e2e8f0" },
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
