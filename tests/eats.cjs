// Headless test of saving food photos to the camera roll and the "What I eat" daily collage.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("C:/Users/Perry/hyperframes-student-kit/node_modules/playwright");
const DOCS = "C:/Users/Perry/plate/docs";
const IMGS = process.argv.slice(2);

const server = http.createServer((req, res) => {
  const p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
}).listen(8770);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
let n = 0;
async function fakeClaude(route) {
  const req = route.request();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  n++;
  const est = { title: "Meal " + n, items: [{ name: "Food", portion: "1 plate", calories: 500, protein: 40, carbs: 50, fat: 15, fiber: 2 }], confidence: "high", note: "" };
  return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
    id: "msg_" + n, type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(est) }], usage: { input_tokens: 1500, output_tokens: 200 } }) });
}

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // a share sheet stand-in that records what it got and whether a tap was still active (Safari refuses otherwise)
  await ctx.addInitScript(() => {
    window.__shares = [];
    navigator.canShare = (d) => !!(d && d.files && d.files.length);
    navigator.share = (d) => { window.__shares.push({ n: d.files.length, types: d.files.map((f) => f.type), names: d.files.map((f) => f.name), active: navigator.userActivation.isActive }); return Promise.resolve(); };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.anthropic.com/**", fakeClaude);
  await page.route("https://api.github.com/**", (r) => r.abort());
  const text = () => page.locator("#view").innerText();
  const shares = () => page.evaluate(() => window.__shares);
  // a buffer upload gets lastModified = now, like a photo just taken with the camera
  const fresh = (i) => ({ name: "image.jpg", mimeType: "image/jpeg", buffer: fs.readFileSync(IMGS[i % IMGS.length]) });

  await page.goto("http://localhost:8770/#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();

  // --- saving to Photos ---
  await page.goto("http://localhost:8770/#/add");
  await page.setInputFiles("#photoIn", fresh(0));
  await page.waitForSelector(".picks div");
  await page.waitForFunction(() => document.getElementById("toast").classList.contains("show"));
  ok((await page.locator("#toastText").innerText()).includes("isn't in your Photos yet"), "a just-taken photo offers to save itself");
  await page.click("#toastBtn");
  let sh = await shares();
  ok(sh.length === 1 && sh[0].n === 1 && sh[0].types[0] === "image/jpeg", "toast opens the share sheet with the photo", JSON.stringify(sh));
  ok(sh[0] && sh[0].active, "share starts while the tap is still active");
  await page.waitForSelector('[data-act="saveFoodPhotos"]:has-text("Saved to your Photos")');
  ok(true, "button turns into Saved after sharing");

  await page.setInputFiles("#photoIn", { name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: fs.readFileSync(IMGS[1 % IMGS.length]), lastModified: Date.now() - 86400e3 });
  await page.waitForFunction(() => document.querySelectorAll(".picks div").length === 2);
  ok(await page.locator('[data-act="saveFoodPhotos"]:has-text("Save these photos")').count() === 1, "adding an unsaved photo brings the save button back");
  await page.click('[data-act="saveFoodPhotos"]');
  sh = await shares();
  ok(sh.length === 2 && sh[1].n === 2 && sh[1].active, "button shares both photos straight from the tap", JSON.stringify(sh[1]));

  // a draft restored after the app closed has no originals: still shares from the tap
  await page.waitForTimeout(600);   // the draft saves on a 300 ms debounce
  await page.reload();
  await page.waitForSelector('[data-act="saveFoodPhotos"]');
  await page.click('[data-act="saveFoodPhotos"]');
  sh = await shares();
  ok(sh.length === 1 && sh[0].n === 2 && sh[0].active && sh[0].types.every((t) => t === "image/jpeg"), "restored draft photos share from the tap too", JSON.stringify(sh));

  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  await page.click('[data-act="saveEntry"]');
  await page.waitForSelector(".entry");

  // --- collage: three more meals today, so four photo meals ---
  for (let i = 1; i <= 3; i++) {
    await page.goto("http://localhost:8770/#/add");
    await page.setInputFiles("#photoIn", fresh(i));
    await page.waitForSelector(".picks div");
    await page.click('[data-act="estimate"]');
    await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
    await page.click('[data-act="saveEntry"]');
    await page.waitForFunction((k) => document.querySelectorAll(".entry").length === k, i + 1);
  }
  ok(await page.locator('a[href^="#/eats/"]:has-text("Collage")').count() === 1, "Today's Food card links to the collage");

  await page.goto("http://localhost:8770/#/me");
  ok(await page.locator('a[href="#/eats"]').count() === 1, "profile has a What I eat button");
  await page.click('a[href="#/eats"]');
  await page.waitForSelector(".pgrid a.mos");
  ok(await page.locator(".pgrid a.mos").count() === 1, "one day tile");
  ok(await page.locator(".pgrid a.mos.n4 div").count() === 4, "tile is a 2x2 of the day's four meals");
  ok((await text()).includes("2,000"), "tile shows the day's calories", await text());
  await page.waitForFunction(() => [...document.querySelectorAll(".mos div")].every((d) => d.style.backgroundImage));
  ok(true, "tile photos load");

  await page.click(".pgrid a.mos");
  await page.waitForFunction(() => { const i = document.getElementById("collageImg"); return i && i.complete && i.naturalWidth > 0; });
  const dims = await page.evaluate(() => [document.getElementById("collageImg").naturalWidth, document.getElementById("collageImg").naturalHeight]);
  ok(dims[0] === 1080 && dims[1] === 1350, "collage is 1080x1350", dims);
  ok(!(await page.locator("#collageSave").isDisabled()), "save button ready once drawn");
  ok((await text()).includes("Meal 4") && (await text()).includes("2,000 cal"), "day page lists the meals and totals");
  await page.click("#collageSave");
  sh = await shares();
  const last = sh[sh.length - 1];
  ok(last.n === 1 && last.active && /^plate-\d{4}-\d{2}-\d{2}\.jpg$/.test(last.names[0]), "collage shares as one jpg from the tap", JSON.stringify(last));
  await page.screenshot({ path: path.join(__dirname, "eats.png"), fullPage: false });

  // a three-meal day fills the fourth spot with meal one's second angle
  await page.click('.entry:has-text("Meal 4")');
  await page.click('[data-act="deleteEntry"]');
  await page.waitForFunction(() => document.querySelectorAll(".entry").length === 3);
  await page.goto("http://localhost:8770/#/eats");
  await page.waitForSelector(".pgrid a.mos");
  ok(await page.locator(".pgrid a.mos.n4 div").count() === 4 && (await text()).includes("1,500"), "three meals plus an extra angle after a delete", await text());

  await page.goto("http://localhost:8770/#/eats/2020-01-01");
  ok((await text()).includes("No food photos that day"), "empty day says so");

  ok(errors.length === 0, "no page errors", errors);
  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
