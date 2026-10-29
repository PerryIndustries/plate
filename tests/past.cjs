// Headless test of finding a meal he logged before: typing its name on Log food shows it, one tap logs it again or saves it as usual.
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
}).listen(8772);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
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
const pudding = { title: "Chocolate protein pudding", confidence: "high", note: "", shots: [],
  items: [{ name: "Protein pudding", portion: "1 cup (240 g)", calories: 280, protein: 32, carbs: 20, fat: 6, fiber: 3 },
    { name: "Whipped cream", portion: "2 tbsp", calories: 40, protein: 0, carbs: 2, fat: 3, fiber: 0 }] };

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.anthropic.com/**", fakeClaude);
  await page.route("https://api.github.com/**", (r) => r.abort());
  const text = () => page.locator("#view").innerText();
  const entries = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open("plate");
    r.onsuccess = () => {
      const db = r.result, names = [...db.objectStoreNames];
      const tx = db.transaction(names[0]), st = tx.objectStore(names[0]), all = st.getAll(), keys = st.getAllKeys();
      tx.oncomplete = () => res(all.result.map((v, i) => [keys.result[i], v]));
    };
  })).then((kv) => ({ days: kv.flatMap(([k, v]) => (String(k).startsWith("day:") && v && v.entries ? v.entries.filter((e) => !e.del) : [])),
    favs: (kv.find(([k]) => k === "favs") || [])[1] || [] }));

  await page.goto("http://localhost:8772/#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();

  // --- logged once from a photo, not saved as usual ---
  next = pudding;
  await page.goto("http://localhost:8772/#/add");
  await page.setInputFiles("#photoIn", { name: "IMG_1.jpg", mimeType: "image/jpeg", buffer: fs.readFileSync(IMGS[0]), lastModified: Date.now() - 86400e3 });
  await page.waitForSelector(".picks div");
  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  await page.click('[data-act="saveEntry"]');
  await page.waitForSelector(".entry");
  ok((await entries()).days.length === 1, "the pudding is logged once");

  // --- typing finds it ---
  await page.goto("http://localhost:8772/#/add");
  ok(!(await page.locator(".past").count()), "nothing shows before he types");
  await page.fill("#foodText", "tacos");
  await page.waitForTimeout(300);
  ok(!(await page.locator(".past").count()), "a food he never had finds nothing");
  await page.fill("#foodText", "pudd");
  await page.waitForSelector(".past");
  const t1 = await text();
  ok(t1.includes("Chocolate protein pudding") && t1.includes("320 cal") && t1.includes("32g protein"), "a few letters find the pudding with its numbers", t1);
  ok(await page.locator("#foodText").evaluate((el) => document.activeElement === el), "typing keeps the keyboard up (no re-render)");
  await page.waitForFunction(() => document.querySelector(".past .thumb")?.style.backgroundImage);
  ok(true, "the old photo shows next to it");
  await page.screenshot({ path: path.join(__dirname, "past.png") });
  await page.fill("#foodText", "the same protein pudding as yesterday");
  await page.waitForTimeout(300);
  ok(await page.locator(".past").count() === 1, "a sentence about it finds it too");
  await page.fill("#foodText", "whipped cream");
  await page.waitForTimeout(300);
  ok(await page.locator(".past").count() === 1, "an item inside the meal finds it");

  // --- save as usual from history ---
  await page.click('[data-act="favPast"]');
  await page.waitForFunction(() => !document.querySelector('[data-act="favPast"]'));
  let st = await entries();
  const fav = st.favs.find((f) => f.title === "Chocolate protein pudding" && !f.del);
  ok(fav && fav.cal === 320 && fav.p === 32 && fav.items.length === 2, "Save as usual makes a saved meal with the same numbers", JSON.stringify(fav));
  ok((await page.locator("#foodText").inputValue()) === "whipped cream", "saving keeps what he typed");

  // --- log again ---
  await page.fill("#foodText", "protein pudding");
  await page.waitForSelector('[data-act="logPast"]');
  const callsBefore = asks.length;
  await page.click('[data-act="logPast"]');
  await page.waitForSelector(".entry");
  st = await entries();
  const again = st.days.filter((e) => e.title === "Chocolate protein pudding");
  ok(again.length === 2, "Log again adds a second pudding", again.length);
  const copy = again.find((e) => e.src === "again");
  ok(copy && copy.cal === 320 && copy.p === 32 && copy.c === 22 && copy.f === 9 && copy.items.length === 2, "the copy has the exact numbers and items", JSON.stringify(copy));
  ok(copy && copy.photo === null && copy.again === again.find((e) => e !== copy).id, "the copy points at the first one and doesn't reuse its photo");
  ok(asks.length === callsBefore, "logging again costs no Claude call");
  ok(!(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("plate"); r.onsuccess = () => { const db = r.result, tx = db.transaction([...db.objectStoreNames][0]), g = tx.objectStore([...db.objectStoreNames][0]).get("draft"); g.onsuccess = () => res(g.result && g.result.text); }; }))), "the typed text is cleared after logging");

  // --- Claude is told to reuse a named meal exactly ---
  next = Object.assign({}, pudding);
  await page.goto("http://localhost:8772/#/add");
  await page.fill("#foodText", "protein pudding");
  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  const sys = asks[asks.length - 1].system;
  ok(/he is logging it again/.test(sys) && /add up exactly/.test(sys), "the estimate prompt says a named past meal keeps its numbers");
  ok(/Chocolate protein pudding \(2 times, last \d{4}-\d{2}-\d{2}\)/.test(sys) && /= 320 cal, 32 g protein/.test(sys), "and it lists the pudding with its numbers", sys.slice(-400));

  ok(errors.length === 0, "no page errors", errors);
  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
