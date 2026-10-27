// Headless test of Plate's progress profile: posts, weights, compare, backup + restore, delete/undo.
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
}).listen(8767);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra ?? ""); } };
const repo = new Map();
let shaN = 1, claudeCalls = 0;
async function fakeGitHub(route) {
  const req = route.request(), url = new URL(req.url());
  const p = decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,OPTIONS" };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (req.method() === "PUT") {
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

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://api.github.com/**", fakeGitHub);
    await page.route("https://api.anthropic.com/**", (r) => { claudeCalls++; r.abort(); });
    return page;
  };
  const errors = [];
  const page = await mk();
  const text = () => page.locator("#view").innerText();

  await page.goto("http://localhost:8767/#/");
  await page.waitForSelector(".hero");
  ok((await text()).includes("Start your progress profile"), "today nudges for day-one photos");
  await page.click('a[data-tab="me"]');
  await page.waitForSelector(".profile");
  ok((await text()).includes("No posts yet"), "empty profile");

  // log one meal today so consistency has something to count
  await page.click('a[data-tab="add"]');
  await page.click('.fav:has-text("Protein shake")');
  await page.waitForSelector(".entry");
  await page.click('a[data-tab="me"]');
  await page.waitForSelector(".profile");
  // day one: two photos, 160.8 lb, backdated a week
  await page.click('[data-act="newPost"]');
  await page.setInputFiles("#progIn", IMGS.slice(0, 2));
  await page.waitForFunction(() => document.querySelectorAll(".picks div").length === 2);
  ok(true, "two photos picked");
  ok(!(await page.locator('[data-pbind="weight"]').isVisible()), "weigh-in tucked away by default");
  await page.click("details summary");
  await page.fill('[data-pbind="weight"]', "160.8");
  const weekAgo = await page.evaluate(() => { const d = new Date(Date.now() - 4 * 3600e3 - 8 * 864e5); return d.toISOString().slice(0, 10); });
  await page.fill('[data-pbind="date"]', weekAgo);
  await page.fill('[data-pbind="caption"]', "Day one. Locking in.");
  await page.click('[data-act="savePost"]');
  await page.waitForSelector(".carousel img");
  ok(!(await text()).includes("160.8") && (await text()).includes("Day one"), "post shows day one, weight hidden");
  await page.waitForFunction(() => [...document.querySelectorAll(".carousel img")].every((i) => i.src.startsWith("data:")));
  ok(await page.locator(".carousel img").count() === 2, "carousel has both photos");

  // overdue → nudge, then week two
  await page.goto("http://localhost:8767/#/");
  await page.waitForSelector(".hero");
  ok((await text()).includes("Weekly check-in"), "nudge after 7+ days");
  await page.click(".nudge");
  await page.waitForSelector('[data-act="pickProgress"]');
  await page.setInputFiles("#progIn", [IMGS[2], IMGS[3]]);
  await page.waitForFunction(() => document.querySelectorAll(".picks div").length === 2);
  await page.click("details summary");
  await page.fill('[data-pbind="weight"]', "159.2");
  await page.click('[data-act="savePost"]');
  await page.waitForSelector(".carousel img");
  ok((await text()).includes("Check-in #2") && (await text()).includes("week 2") && !(await text()).includes("lb"), "second post = check-in #2, no weight", await text());

  await page.goto("http://localhost:8767/#/me");
  await page.waitForSelector(".pgrid a");
  ok(await page.locator(".heat").count() === 0, "heatmap folded behind Streaks by default");
  await page.click('[data-act="toggleStreaks"]');
  await page.waitForSelector(".heat");
  const t = await text();
  ok(await page.locator(".pgrid a").count() === 2, "grid shows 2 posts");
  ok(t.includes("check-ins") && t.includes("week streak") && !t.includes("159.2"), "profile shows consistency, not weight", t);
  ok(await page.locator(".heat i").count() === 84, "12-week heatmap");
  ok(t.includes("Logged food 1 of the last 30"), "logged day counted", t);
  ok(/2\s*week streak/.test(t), "2-week check-in streak", t);
  ok(await page.locator('.avatar[style*="background-image"]').count() === 1, "first photo became profile pic");
  ok(!(await page.locator(".pgrid").innerText()).includes("undefined"), "grid labels clean");

  // compare
  await page.click(".pgrid a >> nth=0");
  await page.click('a:has-text("Before / after")');
  await page.waitForSelector(".compare img");
  await page.waitForFunction(() => [...document.querySelectorAll(".compare img")].every((i) => i.src.startsWith("data:")));
  const ct = await text();
  ok(ct.includes("Before") && ct.includes("After") && ct.includes("days apart") && !ct.includes("lb"), "compare view without weight", ct);
  ok(await page.locator('[data-act="cmpPose"]').count() === 2, "pose switcher for 2 photos");
  await page.click('[data-act="cmpPose"][data-k="1"]');
  await page.waitForSelector('[data-act="cmpPose"][data-k="1"].on');
  ok(true, "pose 2 selected");

  // edit profile goal + name
  await page.goto("http://localhost:8767/#/me");
  await page.click('[data-act="editProfile"]');
  await page.fill("#pf_name", "Perry");
  await page.check("#pf_showWeight");
  await page.fill("#pf_goal", "149");
  await page.click('[data-act="saveProfile"]');
  await page.waitForSelector('.profile:has-text("Perry")', { timeout: 5000 }).catch(() => {});
  ok((await text()).includes("Perry") && (await text()).includes("Goal 149") && (await text()).includes("159.2 lb"), "weight shows once turned on", await text());

  // backup then restore on a fresh phone
  await page.goto("http://localhost:8767/#/settings");
  await page.fill('input[data-set="token"]', "github_pat_test");
  await page.locator('input[data-set="token"]').blur();
  await page.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  ok((await page.locator("#syncStatus").innerText()).startsWith("Backed up"), "backup ran");
  ok(repo.has("progress.json"), "progress.json written");
  ok([...repo.keys()].filter((k) => k.startsWith("photos/")).length === 4, "4 progress photos backed up", [...repo.keys()]);
  ok(claudeCalls === 0, "progress photos never sent to Claude");

  const p2 = await mk();
  await p2.goto("http://localhost:8767/#/settings");
  await p2.fill('input[data-set="token"]', "github_pat_test");
  await p2.locator('input[data-set="token"]').blur();
  await p2.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  await p2.goto("http://localhost:8767/#/me");
  await p2.waitForSelector(".pgrid a");
  await p2.waitForFunction(() => [...document.querySelectorAll(".pgrid a")].every((a) => a.style.backgroundImage), null, { timeout: 15000 });
  ok((await p2.locator("#view").innerText()).includes("Perry"), "second phone restored profile + photos");

  // delete + undo
  await page.goto("http://localhost:8767/#/me");
  await page.click(".pgrid a >> nth=0");
  await page.click('[data-act="deletePost"]');
  await page.waitForSelector(".profile");
  ok(await page.locator(".pgrid a").count() === 1, "post deleted");
  await page.click("#toastBtn");
  await page.waitForFunction(() => document.querySelectorAll(".pgrid a").length === 2);
  ok(true, "undo restores post");

  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, "me.png") });
  await page.click(".pgrid a >> nth=0");
  await page.click('a:has-text("Before / after")');
  await page.waitForSelector(".compare img");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(__dirname, "compare.png") });

  ok(errors.length === 0, "no page errors", errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
