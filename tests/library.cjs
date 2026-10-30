// Headless test of estimates reusing the foods he has logged: every separate food goes into the prompt with the numbers
// he kept (hand fixes included), and an item Claude based on one shows "like your ..." on Check it.
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
}).listen(8774);

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
const item = (name, portion, calories, protein, from) => ({ name, portion, calories, protein, carbs: 10, fat: 8, fiber: 1, ...(from != null ? { from } : {}) });

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
      tx.oncomplete = () => res(all.result.map((v, i) => [keys.result[i], v]).flatMap(([k, v]) => (String(k).startsWith("day:") && v && v.entries ? v.entries.filter((e) => !e.del) : [])));
    };
  }));
  async function estimateTyped(words) {
    await page.goto("http://localhost:8774/#/add");
    await page.fill("#foodText", words);
    await page.click('[data-act="estimate"]');
    await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  }
  async function save() {
    await page.click('[data-act="saveEntry"]');
    await page.waitForFunction(() => !document.querySelector('[data-act="saveEntry"]'));
  }

  await page.goto("http://localhost:8774/#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();

  // --- first meal from a photo; he fixes the asada by hand to 210 ---
  next = { title: "Asada and kiwis", confidence: "medium", note: "", shots: [],
    items: [item("Carne asada, cut up", "small pieces (85 g)", 190, 22), item("Golden kiwi", "2 medium (180 g)", 115, 2)] };
  await page.goto("http://localhost:8774/#/add");
  await page.setInputFiles("#photoIn", { name: "IMG_1.jpg", mimeType: "image/jpeg", buffer: fs.readFileSync(IMGS[0]), lastModified: Date.now() - 86400e3 });
  await page.waitForSelector(".picks div");
  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  const first = asks[asks.length - 1];
  ok(!/Foods he has logged before \(/.test(first.system), "a first-ever estimate has no food list");
  ok(/base that item on the listed one/.test(first.system) && /all by the same factor/.test(first.system), "the prompt says to scale a known food's numbers by one factor");
  ok(first.cache_control && first.cache_control.type === "ephemeral", "the estimate call caches its long prompt");
  const itemSchema = first.output_config.format.schema.properties.items.items;
  ok(itemSchema.required.includes("from") && itemSchema.properties.from.type === "string", "each item says which known food it was based on");
  ok(!(await text()).includes("like your"), "items from a fresh guess show no 'like your'");
  await page.fill('input[data-bind="itemNum"][data-i="0"][data-k="calories"]', "210");
  await page.locator('input[data-bind="itemNum"][data-i="0"][data-k="calories"]').blur();
  await save();

  // --- a meal he deletes later: its foods must not be offered ---
  next = { title: "Mystery stew", confidence: "low", note: "", shots: [], items: [item("Mystery stew", "1 bowl", 500, 30)] };
  await estimateTyped("mystery stew");
  await save();
  await page.goto("http://localhost:8774/#/");
  await page.click('.entry:has-text("Mystery stew")');
  await page.waitForSelector('[data-act="deleteEntry"]');
  await page.click('[data-act="deleteEntry"]');
  await page.waitForFunction(() => !document.querySelector('[data-act="deleteEntry"]'));

  // --- next estimate gets every food with the numbers he kept ---
  next = { title: "Kiwis and yogurt", confidence: "medium", note: "", shots: [],
    items: [item("Golden kiwi", "3 medium (270 g), 1.5x the usual", 173, 3, "Golden kiwi"), item("Greek yogurt", "1 cup", 150, 20, "")] };
  await estimateTyped("3 kiwis and a yogurt");
  const sys = asks[asks.length - 1].system;
  ok(/Foods he has logged before \(/.test(sys), "the estimate lists the foods he has logged", sys.slice(-500));
  ok(/- Carne asada, cut up: small pieces \(85 g\) = 210 cal, 22 g protein/.test(sys), "the asada carries his hand-fixed 210, with its portion", sys.slice(-500));
  ok(/- Golden kiwi: 2 medium \(180 g\) = 115 cal.*\(in Asada and kiwis, last \d{4}-\d{2}-\d{2}\)/.test(sys), "the kiwi says which meal it came from and when", sys.slice(-500));
  ok(!/Mystery stew:/.test(sys), "a deleted meal's foods are left out", sys.slice(-500));
  ok(/^- Golden kiwi/m.test(sys) && (sys.match(/^- Golden kiwi:/gm) || []).length === 1, "one line per food");

  // --- Check it shows which items came from his log, and the entry keeps it ---
  const t = await text();
  ok(t.includes("like your Golden kiwi"), "the kiwi item shows 'like your Golden kiwi'", t.slice(0, 400));
  ok((t.match(/like your/g) || []).length === 1, "the new yogurt shows nothing");
  await page.screenshot({ path: path.join(__dirname, "library.png") });
  await save();
  const kept = (await entries()).find((e) => e.title === "Kiwis and yogurt");
  ok(kept && kept.items[0].from === "Golden kiwi" && kept.items[1].from === "", "the saved entry keeps where each item came from", JSON.stringify(kept && kept.items));

  // --- foods inside a saved meal are offered too ---
  await page.goto("http://localhost:8774/#/");
  await page.click('.entry:has-text("Kiwis and yogurt")');
  await page.waitForSelector('[data-act="saveEntry"]');
  await page.check('input[data-bind="saveFav"]');
  await save();
  next = { title: "Yogurt", confidence: "high", note: "", shots: [], items: [item("Greek yogurt", "1 cup", 150, 20, "Greek yogurt")] };
  await estimateTyped("yogurt");
  const sys2 = asks[asks.length - 1].system;
  ok(/- Kiwis and yogurt \(Golden kiwi, Greek yogurt\): .*\[Golden kiwi 3 medium \(270 g\), 1\.5x the usual 173 cal; Greek yogurt 1 cup 150 cal\]/.test(sys2), "a saved meal lists the foods inside it", sys2.slice(sys2.indexOf("Saved meals:"), sys2.indexOf("Saved meals:") + 1400));
  ok(/- Golden kiwi: 3 medium \(270 g\), 1\.5x the usual = 173 cal.*2 times/.test(sys2), "a food logged twice keeps its latest numbers and the count", sys2.slice(-600));

  ok(errors.length === 0, "no page errors", errors);
  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
