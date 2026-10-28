// Headless test of the Food tab showing each separate food, and estimates that know what he has logged before.
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
}).listen(8771);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
const whole = { left: 0, top: 0, right: 1, bottom: 1 };
// what the fake Claude answers next, and every request it got
let next = null;
const asks = [];
async function fakeClaude(route) {
  const req = route.request();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  asks.push(JSON.parse(req.postData()));
  return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
    id: "msg_" + asks.length, type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(next) }], usage: { input_tokens: 1500, output_tokens: 200 } }) });
}
const est = (title, cal, shots) => ({ title, items: [{ name: "Food", portion: "1 plate", calories: cal, protein: 40, carbs: 50, fat: 15, fiber: 2 }],
  confidence: "medium", note: "", shots });

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.anthropic.com/**", fakeClaude);
  await page.route("https://api.github.com/**", (r) => r.abort());
  const text = () => page.locator("#view").innerText();
  const photo = (i) => ({ name: "IMG_" + i + ".jpg", mimeType: "image/jpeg", buffer: fs.readFileSync(IMGS[i % IMGS.length]), lastModified: Date.now() - 86400e3 });
  async function logMeal(files, answer, typed) {
    next = answer;
    await page.goto("http://localhost:8771/#/add");
    for (const f of files) {
      const before = await page.locator(".picks div").count();
      await page.setInputFiles("#photoIn", f);
      await page.waitForFunction((k) => document.querySelectorAll(".picks div").length > k, before);
    }
    if (typed) await page.fill("#foodText", typed);
    await page.click('[data-act="estimate"]');
    await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
    await page.click('[data-act="saveEntry"]');
    await page.waitForSelector(".entry");
  }

  await page.goto("http://localhost:8771/#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();

  // --- one estimate, three photos of three different things ---
  await logMeal([photo(0), photo(1), photo(2)], est("Lunch spread", 1200, [
    { photo: 1, name: "Asada bowl", box: whole }, { photo: 2, name: "Horchata", box: whole }, { photo: 3, name: "Chips and salsa", box: whole }]));
  const first = asks[0];
  const msg = first.messages[0].content;
  ok(msg.filter((b) => b.type === "image").length === 3, "all three photos go to Claude");
  ok(msg.some((b) => b.type === "text" && b.text === "Photo 2:"), "photos are numbered for Claude");
  ok(first.output_config.format.schema.required.includes("shots"), "the answer must say how the photos split into foods");
  ok(!/logged in the last/.test(first.system), "a first-ever estimate has no history to show");

  await page.goto("http://localhost:8771/#/me/food");
  await page.waitForSelector(".pgrid a.fd");
  ok(await page.locator(".pgrid a.fd").count() === 3, "three photos of three foods are three tiles", await page.locator(".pgrid a.fd").count());
  const t1 = await text();
  ok(t1.includes("Asada bowl") && t1.includes("Horchata") && t1.includes("Chips and salsa"), "each tile names its food", t1);
  await page.waitForFunction(() => [...document.querySelectorAll(".pgrid a.fd")].every((a) => a.style.backgroundImage));
  ok(true, "tile photos load");

  // --- three angles of one food ---
  await logMeal([photo(3), photo(0)], est("Protein yogurt bowl", 450, [{ photo: 2, name: "Protein yogurt bowl", box: whole }]), "greek yogurt, granola, blueberries");
  await page.goto("http://localhost:8771/#/me/food");
  await page.waitForSelector(".pgrid a.fd");
  ok(await page.locator(".pgrid a.fd").count() === 4, "two angles of one food are one tile");
  ok((await page.locator(".pgrid a.fd").first().innerText()).includes("Protein yogurt bowl"), "newest food comes first");

  // --- one photo that is a collage of three pictures ---
  await logMeal([photo(1)], est("Snacks", 600, [
    { photo: 1, name: "Protein bar", box: { left: 0, top: 0, right: 0.333, bottom: 1 } },
    { photo: 1, name: "Banana", box: { left: 0.333, top: 0, right: 0.667, bottom: 1 } },
    { photo: 1, name: "Shake", box: { left: 0.667, top: 0, right: 1, bottom: 1 } },
    { photo: 9, name: "Not a photo", box: whole }]));
  await page.goto("http://localhost:8771/#/me/food");
  await page.waitForFunction(() => document.querySelectorAll(".pgrid a.fd").length === 7);
  ok(true, "a collage photo is cut into its three foods (and a made-up photo number is ignored)");
  await page.waitForFunction(() => [...document.querySelectorAll(".pgrid a.fd[data-crop]")].length === 3 && [...document.querySelectorAll(".pgrid a.fd[data-crop]")].every((a) => a.style.backgroundImage));
  const crop = await page.evaluate(async () => {
    const a = document.querySelector('.pgrid a.fd[data-crop^="0.333"]');
    const img = new Image();
    img.src = a.style.backgroundImage.slice(5, -2);
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  const full = await page.evaluate(async () => {
    const a = document.querySelector('.pgrid a.fd:not([data-crop])');
    const img = new Image();
    img.src = a.style.backgroundImage.slice(5, -2);
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  ok(crop[0] < full[0] * 0.5 && crop[1] > 0, "the middle tile shows only its third of the photo", JSON.stringify({ crop, full }));
  await page.screenshot({ path: path.join(__dirname, "foods.png"), fullPage: false });

  // the day collage on the All tab uses the cut foods too
  await page.goto("http://localhost:8771/#/me");
  await page.waitForSelector(".pgrid a.mos");
  ok(await page.locator(".pgrid a.mos [data-crop]").count() >= 1 || await page.locator(".pgrid a.mos.n3").count() === 1, "the day tile on All still shows the day");
  await page.click(".pgrid a.mos");
  await page.waitForFunction(() => { const i = document.getElementById("collageImg"); return i && i.complete && i.naturalWidth > 0; });
  ok(true, "day collage draws with cut foods");

  // --- past meals reach Claude ---
  await logMeal([], est("Lunch spread", 1200, []), "same lunch as before");
  const last = asks[asks.length - 1];
  ok(/logged in the last 90 days/.test(last.system), "the estimate gets his logged history", last.system.slice(-600));
  ok(/Lunch spread \(\d{4}-\d{2}-\d{2}\): Food 1 plate = 1,?200 cal/.test(last.system), "a past meal carries its items and calories", last.system.slice(-600));
  ok(/"greek yogurt, granola, blueberries"/.test(last.system), "his own words for a past meal go along", last.system.slice(-600));
  ok(await page.locator(".pgrid a.fd").count() === 0, "(sanity: on Today)");
  await page.goto("http://localhost:8771/#/me/food");
  await page.waitForSelector(".pgrid a.fd");
  ok(await page.locator(".pgrid a.fd").count() === 7, "a typed meal with no photo adds no tile");

  // the second log of the same title counts as a repeat
  await logMeal([], est("Lunch spread", 1200, []), "again");
  ok(/Lunch spread \(2 times, last \d{4}-\d{2}-\d{2}\)/.test(asks[asks.length - 1].system), "a repeated meal says how often", asks[asks.length - 1].system.slice(-600));

  // --- editing a split meal keeps the split ---
  await page.goto("http://localhost:8771/#/");
  await page.click('.entry:has-text("Snacks")');
  await page.waitForSelector('[data-act="saveEntry"]');
  await page.click('[data-act="saveEntry"]');
  await page.waitForSelector(".entry");
  const saved = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open("plate");
    r.onsuccess = () => {
      const db = r.result, names = [...db.objectStoreNames];
      const tx = db.transaction(names[0]), st = tx.objectStore(names[0]), all = st.getAll(), keys = st.getAllKeys();
      tx.oncomplete = () => res(all.result.map((v, i) => [keys.result[i], v]));
    };
  }));
  const snack = saved.flatMap(([k, v]) => (String(k).startsWith("day:") && v && v.entries ? v.entries : [])).find((e) => e.title === "Snacks");
  ok(snack && snack.shots && snack.shots.length === 3 && snack.shots.every((s) => s.photo === snack.photo && s.box), "the saved entry keeps three cut foods after an edit", JSON.stringify(snack && snack.shots));

  ok(errors.length === 0, "no page errors", errors);
  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
