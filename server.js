// server.js
import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();

// ---------------- CONFIG ----------------
const TARGET = "https://rajdharaa.rajasthan.gov.in";
const MAP_PATH = "/girdawarigis/mobile/map.html";

// ====== Your injection (runs inside their map) ======
const INJECT_SCRIPT = `
<script>
(function () {
  if (window.__lodPersistFix) { console.warn("LOD persist fix already active."); return; }
  window.__lodPersistFix = true;

  require([
    "esri/views/MapView",
    "esri/layers/BaseTileLayer",
    "esri/request"
  ], function (MapView, BaseTileLayer, esriRequest) {

    function isBase(l){ const s=(l.title||"")+" "+(l.url||""); return /World[_/ ]?Imagery/i.test(s); }
    function isOverlay(l, base){
      if (!l || l===base) return false;
      const s=(l.title||"")+" "+(l.url||"");
      return /(SettlementNIC|Settlement|Khasra|Girdawari)/i.test(s) || (l.declaredClass||"").includes("TileLayer");
    }

    async function run(view){
      await view.when();
      const map = view.map;
      const layers = map.layers.toArray();
      const base = layers.find(isBase) || layers.find(l => (l.declaredClass||"").includes("TileLayer"));
      const overlay = layers.find(l => isOverlay(l, base));

      if (!base?.tileInfo?.lods?.length || !overlay?.tileInfo?.lods?.length) {
        console.warn("[lod-persist] Missing tileInfo on base/overlay."); return;
      }

      view.constraints = {
        ...view.constraints,
        lods: base.tileInfo.lods,
        minZoom: 0,
        maxZoom: 23,
        snapToZoom: true
      };

      const TILE = 256;
      const MIN = 14;
      const MAX = 19;
      const cache = new Map();

      function tilesPerLevel(level){ return 1 << level; }
      function resAt(level, tileInfo){ return tileInfo.lods.find(d=>d.level===level).resolution; }
      function tileExtent(level,row,col,tileInfo){
        const res = resAt(level, tileInfo);
        const o = tileInfo.origin;
        const xmin = o.x + col * res * TILE;
        const xmax = xmin + res * TILE;
        const ymax = o.y - row * res * TILE;
        const ymin = ymax - res * TILE;
        return { xmin, ymin, xmax, ymax, res };
      }
      function clampIndex(v, max){ return Math.max(0, Math.min(v, max)); }

      async function getTileBitmap(url, level, row, col){
        const maxIdx = tilesPerLevel(level) - 1;
        row = clampIndex(row, maxIdx);
        col = clampIndex(col, maxIdx);

        const key = \`\${url}|\${level}/\${row}/\${col}\`;
        if (cache.has(key)) return cache.get(key);
        const tileUrl = \`\${url.replace(/\\/+$/,"")}/tile/\${level}/\${row}/\${col}\`;
        try{
          const r = await esriRequest(tileUrl, { responseType: "blob", timeout: 10000 });
          const b = r?.data;
          if (!b || !b.size) { cache.set(key, null); return null; }
          const img = await createImageBitmap(b).catch(()=>null);
          cache.set(key, img);
          return img;
        } catch(e){ cache.set(key, null); return null; }
      }

      const SmartTileLayer = BaseTileLayer.createSubclass({
        properties: { url: null, tileInfo: null, spatialReference: null },
        constructor(opts){
          this.url = opts.url.replace(/\\/+$/,"");
          this.tileInfo = opts.tileInfo;
          this.spatialReference = overlay.spatialReference;
          this.minScale = 0; this.maxScale = 0;
        },
        fetchTile: async function(level,row,col){
          const can = document.createElement("canvas");
          can.width = TILE; can.height = TILE;
          const ctx = can.getContext("2d");
          ctx.clearRect(0,0,TILE,TILE);

          if (level >= MIN && level <= MAX) {
            const direct = await getTileBitmap(this.url, level, row, col);
            if (direct){ ctx.drawImage(direct, 0, 0, TILE, TILE); return can; }
            for (let p = level-1; p >= MIN; p--) {
              const scale = 1 << (level - p);
              const pr = Math.floor(row / scale);
              const pc = Math.floor(col / scale);
              const parent = await getTileBitmap(this.url, p, pr, pc);
              if (parent){
                const srcSize = TILE / scale;
                const sx = (col % scale) * srcSize;
                const sy = (row % scale) * srcSize;
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(parent, sx, sy, srcSize, srcSize, 0, 0, TILE, TILE);
                return can;
              }
            }
          }

          if (level > MAX) {
            for (let p = MAX; p >= MIN; p--) {
              const scale = 1 << (level - p);
              const pr = Math.floor(row / scale);
              const pc = Math.floor(col / scale);
              const parent = await getTileBitmap(this.url, p, pr, pc);
              if (parent){
                const srcSize = TILE / scale;
                const sx = (col % scale) * srcSize;
                const sy = (row % scale) * srcSize;
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(parent, sx, sy, srcSize, srcSize, 0, 0, TILE, TILE);
                return can;
              }
            }
            return can;
          }

          const target = tileExtent(level, row, col, this.tileInfo);
          for (let l = MIN; l <= MAX; l++) {
            const resL = resAt(l, this.tileInfo);
            const o = this.tileInfo.origin;

            const colStart = clampIndex(Math.floor((target.xmin - o.x) / (resL * TILE)), tilesPerLevel(l)-1);
            const colEnd   = clampIndex(Math.floor((target.xmax - o.x) / (resL * TILE)), tilesPerLevel(l)-1);
            const rowStart = clampIndex(Math.floor((o.y - target.ymax) / (resL * TILE)), tilesPerLevel(l)-1);
            const rowEnd   = clampIndex(Math.floor((o.y - target.ymin) / (resL * TILE)), tilesPerLevel(l)-1);

            for (let r = rowStart; r <= rowEnd; r++) {
              for (let c = colStart; c <= colEnd; c++) {
                const bmp = await getTileBitmap(this.url, l, r, c);
                if (!bmp) continue;

                const child = tileExtent(l, r, c, this.tileInfo);
                const dx = (child.xmin - target.xmin) / target.res;
                const dy = (target.ymax - child.ymax) / target.res;
                const dw = (child.xmax - child.xmin) / target.res;
                const dh = (child.ymax - child.ymin) / target.res;

                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(bmp, 0, 0, TILE, TILE, dx, dy, dw, dh);
              }
            }
          }
          return can;
        }
      });

      const smart = new SmartTileLayer({ url: overlay.url, tileInfo: overlay.tileInfo });
      map.add(smart);
      map.reorder(smart, map.layers.length - 1);
      try { await view.goTo({ center: view.center, zoom: view.zoom }); } catch(e){}
      console.log("[lod-persist] Smart overlay added. Overlay persists across zooms.");
    }

    if (window.view && window.view.declaredClass==="esri.views.MapView"){ run(window.view); return; }
    const _goTo = MapView.prototype.goTo;
    MapView.prototype.goTo = function(){
      MapView.prototype.goTo = _goTo;
      run(this);
      return _goTo.apply(this, arguments);
    };
    console.log("[lod-persist] Waiting for MapView…");
  });
})();
</script>
`;

// -------- Proxy Rajdharaa through /r (keeps same-origin) --------
app.use(
  "/r",
  createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    secure: true,
    pathRewrite: { "^/r": "" }, // /r/<path> -> https://rajdharaa.../<path>
    onProxyRes: (proxyRes) => {
      // Remove headers that block iframe embedding
      delete proxyRes.headers["x-frame-options"];
      delete proxyRes.headers["content-security-policy"];
    },
  })
);

// -------- /embed serves the page with your code injected --------
app.get("/embed", async (req, res) => {
  try {
    const url = `${TARGET}${MAP_PATH}`;
    const r = await fetch(url);
    let html = await r.text();

    // Route all absolute Rajdharaa links via /r
    html = html.replaceAll(/https?:\/\/rajdharaa\.rajasthan\.gov\.in/gi, "/r");

    // Ensure relative assets resolve correctly (base to /girdawarigis/mobile/)
    const baseTag = `<base href="/r/girdawarigis/mobile/">`;
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);

    // Inject your script before </body>
    html = html.includes("</body>")
      ? html.replace("</body>", `${INJECT_SCRIPT}\n</body>`)
      : html + INJECT_SCRIPT;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to fetch/inject map page.");
  }
});

// Minimal host page that iframes /embed (nice mobile fullscreen)
app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Rajdharaa Embedded</title>
<style>html,body,iframe{height:100%;width:100%;margin:0;border:0;overflow:hidden;}</style>
</head>
<body>
  <iframe src="/embed" allow="geolocation *; clipboard-read; clipboard-write"></iframe>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Embed server running on port ${PORT}`);
});
