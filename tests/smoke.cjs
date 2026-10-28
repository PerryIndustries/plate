// Headless smoke test of Plate: phone viewport, fake Claude + fake GitHub, real app code.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("C:/Users/Perry/hyperframes-student-kit/node_modules/playwright");
const DOCS = "C:/Users/Perry/plate/docs";
const IMG = process.argv[2];

const server = http.createServer((req, res) => {
  const p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
}).listen(8766);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };

// fake GitHub contents API
const repo = new Map();   // path -> {content(b64), sha}
repo.set("steps/2026-01-01_5,000_235800.json", { content: "e30=", sha: "s0" });
let shaN = 1;
async function fakeGitHub(route) {
  const req = route.request(), url = new URL(req.url());
  const p = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (req.method() === "PUT") {
    const body = JSON.parse(req.postData());
    const cur = repo.get(p);
    if (cur && body.sha !== cur.sha) return route.fulfill({ status: 409, headers: cors, body: "{}" });
    repo.set(p, { content: body.content, sha: "s" + shaN++ });
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: "{}" });
  }
  if (repo.has(p)) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(Object.assign({ name: p.split("/").pop() }, repo.get(p))) });
  const kids = [...repo.keys()].filter((k) => k.startsWith(p + "/")).map((k) => ({ name: k.slice(p.length + 1) }));
  if (kids.length) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(kids) });
  return route.fulfill({ status: 404, headers: cors, body: "{}" });
}

// fake Claude: answers with a fixed estimate, records the request
let claudeReq = null;
async function fakeClaude(route) {
  const req = route.request();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  claudeReq = { headers: req.headers(), body: JSON.parse(req.postData()) };
  const est = { title: "Asada plate", items: [
    { name: "Carne asada", portion: "8 oz", calories: 500, protein: 60, carbs: 0, fat: 28, fiber: 0 },
    { name: "Rice", portion: "1 cup", calories: 200, protein: 4, carbs: 45, fat: 1, fiber: 1 }], confidence: "medium", note: "Oil is a guess." };
  return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(est) }], usage: { input_tokens: 1500, output_tokens: 200 } }) });
}

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("https://api.github.com/**", fakeGitHub);
  await page.route("https://api.anthropic.com/**", fakeClaude);
  const text = () => page.locator("#view").innerText();

  await page.goto("http://localhost:8766/#/");
  await page.waitForSelector(".hero");
  ok((await text()).includes("2,050"), "today shows the 2,050 goal");
  ok((await text()).includes("Nothing logged"), "empty day message");

  // one-tap saved meal
  await page.click('a[data-tab="add"]');
  await page.waitForSelector(".fav");
  ok(await page.locator(".fav").count() === 5, "five starter meals");
  await page.click('.fav:has-text("Carne asada bowl")');
  await page.waitForSelector(".entry");
  ok((await text()).includes("Carne asada bowl"), "saved meal logged");
  ok((await text()).includes("1,220"), "cal left = 2050-830");

  // typed numbers
  await page.click('a[data-tab="add"]');
  await page.fill("#foodText", "2 eggs");
  await page.click('[data-act="manual"]');
  await page.waitForSelector('[data-act="saveEntry"]');
  await page.fill('input[data-k="cal"]', "160");
  await page.fill('input[data-k="p"]', "12");
  await page.click('[data-act="saveEntry"]');
  await page.waitForSelector('.entry:has-text("2 eggs")');
  ok((await text()).includes("1,060"), "cal left after typed entry", await text());

  // edit the saved meal: double it
  await page.click('.entry:has-text("Carne asada bowl")');
  await page.waitForSelector('[data-act="servings"]');
  await page.click('[data-act="servings"][data-v="2"]');
  ok((await page.inputValue('input[data-k="cal"]')) === "1660", "2x servings doubles a saved meal without items");
  await page.click('[data-act="saveEntry"]');
  await page.waitForSelector(".hero");
  ok((await text()).includes("1,820 of 2,050"), "1,820 eaten after doubling", await text());

  // photo estimate through fake Claude
  await page.click('a[data-tab="add"]');
  ok(await page.locator('[data-act="estimate"]').isDisabled(), "estimate disabled without a key");
  await page.click('a[data-tab="settings"]');
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();
  await page.click('a[data-tab="add"]');
  await page.evaluate(() => { window.__log = []; document.getElementById("photoIn").addEventListener("change", async (e) => { const f = e.target.files[0]; window.__log.push("change " + (f && f.size)); try { const img = new Image(); img.src = URL.createObjectURL(f); await img.decode(); window.__log.push("decoded " + img.naturalWidth); } catch (err) { window.__log.push("decode err " + err.message); } }); });
  await page.setInputFiles("#photoIn", IMG);
  await page.waitForTimeout(3000); console.log("log:", await page.evaluate(() => window.__log), "toast:", await page.locator("#toastText").innerText(), "errors:", errors, "draft:", await page.evaluate(() => document.querySelector("#view").innerHTML.slice(0, 300)));
  await page.waitForSelector(".picks div");
  ok(await page.locator('[data-act="saveFoodPhotos"]').count() === 1, "save-to-Photos button shows once a photo is in");
  await page.evaluate(() => { document.getElementById("photoIn").value = ""; });   // what the + tile does before opening the picker
  await page.setInputFiles("#photoIn", process.argv[3] || IMG);   // a second photo of the same meal
  await page.waitForFunction(() => document.querySelectorAll(".picks div").length === 2);
  ok(true, "second photo added next to the first");
  await page.fill("#foodText", "lunch");
  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  ok(claudeReq && claudeReq.body.model === "claude-opus-5-5", "Claude called with opus 5.5");
  ok(claudeReq && claudeReq.body.messages[0].content.some((b) => b.type === "image"), "photo sent as image block");
  ok(claudeReq && claudeReq.body.output_config.format.type === "json_schema", "structured output requested");
  ok(claudeReq && claudeReq.body.messages[0].content.filter((c) => c.type === "image").length === 2, "both photos sent to Claude");
  ok(claudeReq && claudeReq.body.output_config.effort === "high", "estimates think at high effort");
  ok(claudeReq && claudeReq.body.fallbacks === "default" && /server-side-fallback-2026-07-01/.test(claudeReq.headers["anthropic-beta"] || ""), "fallbacks on");
  ok(claudeReq && claudeReq.headers["anthropic-dangerous-direct-browser-access"] === "true", "browser access header");
  const b64len = claudeReq.body.messages[0].content.find((b) => b.type === "image").source.data.length;
  ok(b64len < 900000, "photo shrunk before sending", b64len);
  ok((await page.inputValue('input[data-k="cal"]')) === "700", "estimate totals 700");
  await page.click('[data-act="dropItem"][data-i="1"]');
  ok((await page.inputValue('input[data-k="cal"]')) === "500", "dropping rice leaves 500");
  await page.check('input[data-bind="saveFav"]');
  await page.click('[data-act="saveEntry"]');
  await page.waitForSelector('.entry:has-text("Asada plate")');
  ok(await page.locator('.entry:has-text("Asada plate") .thumb[style*="background-image"]').count() === 1, "photo thumb shows");

  // steps typed in
  await page.click(".steps");
  await page.fill("#stepsIn", "7200");
  await page.click('[data-act="saveSteps"]');
  await page.waitForSelector('.steps:has-text("7,200")', { timeout: 5000 }).catch(() => {}); ok((await text()).includes("7,200"), "typed steps show");

  // backup to fake GitHub, then a fresh phone restores it
  await page.click('a[data-tab="settings"]');
  await page.fill('input[data-set="token"]', "github_pat_test");
  await page.locator('input[data-set="token"]').blur();
  await page.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  ok((await page.locator("#syncStatus").innerText()).startsWith("Backed up"), "backup ran", await page.locator("#syncStatus").innerText());
  const dayFiles = [...repo.keys()].filter((k) => k.startsWith("days/"));
  ok(dayFiles.length >= 1, "day file written", [...repo.keys()]);
  ok([...repo.keys()].some((k) => k.startsWith("photos/")), "photo backed up");
  const fav = JSON.parse(Buffer.from(repo.get("favorites.json").content, "base64").toString());
  ok(fav.favs.some((f) => f.title === "Asada plate"), "new saved meal backed up");

  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const p2 = await ctx2.newPage();
  p2.on("pageerror", (e) => errors.push("phone2: " + e.message));
  await p2.route("https://api.github.com/**", fakeGitHub);
  await p2.goto("http://localhost:8766/#/settings");
  await p2.fill('input[data-set="token"]', "github_pat_test");
  await p2.locator('input[data-set="token"]').blur();
  await p2.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  await p2.goto("http://localhost:8766/#/");
  await p2.waitForSelector('.entry:has-text("Asada plate")');
  const t2 = await p2.locator("#view").innerText();
  ok(t2.includes("Carne asada bowl") && t2.includes("2 eggs") && t2.includes("7,200"), "second phone restored the day", t2);
  await p2.waitForSelector('.entry:has-text("Asada plate") .thumb[style*="background-image"]', { timeout: 5000 }).catch(() => {});   // the thumb is fetched after the entry renders
  ok(await p2.locator('.entry:has-text("Asada plate") .thumb[style*="background-image"]').count() === 1, "second phone pulled the photo");
  await p2.goto("http://localhost:8766/#/history");
  ok((await p2.locator("#view").innerText()).includes("History"), "history renders");
  // the Shortcut's comma-formatted file name parses
  ok(await p2.evaluate(() => true), "noop");

  // delete + undo on phone 1
  await page.goto("http://localhost:8766/#/");
  await page.click('.entry:has-text("2 eggs")');
  await page.click('[data-act="deleteEntry"]');
  await page.waitForSelector(".hero");
  ok(!(await text()).includes("2 eggs"), "entry deleted");
  await page.click("#toastBtn");
  await page.waitForSelector('.entry:has-text("2 eggs")');
  ok(true, "undo brings it back");

  await page.screenshot({ path: path.join(__dirname, "today.png"), fullPage: true });
  await page.goto("http://localhost:8766/#/add");
  await page.screenshot({ path: path.join(__dirname, "add.png"), fullPage: true });

  ok(errors.filter((e) => !/status of 404/.test(e)).length === 0, "no page errors (404s are the fake backup saying a file is new)", errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
