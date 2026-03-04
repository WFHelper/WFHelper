"use strict";

// Manual diagnostic probe script.
// Not used by app runtime or package.json scripts.
const https = require("https");

function httpReq(opts, body) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(c).toString(),
        }),
      );
    });
    req.on("error", (e) => resolve({ status: "ERR", headers: {}, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function get(path, headers) {
  return httpReq({ hostname: "api.warframe.market", port: 443, path, method: "GET", headers });
}

// Sign in to get a real JWT for authenticated probes
async function signIn(email, password) {
  // Step 1: get anonymous JWT from /v1/ root
  const root = await httpReq({
    hostname: "api.warframe.market",
    port: 443,
    path: "/v1/",
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "WarframeCompanion/1.0" },
  });
  const cookieJwt = (root.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("JWT="))
    ?.slice(4);
  if (!cookieJwt) {
    console.log("No anonymous JWT from root");
    return null;
  }
  console.log("Anonymous JWT acquired:", cookieJwt.slice(0, 30) + "...");

  // Step 2: sign in
  const bodyStr = JSON.stringify({ email, password, device_id: "probe-script" });
  const login = await httpReq(
    {
      hostname: "api.warframe.market",
      port: 443,
      path: "/v1/auth/signin",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        Cookie: `JWT=${cookieJwt}`,
        Authorization: `JWT ${cookieJwt}`,
        "User-Agent": "WarframeCompanion/1.0",
        Platform: "pc",
        Language: "en",
      },
    },
    bodyStr,
  );
  const loginBody = JSON.parse(login.body);
  const authJwt = (login.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("JWT="))
    ?.slice(4);
  const user = loginBody?.payload?.user || loginBody?.user || {};
  console.log("Sign-in status:", login.status);
  console.log("User info:", JSON.stringify(user, null, 2));
  return { jwt: authJwt || cookieJwt, user };
}

// Fetch WFM profile HTML and find JS bundle, then search for order-related paths
async function findEndpointsInBundle() {
  console.log("\n=== Fetching WFM profile page HTML ===");
  const pageRes = await httpReq({
    hostname: "warframe.market",
    port: 443,
    path: "/profile/mrzockerator",
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
  });
  const html = pageRes.body;
  // Find script src tags
  const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
  console.log("Script tags found:", scripts.slice(0, 10));
  // Find embedded JSON / __NUXT__ data
  const nuxt = html.match(/__NUXT__\s*=\s*(\{.*?\});?\s*<\/script>/s);
  if (nuxt) console.log("__NUXT__ data (first 400):", nuxt[1].slice(0, 400));
  else console.log("No __NUXT__ data found. HTML length:", html.length);
  // Search the HTML for embedded orders data (267KB SSR page may have it)
  const orderMatches = [...html.matchAll(/order_type["']?\s*:\s*["']?(buy|sell)["']?/gi)].length;
  console.log("Order references in HTML:", orderMatches);
  const htmlApiPaths = [...html.matchAll(/\/v[12]\/[a-z/_-]{3,50}/g)].map((m) => m[0]);
  console.log("Raw API paths in HTML:", [...new Set(htmlApiPaths)].slice(0, 20));

  // Fetch the main app bundle — prefer index.*.js but NOT runtime-index
  const mainBundle =
    scripts.find((s) => /\/index\.[a-f0-9]+\.js$/.test(s)) ||
    scripts.find((s) => s.endsWith(".js") && !s.includes("runtime") && !s.includes("recaptcha"));
  const bundleToFetch = mainBundle || scripts[0];
  if (bundleToFetch) {
    const scriptPath = bundleToFetch.startsWith("http")
      ? new URL(bundleToFetch).pathname
      : bundleToFetch;
    const scriptHost = bundleToFetch.startsWith("http")
      ? new URL(bundleToFetch).hostname
      : "warframe.market";
    console.log("\nFetching JS bundle:", bundleToFetch, "(size will be shown)");
    const jsRes = await httpReq({
      hostname: scriptHost,
      port: 443,
      path: scriptPath,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
    });
    console.log("Bundle status:", jsRes.status, "size:", jsRes.body.length);
    const js = jsRes.body;
    // Show ALL /order* occurrences with wider context
    const orderCtx = [...js.matchAll(/\/orders?[^a-zA-Z]/g)].map((m) => {
      const i = m.index;
      return js.slice(Math.max(0, i - 80), i + 100);
    });
    console.log(`\nAll '/order(s)' occurrences (${orderCtx.length} total, showing all):`);
    orderCtx.forEach((c, i) => console.log(`  [${i}] ${c.replace(/\n/g, " ")}`));

    // Look for useQuery-style fetch hooks that have a URL and onSuccess
    // Pattern: (url, opts, {onSuccess: ...) for the reading patterns
    const fetchHooks = [...js.matchAll(/[cCxX]\.[A-Z]\(["'/][^"']+["']\s*,/g)]
      .map((m) => {
        const i = m.index;
        return js.slice(Math.max(0, i - 20), i + 120);
      })
      .filter((s) => s.includes("/order") || s.includes("/v2"))
      .slice(0, 10);
    console.log("\nFetch hook patterns with order/v2:");
    fetchHooks.forEach((c, i) => console.log(`  [${i}] ${c.replace(/\n/g, " ")}`));

    // Look for Redux action creators that make order-fetching requests
    const reduxActions = [...js.matchAll(/getOrders|fetchOrders|loadOrders|myOrders|userOrders/gi)]
      .map((m) => {
        const i = m.index;
        return js.slice(Math.max(0, i - 20), i + 120);
      })
      .slice(0, 10);
    console.log("\nRedux/action order fetch patterns:");
    reduxActions.forEach((c, i) => console.log(`  [${i}] ${c.replace(/\n/g, " ")}`));
  }

  // Also check the chunk file
  const chunkScript = scripts.find(
    (s) =>
      s.includes("7913") || (s.endsWith(".js") && !s.includes("runtime") && !s.includes("index")),
  );
  if (chunkScript) {
    const chunkPath = chunkScript.startsWith("http") ? new URL(chunkScript).pathname : chunkScript;
    console.log("\nFetching chunk:", chunkScript);
    const chunkRes = await httpReq({
      hostname: "warframe.market",
      port: 443,
      path: chunkPath,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
    });
    console.log("Chunk status:", chunkRes.status, "size:", chunkRes.body.length);
    const cjs = chunkRes.body;
    const profileCtx2 = [...cjs.matchAll(/profile.{0,80}/gi)].map((m) => m[0]).slice(0, 15);
    console.log("'profile' contexts in chunk:", profileCtx2);
    const orderCtx2 = [...cjs.matchAll(/\/order.{0,40}/gi)].map((m) => m[0]).slice(0, 15);
    console.log("'/order' contexts in chunk:", orderCtx2);
  }
}

(async () => {
  const h = {
    Accept: "application/json",
    Platform: "pc",
    Language: "en",
    Crossplay: "true",
    "User-Agent": "WarframeCompanion/1.0",
  };

  // Unauthenticated probes + method exploration
  const tests = [
    "/v1/profile/mrzockerator/statistics", // KNOWN 200 (closed_orders)
    "/v2/orders/group/all", // 405 GET, try nothing — check other methods below
    "/v2/orders", // maybe list endpoint
    "/v2/order", // singular
    "/v2/profile/orders",
  ];
  console.log("=== Unauthenticated probes ===");
  for (const path of tests) {
    const r = await get(path, h);
    console.log(`GET ${path} -> ${r.status} ${r.body.slice(0, 120).replace(/\n/g, " ")}`);
  }

  // Try alternative HTTP methods on paths that returned 405
  console.log("\n=== Method exploration on /v2/orders/group/all ===");
  for (const method of ["POST", "PUT", "PATCH", "OPTIONS", "HEAD"]) {
    const r = await httpReq({
      hostname: "api.warframe.market",
      port: 443,
      path: "/v2/orders/group/all",
      method,
      headers: h,
    });
    console.log(
      `${method} /v2/orders/group/all -> ${r.status} ${r.body.slice(0, 120).replace(/\n/g, " ")}`,
    );
  }

  // Sign in and probe authenticated endpoints
  // REPLACE these with your actual credentials when running
  const EMAIL = process.env.WFM_EMAIL || "";
  const PASS = process.env.WFM_PASS || "";
  if (EMAIL && PASS) {
    const session = await signIn(EMAIL, PASS);
    if (session) {
      const authH = { ...h, Authorization: `JWT ${session.jwt}`, Cookie: `JWT=${session.jwt}` };
      const slug = session.user.slug || session.user.ingame_name || "mrzockerator";
      console.log("\n=== Authenticated probes (slug:", slug, ") ===");
      const authTests = [
        "/v2/order", // 401 unauthenticated — should return orders with auth
        "/v2/orders/group/all", // 405 GET, need to try PUT/PATCH with auth
        "/v2/orders",
        `/v1/profile/${slug}/orders`, // old (expected 404)
      ];
      // Also try PUT/PATCH on /v2/orders/group/all with auth
      const changeVis = { visibility: true }; // dummy payload
      for (const method of ["PUT", "PATCH"]) {
        const r2 = await httpReq(
          {
            hostname: "api.warframe.market",
            port: 443,
            path: "/v2/orders/group/all",
            method,
            headers: { ...authH, "Content-Type": "application/json" },
          },
          JSON.stringify(changeVis),
        );
        console.log(`AUTH ${method} /v2/orders/group/all -> ${r2.status} ${r2.body.slice(0, 200)}`);
      }
      for (const path of authTests) {
        const r = await get(path, authH);
        console.log(`AUTH ${path} -> ${r.status} ${r.body.slice(0, 200).replace(/\n/g, " ")}`);
      }
    }
  } else {
    console.log("\nSkipping authenticated probes — set WFM_EMAIL and WFM_PASS env vars to enable");
  }

  await findEndpointsInBundle();
})().catch(console.error);
