// Headless test of logging food to another day: the Day buttons on Log food and Edit, moving an entry between days,
// and a time that hasn't happened yet today going to yesterday.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("C:/Users/Perry/hyperframes-student-kit/node_modules/playwright");
const DOCS = "C:/Users/Perry/plate/docs";

const server = http.createServer((req, res) => {
  const p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
}).listen(8773);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
const TODAY = "2026-10-29", YDAY = "2026-10-28", TWO_AGO = "2026-10-27";

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(2026, 9, 29, 14, 0));   // 2 PM on the 29th, local time
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.anthropic.com/**", (r) => r.abort());
  await page.route("https://api.github.com/**", (r) => r.abort());
  const text = () => page.locator("#view").innerText();
  const days = () => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open("plate");
    r.onsuccess = () => {
      const db = r.result, names = [...db.objectStoreNames];
      const tx = db.transaction(names[0]), st = tx.objectStore(names[0]), all = st.getAll(), keys = st.getAllKeys();
      tx.oncomplete = () => res(Object.fromEntries(all.result.map((v, i) => [keys.result[i], v]).filter(([k]) => String(k).startsWith("day:"))
        .map(([k, v]) => [k.slice(4), v.entries])));
    };
  }));
  const live = (d, date) => (d[date] || []).filter((e) => !e.del);
  const dayOn = () => page.locator('.seg[aria-label="Which day"] .on').innerText();
  async function typed(food, cal) {
    await page.fill("#foodText", food);
    await page.click('[data-act="manual"]');
    await page.waitForSelector('[data-act="saveEntry"]');
    await page.fill('input[data-bind="tot"][data-k="cal"]', String(cal));
  }
  async function save() {
    await page.click('[data-act="saveEntry"]');
    await page.waitForFunction(() => !document.querySelector('[data-act="saveEntry"]'));
  }

  // --- Log food → Yesterday, before typing anything ---
  await page.goto("http://localhost:8773/#/add");
  await page.waitForSelector('[data-act="addDay"]');
  ok((await dayOn()) === "Today", "Log food starts on today");
  await page.fill("#foodText", "eggs and toast");
  await page.click(`[data-act="addDay"][data-v="${YDAY}"]`);
  await page.waitForFunction((y) => location.hash === "#/add/" + y, YDAY);
  ok((await dayOn()) === "Yesterday", "the Yesterday button switches Log food to yesterday");
  ok((await page.locator("#foodText").inputValue()) === "eggs and toast", "what he typed comes along to the other day");
  await page.click('[data-act="manual"]');
  await page.waitForSelector('[data-act="saveEntry"]');
  ok((await dayOn()) === "Yesterday", "Check it shows the day it's going to");
  await page.fill('input[data-bind="tot"][data-k="cal"]', "400");
  await save();
  let d = await days();
  ok(live(d, YDAY).some((e) => e.title === "eggs and toast" && e.cal === 400) && !live(d, TODAY).length, "it's saved to yesterday, not today", JSON.stringify(d));

  // --- a time later than now goes to last night ---
  await page.goto("http://localhost:8773/#/add");
  await typed("late night bowl", 650);
  await page.fill('input[data-bind="time"]', "21:30");
  await page.waitForFunction(() => document.querySelector('.seg[aria-label="Which day"] .on')?.textContent === "Yesterday");
  ok((await text()).includes("hasn't happened yet today"), "it says why it moved to yesterday");
  ok((await page.locator('input[data-bind="time"]').inputValue()) === "21:30", "the time he picked stays");
  await save();
  d = await days();
  ok(live(d, YDAY).some((e) => e.title === "late night bowl" && e.time === "21:30"), "the 9:30 PM meal is on yesterday");

  // a time earlier today stays today
  await page.goto("http://localhost:8773/#/add");
  await typed("lunch", 700);
  await page.fill('input[data-bind="time"]', "12:15");
  await page.waitForTimeout(200);
  ok((await dayOn()) === "Today", "a time earlier today stays on today");
  await save();

  // --- edit an entry and move it to another day ---
  await page.goto("http://localhost:8773/#/day/" + YDAY);
  await page.click('.entry:has-text("late night bowl")');
  await page.waitForSelector('[data-act="saveEntry"]');
  ok((await dayOn()) === "Yesterday", "editing shows the day the entry is on");
  await page.click(`[data-act="draftDay"][data-v="${TODAY}"]`);
  await page.waitForFunction(() => document.querySelector('.seg[aria-label="Which day"] .on')?.textContent === "Today");
  await page.fill('input[data-bind="time"]', "13:00");
  await save();
  d = await days();
  const moved = live(d, TODAY).filter((e) => e.title === "late night bowl");
  ok(moved.length === 1 && moved[0].cal === 650, "the entry is on today now", JSON.stringify(live(d, TODAY)));
  ok(!live(d, YDAY).some((e) => e.title === "late night bowl") && (d[YDAY] || []).some((e) => e.title === "late night bowl" && e.del), "and gone from yesterday (left as a tombstone for the backup)");
  ok(live(d, YDAY).some((e) => e.title === "eggs and toast"), "yesterday's other food is untouched");

  // --- Other day: two days ago through the date field ---
  await page.goto("http://localhost:8773/#/");
  await page.click('.entry:has-text("lunch")');
  await page.waitForSelector('[data-act="saveEntry"]');
  await page.fill('input[data-pickday="draftDay"]', TWO_AGO);
  await page.waitForFunction(() => document.querySelector('.seg[aria-label="Which day"] .on')?.textContent.includes("27"));
  await save();
  d = await days();
  ok(live(d, TWO_AGO).some((e) => e.title === "lunch") && !live(d, TODAY).some((e) => e.title === "lunch"), "the date field moves it to any earlier day");

  // --- deleting a moved entry deletes it where it was ---
  await page.goto("http://localhost:8773/#/day/" + TWO_AGO);
  await page.click('.entry:has-text("lunch")');
  await page.waitForSelector('[data-act="deleteEntry"]');
  await page.click(`[data-act="draftDay"][data-v="${TODAY}"]`);
  await page.waitForSelector('[data-act="deleteEntry"]');
  await page.click('[data-act="deleteEntry"]');
  await page.waitForFunction(() => !document.querySelector('[data-act="deleteEntry"]'));
  d = await days();
  ok(!live(d, TWO_AGO).some((e) => e.title === "lunch") && !live(d, TODAY).some((e) => e.title === "lunch"), "Delete after picking a new day still deletes the entry");

  await page.goto("http://localhost:8773/#/add");
  await page.waitForSelector('[data-act="addDay"]');
  await page.screenshot({ path: path.join(__dirname, "days.png") });

  ok(errors.length === 0, "no page errors", errors);
  console.log(`${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
