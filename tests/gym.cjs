// Headless test of the Instagram-style profile: All / Food / Gym / Check-ins tabs, gym photo posts sorted by the day
// each photo was taken (EXIF, then lastModified), the after-workout "Add photo" flow, workout-only tiles, and backup.
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

// the test photos are real phone JPEGs with their own EXIF dates: drop every APP1 segment first
function noExif(buf) {
  const out = [buf.subarray(0, 2)];
  let o = 2;
  while (o + 4 <= buf.length && buf[o] === 0xFF && buf[o + 1] !== 0xDA) {
    const len = buf.readUInt16BE(o + 2);
    if (buf[o + 1] !== 0xE1) out.push(buf.subarray(o, o + 2 + len));
    o += 2 + len;
  }
  out.push(buf.subarray(o));
  return Buffer.concat(out);
}
// a JPEG with an EXIF DateTimeOriginal ("YYYY:MM:DD HH:MM:SS") spliced in right after SOI
function withExif(buf, when) {
  const t = Buffer.alloc(64);
  t.write("II", 0, "ascii"); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(1, 8); t.writeUInt16LE(0x8769, 10); t.writeUInt16LE(4, 12); t.writeUInt32LE(1, 14); t.writeUInt32LE(26, 18); t.writeUInt32LE(0, 22);
  t.writeUInt16LE(1, 26); t.writeUInt16LE(0x9003, 28); t.writeUInt16LE(2, 30); t.writeUInt32LE(20, 32); t.writeUInt32LE(44, 36); t.writeUInt32LE(0, 40);
  Buffer.from(when + "\0", "ascii").copy(t, 44);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), t]), head = Buffer.alloc(4);
  head.writeUInt16BE(0xFFE1, 0); head.writeUInt16BE(body.length + 2, 2);
  buf = noExif(buf);
  return Buffer.concat([buf.subarray(0, 2), head, body, buf.subarray(2)]);
}
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const appToday = new Date(Date.now() - 4 * 3600e3);   // the app's day rolls over at 4 AM
const dayAgo = (n) => { const d = new Date(appToday); d.setDate(d.getDate() - n); return d; };
const exifStr = (d, hm) => ymd(d).replace(/-/g, ":") + " " + hm + ":00";

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(process.env.LOCALAPPDATA, "ms-playwright/chromium-1208/chrome-win64/chrome.exe") });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://api.github.com/**", fakeGitHub);
  await page.route("https://api.anthropic.com/**", (r) => { claudeCalls++; r.abort(); });
  const text = () => page.locator("#view").innerText();
  const img = (i) => fs.readFileSync(IMGS[i % IMGS.length]);
  const pick = async (selector, files) => {
    const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click(selector)]);
    await fc.setFiles(files);
  };
  const dropFiles = (sel, files) => page.evaluate(({ sel, files }) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.b64), a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      dt.items.add(new File([a], f.name, { type: "image/jpeg", lastModified: f.lastModified || Date.now() }));
    }
    const inp = document.querySelector(sel);
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
  }, { sel, files: files.map((f) => ({ name: f.name, b64: f.buffer.toString("base64"), lastModified: f.lastModified })) });
  const T = ymd(appToday), D5 = ymd(dayAgo(5)), D8 = ymd(dayAgo(8)), D9 = ymd(dayAgo(9));

  await page.goto("http://localhost:8771/#/me");
  await page.waitForSelector(".profile");
  ok(await page.locator(".igtabs a").count() === 4, "four profile tabs");
  ok((await text()).includes("gym days") && (await text()).includes("No posts yet"), "empty profile with a gym days count", await text());
  ok((await page.locator("#tabs a.on").innerText()).includes("Profile"), "bottom tab is called Profile");
  await page.click('.igtabs a[href="#/me/gym"]');
  await page.waitForSelector('.igtabs a.on[href="#/me/gym"]');
  ok((await text()).includes("No gym days yet"), "gym tab empty state");

  // three photos with EXIF from 5 days ago (one at 1:30 AM the next night still counts for that day),
  // one fresh from the camera, one old library pick with only a lastModified
  // built in the page: Playwright stamps every file it hands over with lastModified = now
  await dropFiles("#gymIn", [
    { name: "a.jpg", mimeType: "image/jpeg", buffer: withExif(img(0), exifStr(dayAgo(5), "18:10")) },
    { name: "b.jpg", mimeType: "image/jpeg", buffer: withExif(img(1), exifStr(dayAgo(5), "18:40")) },
    { name: "c.jpg", mimeType: "image/jpeg", buffer: withExif(img(2), exifStr(dayAgo(4), "01:30")) },
    { name: "d.jpg", mimeType: "image/jpeg", buffer: noExif(img(3)) },
    { name: "e.jpg", mimeType: "image/jpeg", buffer: noExif(img(0)), lastModified: dayAgo(9).setHours(19, 0, 0, 0) },
  ]);
  await page.waitForSelector(".gymgroup");
  ok(page.url().endsWith("#/newgym"), "picking photos opens the review screen");
  const dates = await page.$$eval('input[data-gbind="date"]', (xs) => xs.map((x) => x.value));
  ok(JSON.stringify(dates) === JSON.stringify([T, D5, D9]), "sorted into days, newest first, by EXIF then lastModified", dates);
  const counts = await page.$$eval(".gymgroup", (gs) => gs.map((g) => g.querySelectorAll(".picks div").length));
  ok(JSON.stringify(counts) === JSON.stringify([1, 3, 1]), "a 1:30 AM photo belongs to the night before", counts);
  await page.fill('input[data-gbind="caption"][data-g="1"]', "Legs, felt strong");
  await page.fill('input[data-gbind="date"][data-g="2"]', D8);
  await page.locator('input[data-gbind="date"][data-g="2"]').dispatchEvent("change");
  await page.waitForTimeout(300);
  ok((await page.inputValue('input[data-gbind="date"][data-g="2"]')) === D8 && (await page.inputValue('input[data-gbind="caption"][data-g="1"]')) === "Legs, felt strong", "day and note edits stick through a re-render");
  await page.reload();
  await page.waitForSelector(".gymgroup");
  ok(await page.locator(".gymgroup").count() === 3 && (await page.inputValue('input[data-gbind="date"][data-g="2"]')) === D8, "the picked batch survives the app closing");
  ok((await page.locator('[data-act="saveGym"]').innerText()).includes("Post 3 days"), "post button counts days");
  await page.click('[data-act="saveGym"]');
  await page.waitForSelector('.igtabs a.on[href="#/me/gym"] >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll(".pgrid a").length === 3);
  ok((await page.locator("#toastText").innerText()).includes("Posted 3 gym days"), "toast confirms 3 days");
  await page.waitForFunction(() => [...document.querySelectorAll(".pgrid a")].every((a) => a.style.backgroundImage));
  ok(true, "gym tiles show their photos");
  ok(/3\s*gym days/.test(await text()), "gym days stat counts 3", await text());
  ok(await page.locator(".avatar[style*='background-image']").count() === 1, "first gym photo became the profile pic");

  await page.click('.igtabs a[href="#/me"]');
  await page.waitForSelector('.igtabs a.on[href="#/me"]');
  ok(await page.locator(".pgrid .k").count() === 3 && (await page.locator(".pgrid").innerText()).includes("🏋"), "All tab badges each tile with its kind");

  await page.click('.igtabs a[href="#/me/gym"]');
  await page.click(".pgrid a >> nth=1");
  await page.waitForSelector(".carousel img");
  ok(await page.locator(".carousel img").count() === 3 && (await text()).includes("Gym day") && (await text()).includes("Legs, felt strong"), "gym post: 3 photos, note, no workout yet", await text());
  ok(!(await text()).includes("Before / after") && !(await text()).includes("Check-in"), "gym posts aren't check-ins");

  // lift today, then add a photo from the finish toast
  await page.goto("http://localhost:8771/#/");
  await page.waitForSelector('[data-act="startW"]');
  await page.click('[data-act="startW"]');
  await page.waitForSelector(".ex");
  await page.fill('input[data-wb="w"][data-i="0"][data-j="0"]', "35");
  await page.fill('input[data-wb="r"][data-i="0"][data-j="0"]', "10");
  await page.click('[data-act="tick"] >> nth=0');
  await page.click("#finishW");
  await page.waitForFunction(() => document.getElementById("toastBtn").textContent === "Add photo" && !document.getElementById("toastBtn").hidden);
  ok(true, "finish toast offers Add photo");
  await pick("#toastBtn", [{ name: "f.jpg", mimeType: "image/jpeg", buffer: withExif(img(1), exifStr(dayAgo(30), "12:00")) }]);
  await page.waitForSelector(".gymgroup");
  ok((await page.inputValue('input[data-gbind="date"]')) === T, "from a workout, the photo goes to the workout's day whatever its EXIF says");
  const info = await page.locator(".gymgroup").innerText();
  ok(info.includes("Goes with Upper A") && info.includes("adds to that day's gym post"), "review says which workout and post it joins", info);
  await page.click('[data-act="saveGym"]');
  await page.waitForSelector(".carousel img");
  ok(await page.locator(".carousel img").count() === 2 && (await text()).includes("Upper A") && (await text()).includes("1 set ·"), "today's post: both photos, linked workout", await text());

  await page.goto("http://localhost:8771/#/me/gym");
  await page.waitForSelector(".pgrid a");
  ok(await page.locator(".pgrid a").count() === 3 && (await page.locator(".pgrid a >> nth=0").innerText()).includes("Upper A"), "one tile per day, today's labelled with the workout");

  // delete today's photo post: the workout still shows as a tile
  await page.click(".pgrid a >> nth=0");
  await page.click('[data-act="deletePost"]');
  await page.goto("http://localhost:8771/#/me/gym");
  await page.waitForSelector(".pgrid a.wk");
  ok(await page.locator(".pgrid a.wk").count() === 1 && (await page.locator(".pgrid a.wk").innerText()).includes("Upper A"), "a workout with no photo is its own tile");
  await page.click(".pgrid a.wk");
  await page.waitForSelector('[data-act="editW"]');
  ok(await page.locator('[data-act="pickGym"]:has-text("Add gym photos")').count() === 1, "workout page offers gym photos");

  await page.goto("http://localhost:8771/#/me");
  await page.click('[data-act="toggleStreaks"]');
  await page.waitForSelector(".heat");
  ok(await page.locator(".heat i.lift").count() === 3, "heatmap rings every gym day, photo-only ones too");
  ok((await text()).includes("Lifted 1 time this week") || (await text()).includes("Lifted 2 times this week"), "consistency line counts gym days", await text());
  await page.reload();
  await page.waitForSelector(".profile");
  ok(await page.locator(".heat").count() === 1, "Streaks stays open after a reload");
  await page.click('.igtabs a[href="#/me/progress"]');
  await page.waitForSelector('.igtabs a.on[href="#/me/progress"]');
  ok((await text()).includes("No check-ins yet") && /0\s*check-ins/.test(await text()), "gym posts don't count as check-ins");
  await page.goto("http://localhost:8771/#/eats");
  await page.waitForSelector(".igtabs a.on");
  ok((await page.locator(".igtabs a.on").innerText()).includes("Food"), "#/eats opens the Food tab");

  // backup: gym posts ride in progress.json, photos in photos/
  await page.goto("http://localhost:8771/#/settings");
  await page.fill('input[data-set="token"]', "github_pat_test");
  await page.locator('input[data-set="token"]').blur();
  await page.waitForFunction(() => /Backed up|failed/.test(document.getElementById("syncStatus")?.textContent || ""), null, { timeout: 15000 });
  ok((await page.locator("#syncStatus").innerText()).startsWith("Backed up"), "backup ran");
  const pj = JSON.parse(Buffer.from(repo.get("progress.json").content, "base64").toString("utf8"));
  ok(pj.posts.filter((p) => p.kind === "gym").length === 3 && pj.posts.filter((p) => p.kind === "gym" && !p.del).length === 2, "gym posts backed up with their kind", pj.posts);
  ok([...repo.keys()].filter((k) => k.startsWith("photos/")).length === 6, "all 6 gym photos backed up", [...repo.keys()]);
  ok(claudeCalls === 0, "gym photos never sent to Claude");

  await page.goto("http://localhost:8771/#/me");
  await page.waitForFunction(() => [...document.querySelectorAll(".pgrid a:not(.wk)")].every((a) => a.style.backgroundImage));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, "me-ig.png") });
  await page.click('[data-act="toggleStreaks"]');
  await page.waitForSelector(".heat", { state: "detached" });
  await page.waitForFunction(() => [...document.querySelectorAll(".pgrid a:not(.wk)")].every((a) => a.style.backgroundImage));
  await page.waitForTimeout(2800);   // let the "Backed up" toast fade
  await page.screenshot({ path: path.join(__dirname, "me-ig-grid.png") });

  ok(errors.length === 0, "no page errors", errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
