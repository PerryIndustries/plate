// Headless test of changing how much of one item in a logged meal he had (half the horchata, all of the tacos).
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

  await page.goto("http://localhost:8772/#/settings");
  await page.fill('input[data-set="apiKey"]', "sk-ant-test");
  await page.locator('input[data-set="apiKey"]').blur();

  await page.goto("http://localhost:8772/#/add");
  await page.setInputFiles("#photoIn", IMGS[0]);
  await page.waitForSelector(".picks div");
  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  ok(await page.locator(".seg.mini").count() === 2, "each item of a two-item meal gets its own amount");
  await page.click('[data-act="saveEntry"]');
  await page.waitForSelector(".entry");
  ok((await page.locator(".entry").innerText()).includes("1,000"), "logged at 1,000 cal", await page.locator(".entry").innerText());

  // later: only half the horchata
  await page.click(".entry");
  await page.waitForSelector('[data-act="itemAmt"]');
  ok(page.url().endsWith("#/edit") && (await cal()) === "1000", "tapping the entry opens it with its saved numbers");
  await page.click('[data-act="itemAmt"][data-i="1"][data-v="0.5"]');
  await page.waitForSelector('[data-act="itemAmt"][data-i="1"][data-v="0.5"].on');
  ok((await cal()) === "800" && (await page.inputValue('input[data-bind="tot"][data-k="p"]')) === "42", "half the horchata: 800 cal, 42 g protein");
  const rows = await page.locator(".item").allInnerTexts();
  ok(rows[1].includes("½× 16 oz") && rows[1].includes("200 cal") && rows[0].includes("600 cal"), "the item line shows its share", rows);
  ok((await page.locator('[data-act="saveEntry"]').innerText()).includes("800 cal"), "save button follows");
  await page.locator(".item >> nth=0").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(__dirname, "items.png") });
  await page.click('[data-act="saveEntry"]');
  await page.waitForFunction(() => document.querySelector(".entry")?.innerText.includes("800"));
  ok((await page.locator("#toastText").innerText()).includes("800 cal"), "saved at 800 on Today");

  // reopen: the half is remembered, and the whole-meal amount still scales on top
  await page.click(".entry");
  await page.waitForSelector('[data-act="itemAmt"][data-i="1"][data-v="0.5"].on');
  ok((await cal()) === "800", "reopened at 800 with the half still picked");
  await page.click('[data-act="servings"][data-v="2"]');
  await page.waitForFunction(() => document.querySelector('input[data-bind="tot"][data-k="cal"]').value === "1600");
  ok(true, "whole meal 2x on top of the half: 1,600");
  await page.click('[data-act="servings"][data-v="1"]');
  await page.click('[data-act="itemAmt"][data-i="0"][data-v="1.5"]');
  await page.waitForFunction(() => document.querySelector('input[data-bind="tot"][data-k="cal"]').value === "1100");
  ok(true, "1½ tacos + ½ horchata: 1,100");
  await page.click('[data-act="cancel"]');
  await page.waitForSelector(".entry");
  ok((await page.locator(".entry").innerText()).includes("800"), "cancel keeps the saved 800");

  // a one-item meal keeps the single whole-meal amount, no per-item row
  oneItem = true;
  await page.goto("http://localhost:8772/#/add");
  await page.setInputFiles("#photoIn", IMGS[1 % IMGS.length]);
  await page.waitForSelector(".picks div");
  await page.click('[data-act="estimate"]');
  await page.waitForSelector('[data-act="saveEntry"]', { timeout: 30000 });
  ok(await page.locator(".seg.mini").count() === 0 && (await text()).includes("How much of it did you eat?"), "one item: just the meal amount");

  ok(errors.length === 0, "no page errors", errors);
  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
