// Headless test of fixing a meal's numbers by hand: an item's own calories, or calories typed straight in (+100 for the oil).
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
}).listen(8773);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
let n = 0, oneItem = false;
async function fakeClaude(route) {
  const req = route.request();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  n++;
  const tacos = { name: "Street tacos", portion: "3 tacos (300 g)", calories: 600, protein: 40, carbs: 50, fat: 25, fiber: 6 };
  const horchata = { name: "Horchata", portion: "16 oz (480 g)", calories: 400, protein: 4, carbs: 80, fat: 6, fiber: 0 };
  const est = { title: "Tacos and horchata", items: oneItem ? [horchata] : [tacos, horchata], confidence: "high", note: "" };
  return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
    id: "msg_" + n, type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(est) }], usage: { input_tokens: 1500, output_tokens: 200 } }) });
}

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.anthropic.com/**", fakeClaude);
  await page.route("https://api.github.com/**", (r) => r.abort());
  const text = () => page.locator("#view").innerText();
  const cal = () => page.inputValue('input[data-bind="tot"][data-k="cal"]');

  const tot = (k) => page.inputValue(`input[data-bind="tot"][data-k="${k}"]`);
  const calIs = (v) => page.waitForFunction((v) => document.querySelector('input[data-bind="tot"][data-k="cal"]')?.value === v, v, { timeout: 5000 }).then(() => true, () => false);
  const itemCal = (i) => `input[data-bind="itemNum"][data-i="${i}"][data-k="calories"]`;

  await page.goto("http://localhost:8773/#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();

  await page.goto("http://localhost:8773/#/add");
  await page.setInputFiles("#photoIn", IMGS[0]);
  await page.waitForSelector(".picks div");
  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  ok((await cal()) === "1000", "estimate lands at 1,000");

  // the horchata was really 300, not 400
  await page.fill(itemCal(1), "300");
  ok(await calIs("900") && (await page.locator('[data-act="saveEntry"]').innerText()).includes("900"), "horchata typed to 300: total 900, save button follows");
  ok((await page.inputValue(itemCal(1))) === "300", "the field keeps what he typed (no re-render under his thumb)");
  await page.fill('input[data-bind="itemNum"][data-i="0"][data-k="protein"]', "50");
  ok((await tot("p")) === "54", "taco protein typed to 50: 54 g total", await tot("p"));
  await page.click('[data-act="itemAmt"][data-i="1"][data-v="0.5"]');
  ok(await calIs("750") && (await page.inputValue(itemCal(1))) === "150", "half of the 300 horchata: item 150, total 750");
  await page.fill(itemCal(1), "100");
  ok(await calIs("700"), "typing his half as 100: 700");
  await page.click('[data-act="itemAmt"][data-i="1"][data-v="1"]');
  ok(await calIs("800") && (await page.inputValue(itemCal(1))) === "200", "back to the whole horchata: 200 (his 100 was the half)");

  // calories straight in
  await page.click('[data-act="quickCal"][data-v="100"]');
  ok(await calIs("900"), "+100 quick button: 900");
  await page.click('[data-act="quickCal"][data-v="100"]');
  ok(await calIs("1000") && (await page.locator('[data-act="dropAdd"]').count()) === 1, "a second +100 piles into the same line");
  await page.click('[data-act="quickCal"][data-v="-100"]');
  ok(await calIs("900"), "−100 takes it back off");
  await page.fill("#addName", "Olive oil");
  await page.fill("#addCal", "120");
  await page.click('[data-act="addCal"][data-sign="1"]');
  ok(await calIs("1020") && (await text()).includes("Olive oil"), "typed 120 cal of olive oil: 1,020", await cal());
  await page.fill("#addCal", "50");
  await page.fill("#addP", "5");
  await page.click('[data-act="addCal"][data-sign="-1"]');
  ok(await calIs("970") && (await tot("p")) === "49", "take off 50 cal / 5 g: 970 and 49 g", await tot("p"));
  await page.locator(".item >> nth=0").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(__dirname, "addcal.png"), fullPage: true });
  await page.click('[data-act="saveEntry"]');
  await page.waitForFunction(() => document.querySelector(".entry")?.innerText.includes("970"));
  ok(true, "saved at 970 on Today");

  // reopen: the hand-typed numbers stick
  await page.click(".entry");
  await page.waitForSelector('[data-act="dropAdd"]');
  ok((await cal()) === "970" && (await page.inputValue(itemCal(1))) === "200" && (await page.locator('[data-act="dropAdd"]').count()) === 3, "reopened at 970 with item and typed lines intact");
  await page.click('[data-act="dropAdd"][data-i="1"]');
  ok(await calIs("850"), "removing the olive oil: 850");
  await page.fill('input[data-bind="tot"][data-k="cal"]', "600");
  await page.click('[data-act="quickCal"][data-v="50"]');
  ok(await calIs("650"), "a typed total stays a total: 600 then +50 = 650");
  await page.click('[data-act="saveEntry"]');
  await page.waitForFunction(() => document.querySelector(".entry")?.innerText.includes("650"));

  // typing the numbers myself, then adding on top; reopening doesn't double-count
  await page.goto("http://localhost:8773/#/add");
  await page.fill("#foodText", "burrito");
  await page.click('[data-act="manual"]');
  await page.waitForSelector('[data-act="saveEntry"]');
  await page.fill('input[data-bind="tot"][data-k="cal"]', "700");
  await page.click('[data-act="quickCal"][data-v="200"]');
  ok(await calIs("900"), "typed 700, +200: 900");
  await page.click('[data-act="saveEntry"]');
  await page.waitForFunction(() => [...document.querySelectorAll(".entry")].some((e) => e.innerText.includes("900")));
  await page.locator(".entry", { hasText: "900" }).click();
  await page.waitForSelector('[data-act="dropAdd"]');
  await page.click('[data-act="servings"][data-v="1"]');
  ok(await calIs("900"), "reopened and recomputed: 900, the +200 not counted twice", await cal());
  await page.click('[data-act="dropAdd"][data-i="0"]');
  ok(await calIs("700"), "dropping the +200: back to 700");

  ok(errors.length === 0, "no page errors", errors);
  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
