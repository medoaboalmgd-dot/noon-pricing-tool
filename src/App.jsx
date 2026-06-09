import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const SUPABASE_URL = "https://fbwmqfhivwfytgokxseb.supabase.co";
const SUPABASE_KEY = "sb_publishable_BovODSPXtoim6Z4IgsBenQ_BmziU8EQ";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PYTHON_API = "http://95.217.133.28:5000";
const TASK_ID = "glossy_bookcases~amazon-ae-task";

// ============ SHIPPING TIERS ============
const SHIPPING_TIERS = [
  { keywords: ["earbuds","ar glasses","airpods","buds","wearable"], shipping: 600 },
  { keywords: ["action camera","vr headset","quest","meta quest","ar glass"], shipping: 800 },
  { keywords: ["projector","headset","webcam","smart lock","streaming","pico"], shipping: 1000 },
  { keywords: ["portable projector","ipl","nanoleaf","panel"], shipping: 1200 },
  { keywords: ["dyson airwrap","hair styler","hair dryer","rode","ev cable","charger cable"], shipping: 1500 },
  { keywords: ["dyson 360","security camera kit","underwater scooter"], shipping: 2000 },
  { keywords: ["robot vacuum","bidet","robotic vacuum"], shipping: 2400 },
  { keywords: ["ice cream","cooler","vacuum sealer"], shipping: 3000 },
  { keywords: ["coffee machine","de'longhi magnifica","philips coffee","krups","beko coffee"], shipping: 3600 },
  { keywords: ["melitta","siemens eq","de'longhi eletta","dinamica"], shipping: 4000 },
  { keywords: ["primadonna"], shipping: 4500 },
  { keywords: ["dyson v","shark cordless","dreame r","cordless vacuum","stick vacuum"], shipping: 5000 },
  { keywords: ["roborock","dreame","ecovacs","narwal","shark robot","xiaomi robot","robot with dock","with station","with base"], shipping: 6000 },
  { keywords: ["saros z70"], shipping: 7000 },
  { keywords: ["gas hob","built-in","large appliance"], shipping: 10000 },
];

function guessShipping(title) {
  if (!title) return 1000;
  const lower = title.toLowerCase();
  for (const tier of SHIPPING_TIERS) {
    if (tier.keywords.some(k => lower.includes(k))) return tier.shipping;
  }
  return 1000;
}

// ============ HELPERS ============
function parseDeliveryDays(deliveryStr) {
  if (!deliveryStr) return 3;
  const lower = deliveryStr.toLowerCase();
  if (lower.includes("today")) return 1;
  if (lower.includes("tomorrow")) return 2;
  try {
    if (deliveryStr.includes(" - ")) {
      const parts = deliveryStr.split(" - ")[0].trim();
      const parsed = new Date(parts + ` ${new Date().getFullYear()}`);
      const diff = Math.round((parsed - new Date().setHours(0,0,0,0)) / 86400000);
      return diff > 0 ? diff : 3;
    }
    const parts = deliveryStr.split(", ").pop().trim();
    const parsed = new Date(parts + ` ${new Date().getFullYear()}`);
    const diff = Math.round((parsed - new Date().setHours(0,0,0,0)) / 86400000);
    return diff > 0 ? diff : 3;
  } catch { return 3; }
}

function roundPrice(price) {
  const base = Math.floor(price / 100) * 100;
  const candidates = [base - 51, base - 1, base + 49, base + 99, base + 149];
  return candidates.reduce((a, b) => Math.abs(a - price) <= Math.abs(b - price) ? a : b);
}

function calcPrices(aedPrice, exchangeRate, shipping, handlingDays) {
  const cost = parseFloat(aedPrice) * parseFloat(exchangeRate) + parseFloat(shipping);
  return {
    price: roundPrice(cost * 1.6),
    maxPrice: roundPrice(cost * 1.6),
    minPrice: roundPrice(cost * 1.4),
    handling: 13 + (handlingDays || 3),
  };
}

async function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        const products = [];
        for (const row of rows) {
          const asin = String(row[0] || "").trim().toUpperCase();
          if (!/^B[A-Z0-9]{9}$/.test(asin)) continue;
          const rawShipping = row[1];
          const shipping = typeof rawShipping === "number" ? rawShipping : parseFloat(String(rawShipping || "0")) || 0;
          products.push({ asin, shipping });
        }
        resolve(products);
      } catch(e) { reject(e); }
    };
    reader.readAsArrayBuffer(file);
  });
}

function downloadTSV(content, filename) {
  const blob = new Blob(["\ufeff" + content], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ============ APIFY ============
async function fetchApifyData(asins, token, onProgress) {
  onProgress("بيشغّل الـ Scraper...");
  const runRes = await fetch(
    `https://api.apify.com/v2/actor-tasks/${TASK_ID}/runs?token=${token}`,
    { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ asins, amazon_domain: "www.amazon.ae", max_pages: 10 }) }
  );
  if (!runRes.ok) throw new Error("فشل تشغيل Apify: " + runRes.status);
  const run = await runRes.json();
  const runId = run.data?.id;
  if (!runId) throw new Error("مش لاقي Run ID");

  let status = "RUNNING", tries = 0;
  while (["RUNNING","READY"].includes(status) && tries < 60) {
    await new Promise(r => setTimeout(r, 5000)); tries++;
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    status = (await s.json()).data?.status;
    onProgress(`جاري السحب... (${tries * 5}s)`);
  }
  if (status !== "SUCCEEDED") throw new Error("Apify انتهى بـ: " + status);

  const dataRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&limit=2000`
  );
  return await dataRes.json();
}

const TABS = ["🗄️ الداتا بيس", "🚀 تسعير", "📄 تمبلت", "⚙️ إعدادات"];

export default function App() {
  const [tab, setTab] = useState(0);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState(null);
  const [editShipping, setEditShipping] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [selectedToken, setSelectedToken] = useState("");
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenValue, setNewTokenValue] = useState("");
  const [exchangeRate, setExchangeRate] = useState("");
  const [handlingDays, setHandlingDays] = useState("13");
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingMsg, setPricingMsg] = useState("");
  const [results, setResults] = useState([]);
  const [runHistory, setRunHistory] = useState([]);
  const [templateFile, setTemplateFile] = useState(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const fileRef = useRef();
  const templateRef = useRef();

  async function loadProducts() {
    setLoading(true);
    let all = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase.from("products").select("*")
        .order("created_at", { ascending: false }).range(from, from + 999);
      if (error || !data || data.length === 0) break;
      all = [...all, ...data];
      if (data.length < 1000) break;
      from += 1000;
    }
    setProducts(all);
    setLoading(false);
  }

  async function loadTokens() {
    const { data } = await supabase.from("tokens").select("*").order("created_at");
    if (data && data.length > 0) {
      setTokens(data);
      if (!selectedToken) setSelectedToken(data[0].token);
    }
  }

  useEffect(() => { loadProducts(); loadTokens(); }, []);

  function showMsg(text, type = "success") {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 4000);
  }

  // ---- Bulk upload ----
  async function handleFileUpload(e) {
    const file = e.target.files[0]; if (!file) return;
    const isExcel = file.name.endsWith(".xlsx") || file.name.endsWith(".xls");
    if (isExcel) {
      try {
        const prods = await parseExcel(file);
        if (prods.length === 0) { showMsg("مفيش داتا صح", "error"); return; }
        setBulkText(prods.map(p => `${p.asin},${p.shipping}`).join("\n"));
        showMsg(`✅ تم قراءة ${prods.length} منتج`);
      } catch(e2) { showMsg("خطأ: " + e2.message, "error"); }
    } else {
      const reader = new FileReader();
      reader.onload = ev => setBulkText(ev.target.result);
      reader.readAsText(file);
    }
  }

  async function handleBulkUpload() {
    const lines = bulkText.trim().split(/\r?\n/);
    const parsed = lines.map(l => {
      const parts = l.split(/[,\t]/);
      const asin = (parts[0] || "").trim().toUpperCase();
      const shipping = typeof parts[1] === "number" ? parts[1] : parseFloat((parts[1] || "0").trim()) || 0;
      return { asin, shipping };
    }).filter(p => /^B[A-Z0-9]{9}$/.test(p.asin));

    if (parsed.length === 0) { showMsg("مفيش داتا صح", "error"); return; }
    const unique = Object.values(parsed.reduce((acc, p) => { acc[p.asin] = p; return acc; }, {}));
    setBulkLoading(true);

    const batchSize = 200;
    let hasError = false;
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      const { error } = await supabase.from("products").upsert(
        batch.map(p => ({ asin: p.asin, shipping: p.shipping })),
        { onConflict: "asin" }
      );
      if (error) { showMsg("خطأ: " + error.message, "error"); hasError = true; break; }
    }
    if (!hasError) { showMsg(`✅ اتضافوا ${unique.length} منتج`); setBulkText(""); await loadProducts(); }
    setBulkLoading(false);
  }

  // ---- Edit shipping ----
  async function handleSaveShipping(id) {
    const val = parseFloat(editShipping);
    if (isNaN(val)) return;
    await supabase.from("products").update({ shipping: val }).eq("id", id);
    showMsg("✅ اتحفظ"); setEditId(null); await loadProducts();
  }

  // ---- Delete ----
  async function handleDelete(id) {
    if (!window.confirm("متأكد؟")) return;
    await supabase.from("products").delete().eq("id", id);
    await loadProducts();
    setSelected(s => { const n = new Set(s); n.delete(id); return n; });
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) { showMsg("اختار منتجات الأول", "error"); return; }
    if (!window.confirm(`متأكد إنك عايز تمسح ${selected.size} منتج؟`)) return;
    for (const id of [...selected]) await supabase.from("products").delete().eq("id", id);
    setSelected(new Set()); await loadProducts();
    showMsg(`✅ اتمسحوا ${selected.size} منتج`);
  }

  async function handleDeleteAll() {
    if (!window.confirm(`متأكد إنك عايز تمسح كل المنتجات (${products.length})؟`)) return;
    await supabase.from("products").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    setSelected(new Set()); await loadProducts();
    showMsg("✅ اتمسح كل المنتجات");
  }

  // ---- Select ----
  function toggleSelect(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function selectAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(p => p.id)));
  }

  // ---- Pricing ----
  async function handleRunPricing() {
    if (!exchangeRate) { showMsg("ادخل سعر الصرف", "error"); return; }
    if (!selectedToken) { showMsg("اختار Token", "error"); return; }
    if (selected.size === 0) { showMsg("اختار منتجات الأول", "error"); return; }

    setPricingLoading(true); setResults([]);
    const selectedProducts = products.filter(p => selected.has(p.id));
    const asinsToFetch = [];
    const cachedResults = {};
    const now = new Date();

    // Check cache
    for (const p of selectedProducts) {
      const { data } = await supabase.from("price_cache").select("*").eq("asin", p.asin).single();
      if (data && data.fetched_at) {
        const age = (now - new Date(data.fetched_at)) / 3600000;
        if (age < 48) { cachedResults[p.asin] = data; continue; }
      }
      asinsToFetch.push(p.asin);
    }

    let fromCache = Object.keys(cachedResults).length;
    let fromApify = 0;
    let autoShipping = 0;

    try {
      let rawData = [];
      if (asinsToFetch.length > 0) {
        rawData = await fetchApifyData(asinsToFetch, selectedToken, setPricingMsg);
        // Save to cache
        for (const item of rawData) {
          if (item.availability && item.price) {
            await supabase.from("price_cache").upsert({
              asin: item.asin,
              aed_price: parseFloat(item.price),
              delivery: item.delivery || "",
              fetched_at: new Date().toISOString(),
            }, { onConflict: "asin" });
          }
        }
        fromApify = rawData.filter(i => i.availability && i.price).length;
      }

      setPricingMsg("بيحسب الأسعار...");

      // Combine cache + fresh
      const allData = {};
      for (const [asin, cached] of Object.entries(cachedResults)) {
        allData[asin] = { asin, price: cached.aed_price, delivery: cached.delivery, fromCache: true };
      }
      for (const item of rawData) {
        if (item.availability && item.price) allData[item.asin] = { ...item, fromCache: false };
      }

      const enriched = [];
      for (const p of selectedProducts) {
        const item = allData[p.asin];
        if (!item) continue;

        let shipping = parseFloat(p.shipping) || 0;
        let usedAutoShipping = false;
        if (!shipping || shipping === 0) {
          shipping = guessShipping(item.title || "");
          usedAutoShipping = true;
          autoShipping++;
          // Save guessed shipping to DB
          await supabase.from("products").update({ shipping }).eq("id", p.id);
        }

        const { price, maxPrice, minPrice, handling } = calcPrices(item.price, exchangeRate, shipping, parseDeliveryDays(item.delivery));
        const finalHandling = parseInt(handlingDays) + parseDeliveryDays(item.delivery);

        enriched.push({
          id: p.id, asin: p.asin,
          title: item.title || "",
          aedPrice: parseFloat(item.price),
          handlingTime: finalHandling,
          shipping, usedAutoShipping,
          price, maxPrice, minPrice,
          fromCache: item.fromCache,
        });

        // Update last prices
        await supabase.from("products").update({
          last_aed_price: parseFloat(item.price),
          last_egp_price: price,
          last_updated: new Date().toISOString(),
        }).eq("id", p.id);
      }

      // Save run history
      const historyEntry = {
        date: new Date().toLocaleString("ar-EG"),
        total: enriched.length,
        fromCache,
        fromApify,
        autoShipping,
        exchangeRate,
      };
      setRunHistory(h => [historyEntry, ...h.slice(0, 9)]);
      setResults(enriched);
      await loadProducts();
      showMsg(`✅ تم معالجة ${enriched.length} منتج — ${fromCache} من الـ Cache، ${fromApify} من Apify`);

    } catch (e) {
      showMsg("خطأ: " + e.message, "error");
    } finally {
      setPricingLoading(false); setPricingMsg("");
    }
  }

  function handleDownload() {
    const batchSize = 500;
    const batches = Math.ceil(results.length / batchSize);
    const headers = [
      "::your_search_term","::recommended_action","::amazon_title","::record_action",
      "contribution_sku#1.value","merchant_suggested_asin#1.value","condition_type#1.value",
      "fulfillment_availability#1.fulfillment_channel_code","fulfillment_availability#1.quantity",
      "fulfillment_availability#1.lead_time_to_ship_max_days",
      "purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.our_price#1.schedule#1.value_with_tax",
      "purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.automated_pricing_merchandising_rule_plan#1.merchandising_rule.rule_id",
      "purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.minimum_seller_allowed_price#1.schedule#1.value_with_tax",
      "purchasable_offer[marketplace_id=ARBP9OOSHTCHU][audience=ALL]#1.maximum_seller_allowed_price#1.schedule#1.value_with_tax",
      "supplier_declared_dg_hz_regulation#1.value","supplier_declared_dg_hz_regulation#2.value",
      "supplier_declared_dg_hz_regulation#3.value","supplier_declared_dg_hz_regulation#4.value",
      "supplier_declared_dg_hz_regulation#5.value",
    ].join("\t");

    for (let i = 0; i < batches; i++) {
      const batch = results.slice(i * batchSize, (i + 1) * batchSize);
      const rows = batch.map(p => [
        p.asin,"Ready to List",p.title,"Add Product",
        p.asin,p.asin,"New","DEFAULT","1",p.handlingTime,
        p.price,"Low 1 pound",p.minPrice,p.maxPrice,
        "Not Applicable","Not Applicable","Not Applicable","Not Applicable","Not Applicable",
      ].join("\t"));
      setTimeout(() => downloadTSV([headers, ...rows].join("\n"), `amazon-batch-${i+1}-of-${batches}.txt`), i * 300);
    }
  }

  // ---- Token management ----
  async function handleAddToken() {
    if (!newTokenName || !newTokenValue) { showMsg("ادخل اسم وقيمة التوكن", "error"); return; }
    const { error } = await supabase.from("tokens").insert({ name: newTokenName, token: newTokenValue });
    if (error) { showMsg("خطأ: " + error.message, "error"); return; }
    showMsg("✅ اتضاف التوكن");
    setNewTokenName(""); setNewTokenValue("");
    await loadTokens();
  }

  async function handleDeleteToken(id) {
    if (!window.confirm("متأكد؟")) return;
    await supabase.from("tokens").delete().eq("id", id);
    await loadTokens();
  }

  const filtered = products.filter(p =>
    p.asin.includes(search.toUpperCase()) ||
    (p.name || "").toLowerCase().includes(search.toLowerCase())
  );

  // ============ RENDER ============
  return (
    <div style={S.root}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.logo}><span>⚡</span><span style={S.logoText}>Amazon Repricer</span></div>
        <div style={S.tabs}>
          {TABS.map((t, i) => (
            <button key={i} style={{ ...S.tab, ...(tab === i ? S.tabActive : {}) }} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>
      </div>

      {msg && <div style={{ ...S.toast, background: msg.type === "error" ? "#7f1d1d" : "#14532d" }}>{msg.text}</div>}

      <div style={S.body}>

        {/* ===== TAB 1: DATABASE ===== */}
        {tab === 0 && (
          <div>
            <div style={S.card}>
              <h3 style={S.cardTitle}>إضافة منتجات Bulk</h3>
              <p style={S.sub}>فورمات: <code style={S.code}>ASIN, سعر الشحن</code> — أو ارفع Excel</p>
              <textarea style={S.textarea} rows={5}
                placeholder={"B09RMVC2Z1, 800\nB093W4NZRJ, 1200"}
                value={bulkText} onChange={e => setBulkText(e.target.value)} />
              <div style={S.row}>
                <button style={S.btnSecondary} onClick={() => fileRef.current.click()}>📂 ارفع Excel</button>
                <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx,.xls" style={{display:"none"}} onChange={handleFileUpload} />
                <button style={S.btnPrimary} onClick={handleBulkUpload} disabled={bulkLoading}>
                  {bulkLoading ? "جاري..." : "➕ أضف للداتا بيس"}
                </button>
              </div>
            </div>

            <div style={S.card}>
              <div style={S.tableHeader}>
                <div>
                  <h3 style={S.cardTitle}>المنتجات ({products.length})</h3>
                </div>
                <div style={S.row}>
                  <input style={S.searchInput} placeholder="🔍 ابحث..." value={search} onChange={e => setSearch(e.target.value)} />
                  {selected.size > 0 && (
                    <button style={S.btnDanger} onClick={handleDeleteSelected}>🗑️ مسح المحدد ({selected.size})</button>
                  )}
                  <button style={S.btnDangerOutline} onClick={handleDeleteAll}>🗑️ مسح الكل</button>
                </div>
              </div>
              {selected.size > 0 && (
                <div style={{ ...S.infoBadge, marginBottom: 12 }}>
                  {selected.size} محدد →
                  <button style={S.linkBtn} onClick={() => setTab(1)}>اذهب للتسعير ←</button>
                </div>
              )}

              {loading ? <div style={S.center}>جاري التحميل...</div> : (
                <div style={S.tableWrap}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        <th style={S.th}><input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={selectAll} /></th>
                        <th style={S.th}>ASIN</th>
                        <th style={S.th}>الشحن (ج)</th>
                        <th style={S.th}>آخر سعر AED</th>
                        <th style={S.th}>آخر سعر EGP</th>
                        <th style={S.th}>آخر تحديث</th>
                        <th style={S.th}>حذف</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((p, i) => (
                        <tr key={p.id} style={{ background: i % 2 === 0 ? "#0a0f1a" : "#0d1525" }}>
                          <td style={S.td}><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} /></td>
                          <td style={S.td}><code style={S.code}>{p.asin}</code></td>
                          <td style={S.td}>
                            {editId === p.id ? (
                              <div style={S.row}>
                                <input style={{ ...S.input, width:70, padding:"4px 8px" }} value={editShipping} onChange={e => setEditShipping(e.target.value)} autoFocus />
                                <button style={S.saveBtn} onClick={() => handleSaveShipping(p.id)}>✓</button>
                                <button style={S.cancelBtn} onClick={() => setEditId(null)}>✗</button>
                              </div>
                            ) : (
                              <span style={{ cursor:"pointer", color:"#f59e0b" }} onClick={() => { setEditId(p.id); setEditShipping(String(p.shipping)); }}>
                                {p.shipping} ✏️
                              </span>
                            )}
                          </td>
                          <td style={{ ...S.td, color:"#94a3b8" }}>{p.last_aed_price ? p.last_aed_price + " AED" : "—"}</td>
                          <td style={{ ...S.td, color:"#34d399" }}>{p.last_egp_price ? p.last_egp_price + " ج" : "—"}</td>
                          <td style={{ ...S.td, fontSize:11, color:"#475569" }}>
                            {p.last_updated ? new Date(p.last_updated).toLocaleDateString("ar-EG") : "—"}
                          </td>
                          <td style={S.td}><button style={S.deleteBtn} onClick={() => handleDelete(p.id)}>🗑️</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length === 0 && <div style={S.center}>مفيش منتجات</div>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===== TAB 2: PRICING ===== */}
        {tab === 1 && (
          <div>
            <div style={S.card}>
              <h3 style={S.cardTitle}>إعدادات التسعير</h3>

              {selected.size === 0 ? (
                <div style={S.warning}>⚠️ مفيش منتجات محددة — <button style={S.linkBtn} onClick={() => setTab(0)}>روح الداتا بيس</button> واختار</div>
              ) : (
                <div style={S.infoBadge}>✅ {selected.size} منتج محدد</div>
              )}

              <div style={S.grid3}>
                <div style={S.field}>
                  <label style={S.label}>سعر الصرف (ج/درهم)</label>
                  <input style={S.input} type="number" step="0.01" placeholder="مثال: 13.5" value={exchangeRate} onChange={e => setExchangeRate(e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>عدد أيام الشحن الثابتة</label>
                  <input style={S.input} type="number" placeholder="مثال: 13" value={handlingDays} onChange={e => setHandlingDays(e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Apify Token</label>
                  <select style={S.input} value={selectedToken} onChange={e => setSelectedToken(e.target.value)}>
                    {tokens.length === 0 && <option value="">مفيش tokens — أضف من الإعدادات</option>}
                    {tokens.map(t => <option key={t.id} value={t.token}>{t.name}</option>)}
                  </select>
                </div>
              </div>

              {exchangeRate && (
                <div style={S.formulaBox}>
                  <span style={S.fLabel}>السعر:</span>
                  <span style={S.fEq}>(AED × {exchangeRate} + شحن) × 1.6</span>
                  <span style={{margin:"0 12px", color:"#475569"}}>|</span>
                  <span style={S.fLabel}>الأدنى:</span>
                  <span style={{...S.fEq, color:"#f87171"}}>× 1.4</span>
                  <span style={{margin:"0 12px", color:"#475569"}}>|</span>
                  <span style={S.fLabel}>Handling:</span>
                  <span style={{...S.fEq, color:"#818cf8"}}>{handlingDays} + أيام التوصيل</span>
                </div>
              )}

              <button style={{...S.btnPrimary, opacity: pricingLoading ? 0.7 : 1, marginTop:16}}
                onClick={handleRunPricing} disabled={pricingLoading || selected.size === 0}>
                {pricingLoading ? "⏳ " + pricingMsg : "🚀 شغّل"}
              </button>
            </div>

            {results.length > 0 && (
              <div style={S.card}>
                <div style={S.tableHeader}>
                  <div>
                    <h3 style={S.cardTitle}>النتائج ✅ ({results.length} منتج)</h3>
                    <p style={S.sub}>{Math.ceil(results.length/500)} batch للتحميل</p>
                  </div>
                  <button style={S.btnPrimary} onClick={handleDownload}>⬇️ تحميل Templates ({Math.ceil(results.length/500)})</button>
                </div>

                <div style={S.stats}>
                  {[
                    { label:"إجمالي", val: results.length, color:"#f59e0b" },
                    { label:"من الـ Cache", val: results.filter(r=>r.fromCache).length, color:"#818cf8" },
                    { label:"من Apify", val: results.filter(r=>!r.fromCache).length, color:"#34d399" },
                    { label:"شحن أوتوماتيك", val: results.filter(r=>r.usedAutoShipping).length, color:"#f87171" },
                  ].map((s,i) => (
                    <div key={i} style={S.statBox}>
                      <div style={{fontSize:20, fontWeight:800, color:s.color}}>{s.val}</div>
                      <div style={{fontSize:11, color:"#64748b", marginTop:4}}>{s.label}</div>
                    </div>
                  ))}
                </div>

                <div style={S.tableWrap}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        {["ASIN","AED","Handling","سعر البيع","الأدنى","Cache","شحن أوتو"].map(h => <th key={h} style={S.th}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {results.slice(0,100).map((p,i) => (
                        <tr key={i} style={{background: i%2===0 ? "#0a0f1a" : "#0d1525"}}>
                          <td style={S.td}><code style={S.code}>{p.asin}</code></td>
                          <td style={S.td}>{p.aedPrice}</td>
                          <td style={{...S.td, color:"#818cf8"}}>{p.handlingTime}d</td>
                          <td style={{...S.td, color:"#f59e0b", fontWeight:700}}>{p.price} ج</td>
                          <td style={{...S.td, color:"#f87171"}}>{p.minPrice} ج</td>
                          <td style={S.td}>{p.fromCache ? "✅" : "—"}</td>
                          <td style={S.td}>{p.usedAutoShipping ? "✅" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {runHistory.length > 0 && (
              <div style={S.card}>
                <h3 style={S.cardTitle}>سجل الـ Runs</h3>
                <div style={S.tableWrap}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        {["التاريخ","إجمالي","من Cache","من Apify","شحن أوتو","سعر الصرف"].map(h => <th key={h} style={S.th}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {runHistory.map((r,i) => (
                        <tr key={i} style={{background: i%2===0 ? "#0a0f1a" : "#0d1525"}}>
                          <td style={{...S.td, fontSize:11}}>{r.date}</td>
                          <td style={{...S.td, color:"#f59e0b"}}>{r.total}</td>
                          <td style={{...S.td, color:"#818cf8"}}>{r.fromCache}</td>
                          <td style={{...S.td, color:"#34d399"}}>{r.fromApify}</td>
                          <td style={{...S.td, color:"#f87171"}}>{r.autoShipping}</td>
                          <td style={S.td}>{r.exchangeRate}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== TAB 3: TEMPLATE ===== */}
        {tab === 2 && (
          <div style={S.card}>
            <h3 style={S.cardTitle}>ملء التمبلت</h3>
            <p style={S.sub}>ارفع التمبلت من Seller Central وهنملّيها بالأسعار</p>

            <div style={S.uploadArea} onClick={() => templateRef.current.click()}>
              <div style={{fontSize:40, marginBottom:8}}>📄</div>
              <div style={{fontSize:14, color:"#94a3b8"}}>اضغط أو اسحب التمبلت هنا</div>
              <div style={{fontSize:12, color:"#475569", marginTop:4}}>ملف .xlsm من Seller Central</div>
            </div>
            <input ref={templateRef} type="file" accept=".xlsm,.xlsx" style={{display:"none"}}
              onChange={e => { setTemplateFile(e.target.files[0]); showMsg(`✅ ${e.target.files[0].name}`); }} />

            {templateFile && <div style={S.infoBadge}>📄 {templateFile.name}</div>}

            <div style={S.grid2}>
              <div style={S.field}>
                <label style={S.label}>سعر الصرف (ج/درهم)</label>
                <input style={S.input} type="number" step="0.01" placeholder="مثال: 13.5" value={exchangeRate} onChange={e => setExchangeRate(e.target.value)} />
              </div>
              <div style={S.field}>
                <label style={S.label}>Apify Token</label>
                <select style={S.input} value={selectedToken} onChange={e => setSelectedToken(e.target.value)}>
                  {tokens.length === 0 && <option value="">مفيش tokens</option>}
                  {tokens.map(t => <option key={t.id} value={t.token}>{t.name}</option>)}
                </select>
              </div>
            </div>

            <button style={{...S.btnPrimary, opacity: templateLoading ? 0.7 : 1, marginTop:8}}
              disabled={templateLoading || !templateFile}
              onClick={async () => {
                if (!exchangeRate) { showMsg("ادخل سعر الصرف", "error"); return; }
                if (!selectedToken) { showMsg("اختار Token", "error"); return; }
                setTemplateLoading(true);
                try {
                  const formData = new FormData();
                  formData.append("file", templateFile);
                  formData.append("exchange_rate", exchangeRate);
                  formData.append("apify_token", selectedToken);
                  formData.append("handling_days", handlingDays);
                  const res = await fetch(`${PYTHON_API}/process`, { method:"POST", body: formData });
                  if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
                  const filled = res.headers.get("X-Filled-Count") || "?";
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a"); a.href = url;
                  a.download = templateFile.name.replace(".xlsm","_filled.xlsm");
                  a.click();
                  showMsg(`✅ تم ملء ${filled} منتج`);
                } catch(e) { showMsg("خطأ: " + e.message, "error"); }
                finally { setTemplateLoading(false); }
              }}>
              {templateLoading ? "⏳ جاري المعالجة..." : "🚀 شغّل واملأ التمبلت"}
            </button>

            <div style={{...S.card, marginTop:20, background:"#020617"}}>
              <h4 style={{color:"#cbd5e1", margin:"0 0 12px", fontSize:14}}>خطوات الرفع:</h4>
              {["نزّل التمبلت من Seller Central → Catalog → Add Products via Upload",
                "ارفعها هنا واضغط شغّل",
                "حمّل التمبلت المعبّاة",
                "ارفعها على Seller Central — خلّص! 🎉"
              ].map((t,i) => (
                <div key={i} style={S.instRow}>
                  <div style={S.instNum}>{i+1}</div>
                  <div style={{fontSize:13, color:"#94a3b8", paddingTop:3}}>{t}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===== TAB 4: SETTINGS ===== */}
        {tab === 3 && (
          <div>
            <div style={S.card}>
              <h3 style={S.cardTitle}>إدارة Apify Tokens</h3>
              <p style={S.sub}>أضف tokens متعددة واختار منهم عند التشغيل</p>

              <div style={S.grid2}>
                <div style={S.field}>
                  <label style={S.label}>اسم التوكن</label>
                  <input style={S.input} placeholder="مثال: Token الرئيسي" value={newTokenName} onChange={e => setNewTokenName(e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>قيمة التوكن</label>
                  <input style={S.input} type="password" placeholder="apify_api_..." value={newTokenValue} onChange={e => setNewTokenValue(e.target.value)} />
                </div>
              </div>
              <button style={S.btnPrimary} onClick={handleAddToken}>➕ أضف Token</button>

              {tokens.length > 0 && (
                <div style={{marginTop:20}}>
                  <h4 style={{color:"#94a3b8", fontSize:13, marginBottom:10}}>التوكنز المحفوظة:</h4>
                  {tokens.map(t => (
                    <div key={t.id} style={S.tokenRow}>
                      <span style={{color:"#f59e0b", fontWeight:700}}>{t.name}</span>
                      <span style={{color:"#475569", fontSize:12, fontFamily:"monospace"}}>
                        {t.token.slice(0,20)}...
                      </span>
                      <button style={S.deleteBtn} onClick={() => handleDeleteToken(t.id)}>🗑️</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={S.card}>
              <h3 style={S.cardTitle}>معلومات</h3>
              <div style={{display:"flex", flexDirection:"column", gap:8}}>
                {[
                  { label:"الداتا بيس", val: `${products.length} منتج`, color:"#34d399" },
                  { label:"التوكنز", val: `${tokens.length} token`, color:"#818cf8" },
                  { label:"Cache الأسعار", val: "48 ساعة", color:"#f59e0b" },
                  { label:"Python API", val: PYTHON_API, color:"#94a3b8" },
                ].map((item,i) => (
                  <div key={i} style={{display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #1e293b"}}>
                    <span style={{fontSize:13, color:"#64748b"}}>{item.label}</span>
                    <span style={{fontSize:13, color:item.color, fontWeight:600}}>{item.val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  root: { minHeight:"100vh", background:"#020617", color:"#e2e8f0", fontFamily:"'Cairo','Segoe UI',sans-serif", direction:"rtl", paddingBottom:40 },
  header: { background:"#0a0f1a", borderBottom:"1px solid #1e293b", padding:"14px 24px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12 },
  logo: { display:"flex", alignItems:"center", gap:10, fontSize:22 },
  logoText: { fontSize:20, fontWeight:800, color:"#f59e0b" },
  tabs: { display:"flex", gap:6, flexWrap:"wrap" },
  tab: { background:"transparent", border:"1px solid #1e293b", borderRadius:8, padding:"7px 14px", color:"#64748b", cursor:"pointer", fontSize:12, fontWeight:600, fontFamily:"'Cairo','Segoe UI',sans-serif" },
  tabActive: { background:"#1e293b", color:"#f59e0b", borderColor:"#f59e0b" },
  toast: { position:"fixed", top:20, left:"50%", transform:"translateX(-50%)", padding:"10px 24px", borderRadius:10, fontSize:14, fontWeight:600, zIndex:999, color:"#fff" },
  body: { maxWidth:1000, margin:"24px auto", padding:"0 16px" },
  card: { background:"#0a0f1a", border:"1px solid #1e293b", borderRadius:16, padding:"24px", marginBottom:20 },
  cardTitle: { fontSize:16, fontWeight:800, color:"#f1f5f9", margin:"0 0 8px" },
  sub: { fontSize:12, color:"#64748b", margin:"0 0 14px" },
  textarea: { width:"100%", background:"#020617", border:"1px solid #1e293b", borderRadius:8, padding:"10px 12px", color:"#e2e8f0", fontSize:13, fontFamily:"monospace", resize:"vertical", outline:"none", boxSizing:"border-box" },
  row: { display:"flex", gap:8, alignItems:"center", marginTop:10, flexWrap:"wrap" },
  infoBadge: { background:"#052e16", border:"1px solid #166534", borderRadius:8, padding:"8px 14px", fontSize:13, color:"#4ade80", marginBottom:12 },
  warning: { background:"#431407", border:"1px solid #9a3412", borderRadius:8, padding:"10px 14px", fontSize:13, color:"#fdba74", marginBottom:16 },
  linkBtn: { background:"none", border:"none", color:"#f59e0b", cursor:"pointer", fontSize:13, fontWeight:700, textDecoration:"underline", fontFamily:"'Cairo','Segoe UI',sans-serif" },
  btnPrimary: { background:"#f59e0b", color:"#000", border:"none", borderRadius:10, padding:"10px 22px", fontWeight:800, fontSize:13, cursor:"pointer", fontFamily:"'Cairo','Segoe UI',sans-serif" },
  btnSecondary: { background:"#1e293b", color:"#cbd5e1", border:"1px solid #334155", borderRadius:10, padding:"10px 16px", fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"'Cairo','Segoe UI',sans-serif" },
  btnDanger: { background:"#7f1d1d", color:"#fca5a5", border:"1px solid #b91c1c", borderRadius:8, padding:"7px 14px", fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"'Cairo','Segoe UI',sans-serif" },
  btnDangerOutline: { background:"transparent", color:"#f87171", border:"1px solid #7f1d1d", borderRadius:8, padding:"7px 14px", fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"'Cairo','Segoe UI',sans-serif" },
  searchInput: { background:"#020617", border:"1px solid #1e293b", borderRadius:8, padding:"8px 12px", color:"#e2e8f0", fontSize:13, outline:"none", width:200 },
  input: { background:"#020617", border:"1px solid #1e293b", borderRadius:8, padding:"9px 12px", color:"#e2e8f0", fontSize:14, outline:"none", width:"100%", fontFamily:"'Cairo','Segoe UI',sans-serif" },
  saveBtn: { background:"#166534", color:"#fff", border:"none", borderRadius:6, padding:"3px 8px", cursor:"pointer", fontSize:13 },
  cancelBtn: { background:"#7f1d1d", color:"#fff", border:"none", borderRadius:6, padding:"3px 8px", cursor:"pointer", fontSize:13 },
  deleteBtn: { background:"none", border:"none", cursor:"pointer", fontSize:16 },
  tableHeader: { display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:16 },
  tableWrap: { overflowX:"auto", borderRadius:10, border:"1px solid #1e293b" },
  table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th: { background:"#1e293b", padding:"9px 12px", textAlign:"right", fontWeight:700, color:"#94a3b8", borderBottom:"1px solid #334155", whiteSpace:"nowrap" },
  td: { padding:"8px 12px", color:"#cbd5e1", borderBottom:"1px solid #0a0f1a" },
  code: { background:"#1e293b", borderRadius:4, padding:"2px 6px", fontFamily:"monospace", fontSize:11 },
  center: { textAlign:"center", padding:"20px", color:"#475569", fontSize:13 },
  grid2: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 },
  grid3: { display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:16, marginBottom:16 },
  field: { display:"flex", flexDirection:"column", gap:6 },
  label: { fontSize:12, fontWeight:600, color:"#94a3b8" },
  formulaBox: { background:"#0f172a", border:"1px solid #1e293b", borderRadius:8, padding:"10px 14px", display:"flex", flexWrap:"wrap", gap:8, alignItems:"center" },
  fLabel: { fontSize:12, color:"#64748b", fontWeight:600 },
  fEq: { fontSize:12, color:"#f59e0b", fontFamily:"monospace" },
  stats: { display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:16 },
  statBox: { background:"#020617", border:"1px solid #1e293b", borderRadius:10, padding:"14px", textAlign:"center" },
  uploadArea: { border:"2px dashed #1e293b", borderRadius:12, padding:"32px", textAlign:"center", cursor:"pointer", marginBottom:16 },
  instRow: { display:"flex", gap:10, alignItems:"flex-start", marginTop:8 },
  instNum: { width:24, height:24, borderRadius:"50%", background:"#f59e0b", color:"#000", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:11, flexShrink:0 },
  tokenRow: { display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #1e293b" },
};
