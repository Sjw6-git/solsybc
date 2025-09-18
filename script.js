// ---------- config: your live Worker ----------
const WORKER = "https://solsync-lite.jjyjasmin16.workers.dev";

// ---------- tiny helpers ----------
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const fmtBytes = (n) => {
  if (n == null) return "—";
  const u = ["B","KB","MB","GB","TB"]; let i=0;
  while (n >= 1024 && i < u.length-1){ n/=1024; i++; }
  return `${n.toFixed(2)} ${u[i]}`;
};

// Footer year
const yearEl = $("#year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// ---------- Single-section flow ----------
(function initAllInOne(){
  const fileInput = $("#file");
  const goBtn     = $("#go");
  const result    = $("#result");
  const linkEl    = $("#dl");
  const qrCanvas  = $("#qr");
  const qrImg     = $("#qrimg");        // optional <img> fallback if you added it
  const logEl     = $("#log");
  const openBtn   = $("#open");
  const copyBtn   = $("#copy");
  const showQrBtn = $("#show-qr");

  if (!fileInput || !goBtn) return;

  let lastDownloadUrl = "";

  goBtn.addEventListener("click", async () => {
    const f = fileInput.files?.[0];
    if (!f) return alert("Choose a file first.");

    logStart();
    step(`Selected: ${f.name} (${fmtBytes(f.size)})`);

    // 1) Create upload + one-time download pair
    let meta;
    try {
      const createURL = WORKER.replace(/\/$/, "") + "/api/create";
      const res = await fetch(createURL, { method: "POST" });
      if (!res.ok) {
        const txt = await res.text().catch(()=> "");
        throw new Error(`Create failed ${res.status} ${res.statusText} ${txt}`);
      }
      meta = await res.json();
      step("Got upload and one-time download URLs from server.");
    } catch (e) {
      step("Backend not reachable — " + e.message);
      console.error(e);
      return;
    }

    // 2) Upload file (PUT)
    try {
      await fetch(meta.uploadUrl, {
        method: "PUT",
        body: f,
        headers: {
          "content-type": f.type || "application/octet-stream",
          "x-filename": encodeURIComponent(f.name)
        }
      });
      step("Uploaded to storage.");
    } catch (e) {
      step("Upload failed. Check CORS, MAX_BYTES, or network.");
      console.error(e);
      return;
    }

    // 3) Show link + real QR inside the same section
    lastDownloadUrl   = meta.downloadUrl;
    if (openBtn) openBtn.href = lastDownloadUrl;
    linkEl.href       = lastDownloadUrl;
    linkEl.textContent= lastDownloadUrl;
    await drawQR(lastDownloadUrl, 360);
    result.hidden = false;

    step("Open the link/QR on your other device. Link works once, then expires.");

    // actions
    if (copyBtn) copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(lastDownloadUrl); step("Copied link to clipboard."); }
      catch { step("Could not copy — copy the link manually."); }
    };
    if (showQrBtn) showQrBtn.onclick = async () => {
      await drawQR(lastDownloadUrl, 420); // temporarily bigger
      qrCanvas?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });

  function logStart(){ if (logEl) logEl.textContent = ""; }
  function step(text){ if (logEl) logEl.textContent += `• ${text}\n`; }

  // -------- QR (library → image → placeholder) --------
  async function drawQR(text, size=360){
    if (!qrCanvas) return;

    // Prefer real QR via library (if loaded)
    if (window.QRCode?.toCanvas) {
      await QRCode.toCanvas(qrCanvas, text, {
        width: size,
        margin: 0,
        errorCorrectionLevel: "M"
      });
      // show canvas, hide image fallback if present
      qrCanvas.style.display = "block";
      if (qrImg) qrImg.style.display = "none";
      return;
    }

    // Fallback: use image QR API if you added <img id="qrimg">
    if (qrImg) {
      const px = Math.max(280, Math.min(520, size));
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=${px}x${px}&data=${encodeURIComponent(text)}`;
      qrImg.style.display = "block";
      qrCanvas.style.display = "none";
      return;
    }

    // Last resort: non-scannable placeholder pattern
    const ctx = qrCanvas.getContext("2d");
    const n = 32, s = Math.max(6, Math.floor(size/n));
    qrCanvas.width = qrCanvas.height = n * s;
    [...text].forEach((ch,i) => {
      const x = (i % n) * s, y = (i / n | 0) * s;
      ctx.fillStyle = ((ch.charCodeAt(0)+i) % 2) ? "#111827" : "#e5e7eb";
      ctx.fillRect(x, y, s, s);
    });
    qrCanvas.style.display = "block";
    if (qrImg) qrImg.style.display = "none";
  }
})();





