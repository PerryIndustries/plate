// Headless test of Plate's workout log: seeded split, logger, draft survival, progression nudge, rest timer, history, templates, backup + merge.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("C:/Users/Perry/hyperframes-student-kit/node_modules/playwright");
const DOCS = "C:/Users/Perry/plate/docs";
const URL0 = "http://localhost:8768/";

const server = http.createServer((req, res) => {
  const p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" }[path.extname(p)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
}).listen(8768);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
const repo = new Map();
let shaN = 1, holdPut = null;   // holdPut: { path, arrived(), gate }: the next PUT to that path signals arrived() and waits for gate before it lands (one-shot)
async function fakeGitHub(route) {
  const req = route.request(), url = new URL(req.url());
  const p = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (req.method() === "PUT") {
    if (holdPut && p === holdPut.path) { const hp = holdPut; holdPut = null; hp.arrived(); await hp.gate; }
    const body = JSON.parse(req.postData()), cur = repo.get(p);
    if (cur && body.sha !== cur.sha) return route.fulfill({ status: 409, headers: cors, body: "{}" });
    repo.set(p, { content: body.content, sha: "s" + shaN++ });
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: "{}" });
  }
  if (repo.has(p)) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(Object.assign({ name: p.split("/").pop() }, repo.get(p))) });
  const kids = [...repo.keys()].filter((k) => k.startsWith(p + "/")).map((k) => ({ name: k.slice(p.length + 1) }));
  if (kids.length) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(kids) });
  return route.fulfill({ status: 404, headers: cors, body: "{}" });
}
const readJson = (k) => JSON.parse(Buffer.from(repo.get(k).content, "base64").toString());
const secs = (mmss) => { const [m, s] = mmss.split(":").map(Number); return m * 60 + s; };
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 100)); } return true; };

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const errors = [];
  const mk = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    if (opts.clock) await page.clock.install();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.route("https://api.github.com/**", fakeGitHub);
    await page.route("https://api.anthropic.com/**", (r) => r.abort());
    return page;
  };
  const page = await mk();
  const text = () => page.locator("#view").innerText();
  const inp = (k, i, j) => `input[data-wb="${k}"][data-i="${i}"][data-j="${j}"]`;
  const tick = (i, j) => page.click(`[data-act="tick"][data-i="${i}"][data-j="${j}"]`);

  // seeded split + Today card
  await page.goto(URL0 + "#/");
  await page.waitForSelector(".hero");
  ok((await text()).includes("Start Upper A"), "today suggests Upper A first", await text());
  await page.goto(URL0 + "#/lift/templates");
  await page.waitForSelector(".tpl");
  ok(await page.locator(".tpl").count() === 4, "four sessions seeded");
  const exCounts = await page.evaluate(() => [...document.querySelectorAll(".tpl")].map((t) => t.querySelectorAll('[data-tb="name"]').length));
  ok(exCounts.join() === "7,6,7,6", "7/6/7/6 exercises in split order", exCounts);
  await page.goto(URL0 + "#/lift");
  await page.waitForSelector("h1");
  ok((await text()).includes("Start Upper A") && (await text()).includes("Edit sessions"), "lift hub shows next session and links");
  await page.goto(URL0 + "#/add");
  await page.waitForSelector('a[href="#/lift"]');
  ok(true, "add screen links to Start workout");

  // start Upper A from Today
  await page.goto(URL0 + "#/");
  await page.waitForSelector('[data-act="startW"]');
  await page.click('[data-act="startW"]');
  await page.waitForSelector(".ex");
  ok(await page.locator(".ex").count() === 7, "logger shows all 7 exercises");
  const ex0 = await page.locator(".ex").nth(0).innerText();
  ok(ex0.includes("Incline DB press") && ex0.includes("3 × 6-10") && ex0.includes("First time"), "first card: name, target, no history yet", ex0);
  ok(await page.locator(`.ex >> nth=0 >> .setrow`).count() === 3, "3 set rows");
  ok((await page.inputValue(inp("w", 0, 0))) === "", "weight empty without history");
  const box = await page.locator('[data-act="tick"]').first().boundingBox();
  ok(box.height >= 48 && box.width >= 48, "tick target is at least 48px", box);
  ok(await page.locator("#rest").isHidden(), "no rest bar before any set");

  // log sets with ✓
  for (let j = 0; j < 3; j++) { await page.fill(inp("w", 0, j), "35"); await page.fill(inp("r", 0, j), "10"); await tick(0, j); }
  ok(await page.locator("#rest").isVisible(), "rest bar appears after ✓");
  const left0 = await page.locator("#restLeft").innerText();
  ok(/^2:(2|3)\d$/.test(left0), "compound rest starts at 2:30", left0);
  for (let j = 0; j < 3; j++) { await page.fill(inp("w", 1, j), "135"); await page.fill(inp("r", 1, j), "10"); await tick(1, j); }
  const tickedAt = Date.now();
  ok(await page.locator(".setrow.done").count() === 6, "six sets checked");
  ok((await page.locator("#finishW").innerText()).includes("6 sets"), "finish button counts sets");
  await tick(1, 2);
  ok(await page.locator(".setrow.done").count() === 5, "tapping ✓ again undoes a set");
  await tick(1, 2);
  await page.fill('textarea[data-wb="note"]', "felt strong");
  // the app goes to the background right away: the debounced note is written at once (well inside the 300 ms debounce)
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(80);

  // the draft, including the rest end time, survives a reload
  await page.reload();
  await page.waitForSelector(".ex");
  ok(await page.locator(".ex").count() === 7 && await page.locator(".setrow.done").count() === 6, "draft survives reload");
  ok((await page.inputValue('textarea[data-wb="note"]')) === "felt strong" && (await page.inputValue(inp("w", 1, 2))) === "135", "typed values survive reload");
  ok(await page.locator("#rest").isVisible(), "rest bar back after reload");
  const left1 = secs(await page.locator("#restLeft").innerText()), gone = Math.floor((Date.now() - tickedAt) / 1000);
  ok(left1 <= 150 - gone + 1 && left1 >= 150 - gone - 3, "rest is computed from the stored end time, not a restarted counter", { left1, gone });
  await page.click('[data-act="restAdd"]');
  const left2 = secs(await page.locator("#restLeft").innerText());
  ok(left2 >= left1 + 28 && left2 <= left1 + 31, "+30 s adds thirty seconds", { left1, left2 });
  await page.click('[data-act="restSkip"]');
  ok(await page.locator("#rest").isHidden(), "skip hides the bar");
  await page.goto(URL0 + "#/");
  await page.waitForSelector(".hero");
  ok((await text()).includes("Workout in progress") && (await text()).includes("Upper A"), "today shows the workout in progress");
  await page.click('a[href="#/lift/go"]');
  await page.waitForSelector(".ex");

  // finish
  await page.click("#finishW");
  await page.waitForSelector(".hero");
  const t1 = await text();
  ok(t1.includes("Lifted today ✓") && /Upper A · 6 sets/.test(t1), "today shows lifted ✓ with the set count", t1);
  ok(/Upper A done · 6 sets · \d+ min/.test(await page.locator("#toastText").innerText()), "finish toast summary", await page.locator("#toastText").innerText());
  await page.goto(URL0 + "#/lift");
  await page.waitForSelector(".wrow");
  const t2 = await text();
  ok(t2.includes("Start Lower A"), "next session is Lower A", t2);
  ok(/Upper A\s+6 sets · \d+ min/.test(t2), "recent list shows the workout", t2);

  // second Upper A: last time's numbers + progression nudge
  await page.click('.fav:has-text("Upper A")');
  await page.waitForSelector(".ex");
  const a0 = await page.locator(".ex").nth(0).innerText(), a1 = await page.locator(".ex").nth(1).innerText(), a2 = await page.locator(".ex").nth(2).innerText();
  ok(/Last · \w{3} \d+: 35×10, 35×10, 35×10/.test(a0), "last time's numbers shown", a0);
  ok(a0.includes("All sets hit 10 last time → try 40 lb (+5 lb dumbbells)"), "dumbbell nudge +5", a0);
  ok((await page.inputValue(inp("w", 0, 0))) === "40" && (await page.inputValue(inp("w", 0, 2))) === "40", "weight prefilled with the +5", await page.inputValue(inp("w", 0, 0)));
  ok((await page.inputValue(inp("r", 0, 0))) === "6", "reps reset to the bottom of the range after a bump");
  ok(a1.includes("try 145 lb (+10 lb Smith)") && (await page.inputValue(inp("w", 1, 0))) === "145", "Smith nudge +10 and prefilled", a1);
  ok(a2.includes("First time") && !a2.includes("Last ·"), "no history on an exercise not done yet", a2);
  await tick(0, 0);
  await page.screenshot({ path: path.join(__dirname, "lift-logger.png") });   // nudge, last-time line, a done set and the rest bar
  // Edit on a past workout while one is in progress: refused, back to the logger with the draft intact
  await page.goto(URL0 + "#/lift");
  await page.click('.wrow:has-text("Upper A")');
  await page.waitForSelector('[data-act="editW"]');
  await page.click('[data-act="editW"]');
  await page.waitForSelector(".ex");
  ok(page.url().endsWith("#/lift/go") && (await page.locator("#toastText").innerText()).includes("Finish or discard") && !(await text()).includes("editing") && await page.locator(".setrow.done").count() === 1, "Edit on a past workout doesn't replace the workout in progress", await page.locator("#toastText").innerText());
  // discard needs two taps
  await page.click('[data-act="discardW"]');
  ok((await page.locator('[data-act="discardW"]').innerText()).includes("Tap again"), "first discard tap arms");
  ok(await page.locator(".ex").count() === 7, "one tap doesn't discard");
  await page.click('[data-act="discardW"]');
  await page.waitForSelector('h1:has-text("Lift")');
  ok((await text()).includes("Start Lower A") && !(await text()).includes("in progress"), "discarded; Lower A still next");

  // per-exercise history
  await page.goto(URL0 + "#/lift/ex/incline-db-press-30");
  await page.waitForSelector("h1");
  const e1 = await text();
  ok(e1.includes("Incline DB press") && e1.includes("35×10 · 35×10 · 35×10") && e1.includes("1 session"), "exercise history lists the session", e1);
  ok(await page.locator("svg.chart").count() === 1 && await page.locator("svg.chart circle").count() === 1, "inline SVG chart with one point");
  await page.goto(URL0 + "#/lift/ex");
  await page.waitForSelector(".wrow");
  ok((await text()).includes("Smith flat press") && await page.locator(".wrow").count() === 2, "exercise list shows the two keys seen");

  // past workout: view, edit (adds a set), delete + undo
  await page.goto(URL0 + "#/lift");
  await page.click('.wrow:has-text("Upper A")');
  await page.waitForSelector('[data-act="editW"]');
  const w1 = await text();
  ok(w1.includes("6 sets") && w1.includes("135×10 · 135×10 · 135×10") && w1.includes("felt strong"), "workout page shows sets and note", w1);
  const wid = page.url().split("/").pop();
  await page.click('[data-act="editW"]');
  await page.waitForSelector(".ex");
  ok(await page.locator(".setrow.done").count() === 6 && (await text()).includes("editing"), "edit reopens the workout as a draft");
  await page.click('[data-act="addSet"][data-i="0"]');
  await page.waitForSelector(inp("w", 0, 3));
  ok((await page.inputValue(inp("w", 0, 3))) === "35", "added set copies the previous one");
  await page.fill(inp("r", 0, 3), "8");
  await tick(0, 3);
  ok(await page.locator("#rest").isHidden(), "no rest timer while editing a past workout");
  await page.click("#finishW");
  await page.waitForSelector('[data-act="editW"]');
  ok(page.url().endsWith(wid) && (await text()).includes("7 sets") && (await text()).includes("35×10 · 35×10 · 35×10 · 35×8"), "edit saved back to the same workout", await text());
  await page.click('[data-act="deleteW"]');
  await page.waitForSelector('h1:has-text("Lift")');
  ok((await text()).includes("Nothing yet") && (await text()).includes("Start Upper A"), "deleted workout leaves the list; rotation restarts");
  await page.click("#toastBtn");
  await page.waitForSelector('.wrow:has-text("Upper A")');
  ok((await text()).includes("Start Lower A"), "undo brings the workout back");

  // templates: rename, change sets, reorder, add; everything persists
  await page.goto(URL0 + "#/lift/templates");
  await page.waitForSelector(".tpl");
  await page.fill('input[data-tb="tname"][data-t="split0"]', "Upper A push");
  await page.fill('input[data-tb="sets"][data-t="split0"][data-i="0"]', "4");
  await page.click('[data-act="moveEx"][data-t="split1"][data-i="0"][data-d="1"]');
  await page.waitForFunction(() => document.querySelector('input[data-tb="name"][data-t="split1"][data-i="0"]').value === "Leg press");
  await page.click('[data-act="addEx"][data-t="split3"]');
  await page.waitForSelector('input[data-tb="name"][data-t="split3"][data-i="6"]');
  await page.fill('input[data-tb="name"][data-t="split3"][data-i="6"]', "Cable curl");
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector(".tpl");
  ok((await page.inputValue('input[data-tb="tname"][data-t="split0"]')) === "Upper A push" && (await page.inputValue('input[data-tb="sets"][data-t="split0"][data-i="0"]')) === "4", "template rename + sets persist");
  ok((await page.inputValue('input[data-tb="name"][data-t="split1"][data-i="0"]')) === "Leg press" && (await page.inputValue('input[data-tb="name"][data-t="split1"][data-i="1"]')) === "Smith squat", "reorder persists");
  ok((await page.inputValue('input[data-tb="name"][data-t="split3"][data-i="6"]')) === "Cable curl", "added exercise persists");
  await page.goto(URL0 + "#/lift");
  await page.waitForSelector(".wrow");
  await page.click('.fav:has-text("Upper A push")');
  await page.waitForSelector(".ex");
  ok(await page.locator(`.ex >> nth=0 >> .setrow`).count() === 4 && (await page.locator(".ex").nth(0).innerText()).includes("Last ·"), "renamed session starts with 4 sets and keeps the exercise key's history");
  await page.click('[data-act="discardW"]'); await page.click('[data-act="discardW"]');
  await page.waitForSelector('h1:has-text("Lift")');

  // progress profile: lift day on the heatmap + the consistency line
  await page.goto(URL0 + "#/me");
  await page.waitForSelector(".heat");
  const me = await text();
  ok(await page.locator(".heat i.lift").count() === 1, "heatmap marks the lift day");
  ok(me.includes("Lifted 1 time this week · 1 in the last 30 days") && me.includes("lifted"), "consistency line counts lifts", me);
  ok(!/\b135\b|\b35\b/.test(me), "no weights on the profile");
  await page.screenshot({ path: path.join(__dirname, "me-lift.png") });

  // backup: workouts.json with both arrays
  await page.goto(URL0 + "#/settings");
  await page.fill('input[data-set="token"]', "github_pat_test");
  await page.locator('input[data-set="token"]').blur();
  await page.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  ok((await page.locator("#syncStatus").innerText()).startsWith("Backed up"), "backup ran", await page.locator("#syncStatus").innerText());
  ok(repo.has("workouts.json"), "workouts.json written");
  const wj = readJson("workouts.json");
  ok(Array.isArray(wj.templates) && wj.templates.length === 4 && Array.isArray(wj.workouts) && wj.workouts.length === 1, "both arrays backed up", Object.keys(wj));
  ok(wj.templates.find((t) => t.id === "split0").name === "Upper A push" && wj.templates.find((t) => t.id === "split0").u > 0, "edited template backed up with a bumped u");
  ok(wj.workouts[0].name === "Upper A" && wj.workouts[0].endedAt > wj.workouts[0].startedAt && wj.workouts[0].exercises[0].sets.length === 4, "workout shape");

  // a workout logged elsewhere merges back in
  const ago = new Date(Date.now() - 4 * 3600e3 - 3 * 864e5).toISOString().slice(0, 10);
  wj.workouts.push({ id: "remote1", date: ago, templateId: "split3", name: "Lower B", startedAt: Date.now() - 3 * 864e5, endedAt: Date.now() - 3 * 864e5 + 50 * 60e3, note: "", u: Date.now(),
    exercises: [{ key: "smith-rdl", name: "Smith RDL", lo: 6, hi: 10, inc: 10, rest: 150, sets: [{ w: 185, r: 8, done: true }, { w: 185, r: 8, done: true }] }] });
  repo.set("workouts.json", { content: Buffer.from(JSON.stringify(wj)).toString("base64"), sha: "remote-sha" });
  await page.click('[data-act="sync"]');
  await page.goto(URL0 + "#/lift");
  await page.waitForSelector('.wrow:has-text("Lower B")', { timeout: 15000 });
  const t3 = await text();
  ok(t3.includes("Smith RDL") && t3.includes("Start Lower A"), "remote workout merged; rotation still follows the latest workout", t3);
  ok(readJson("workouts.json").workouts.length === 2, "merge wrote back both workouts");

  // a change made while a backup is uploading survives the merge, and the backup doesn't re-render under his fingers
  await page.goto(URL0 + "#/lift/templates");
  await page.waitForSelector(".tpl");
  await page.fill('input[data-tb="tname"][data-t="split2"]', "Upper B pull");   // something for the next backup to upload
  await page.waitForTimeout(700);
  const gate = {};
  holdPut = { path: "workouts.json", gate: new Promise((r) => (gate.release = r)), arrived: null };
  const arrived = new Promise((r) => (holdPut.arrived = r));
  await page.goto(URL0 + "#/settings");
  await page.click('[data-act="sync"]');
  await arrived;   // workouts.json is on its way up with "Upper B pull" and the old split3 name
  await page.goto(URL0 + "#/lift/templates");
  await page.fill('input[data-tb="tname"][data-t="split3"]', "Lower B legs");
  gate.release();
  ok(await until(() => repo.has("workouts.json") && readJson("workouts.json").templates.some((t) => t.name === "Lower B legs")), "the follow-up backup carries the change made during the upload", readJson("workouts.json").templates.map((t) => t.name));
  ok((await page.inputValue('input[data-tb="tname"][data-t="split3"]')) === "Lower B legs" && await page.evaluate(() => !!document.activeElement && document.activeElement.dataset.t === "split3"), "the edit stayed on screen and the field kept focus through the backup");
  ok(readJson("workouts.json").templates.find((t) => t.id === "split2").name === "Upper B pull", "the first upload's change is there too");

  // a fresh phone gets the edited sessions, not its own seed
  const p2 = await mk();
  await p2.goto(URL0 + "#/settings");
  await p2.fill('input[data-set="token"]', "github_pat_test");
  await p2.locator('input[data-set="token"]').blur();
  await p2.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  await p2.goto(URL0 + "#/lift/templates");
  await p2.waitForSelector(".tpl");
  ok((await p2.inputValue('input[data-tb="tname"][data-t="split0"]')) === "Upper A push" && await p2.locator(".tpl").count() === 4, "second phone takes the edited sessions over its seed");
  await p2.goto(URL0 + "#/lift");
  await p2.waitForSelector('.wrow:has-text("Upper A")');
  ok(await p2.locator('.wrow:has-text("Lower B")').count() === 1, "second phone restored both workouts");

  // rest timer runs out: fake clock, so no real waiting
  const p3 = await mk({ clock: true });
  await p3.goto(URL0 + "#/");
  await p3.waitForSelector('[data-act="startW"]');
  await p3.click('[data-act="startW"]');
  await p3.waitForSelector(".ex");
  await p3.evaluate(() => { window.__vib = 0; navigator.vibrate = () => { window.__vib++; return true; }; });
  await p3.click('[data-act="tick"][data-i="3"][data-j="0"]');   // cable lateral raise: isolation, 75 s
  ok(/^1:1[45]$/.test(await p3.locator("#restLeft").innerText()), "isolation rest starts at 1:15", await p3.locator("#restLeft").innerText());
  await p3.clock.runFor(70_000);
  ok((await p3.locator("#restLeft").innerText()) === "0:05", "bar counts down from the end timestamp", await p3.locator("#restLeft").innerText());
  await p3.clock.runFor(6_000);
  ok(await p3.locator("#rest").isHidden(), "bar hides at zero");
  ok((await p3.evaluate(() => window.__vib)) === 1, "vibrates once when the rest ends");
  // locked phone: the next timer callback lands long after the end, so the bar clears without a late buzz
  await p3.click('[data-act="tick"][data-i="3"][data-j="1"]');
  ok(await p3.locator("#rest").isVisible(), "second set starts a new rest");
  await p3.clock.fastForward(90_000);
  ok(await p3.locator("#rest").isHidden() && (await p3.evaluate(() => window.__vib)) === 1, "a rest that ended long ago (phone was locked) clears without a late buzz", await p3.evaluate(() => window.__vib));
  await p3.screenshot({ path: path.join(__dirname, "lift.png"), fullPage: true });

  await page.goto(URL0 + "#/lift");
  await page.waitForSelector(".wrow");
  await page.screenshot({ path: path.join(__dirname, "lift-hub.png"), fullPage: true });

  ok(errors.filter((e) => !/status of 404/.test(e)).length === 0, "no page errors (404s are the fake backup saying a file is new)", errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
