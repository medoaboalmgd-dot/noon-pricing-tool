// Daily cron: starts Apify run for all Egypt URLs with a webhook back to /api/apify-webhook
const SUPABASE_URL = "https://mxddjewxppkwhlkvejtx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZGRqZXd4cHBrd2hsa3ZlanR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTk3NTQsImV4cCI6MjA5NjU5NTc1NH0.SBojidbDLTlcMi04BDGJlcsuq_V2kpXC0uN8Lcufwic";
const APIFY_EG = "getdataforme~noon-product-spider";

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
};

export default async function handler(req, res) {
  try {
    // 1. Get server Apify token from settings
    const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.server&select=value`, { headers: sbHeaders });
    const settings = await settingsRes.json();
    const apifyToken = settings?.[0]?.value?.apifyToken;
    if (!apifyToken) return res.status(400).json({ error: "No server Apify token configured" });

    // 2. Get products with egypt_url
    const prodRes = await fetch(`${SUPABASE_URL}/rest/v1/products?egypt_url=not.is.null&select=egypt_url`, { headers: sbHeaders });
    const products = await prodRes.json();
    const urls = products.map(p => p.egypt_url).filter(Boolean);
    if (urls.length === 0) return res.json({ message: "No products to scrape" });

    // 3. Build webhook URL
    const host = req.headers.host;
    const webhookUrl = `https://${host}/api/apify-webhook`;
    const webhooks = Buffer.from(JSON.stringify([
      { eventTypes: ["ACTOR.RUN.SUCCEEDED"], requestUrl: webhookUrl }
    ])).toString("base64");

    // 4. Start Apify run (async — webhook will handle results)
    const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_EG}/runs?webhooks=${webhooks}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apifyToken}` },
      body: JSON.stringify({
        Urls: urls,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
      }),
    });
    const runData = await runRes.json();
    return res.json({ started: true, runId: runData.data?.id, urlCount: urls.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
