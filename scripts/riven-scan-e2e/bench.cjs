// Riven scanner benchmark over a folder of screenshots. See README.md in this folder.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("@playwright/test");
const sharp = require("sharp");
const { closeNativeElectron } = require("../native-electron.cjs");

const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.join(ROOT, ".electron-build");
let parseRivenStats = null;
let levenshteinDistance = null;

const USAGE =
  "usage: node scripts/hidden-desktop.mjs node scripts/riven-scan-e2e/bench.cjs " +
  "<screenshotDir> <outDir> [--limit N] [--files a.jpg,b.jpg] [--decisions decisions.json]";

// Display names a riven can roll; parser partials such as "Recoil" or "Slide" are not among them.
const RIVEN_STAT_NAMES = new Set([
  "Additional Combo Count Chance",
  "Chance to Gain Combo Count",
  "Ammo Maximum",
  "Attack Speed",
  "Channeling Damage",
  "Channeling Efficiency",
  "Cold",
  "Combo Duration",
  "Critical Chance",
  "Critical Chance for Slide Attack",
  "Critical Damage",
  "Damage",
  "Damage to Corpus",
  "Damage to Grineer",
  "Damage to Infested",
  "Electricity",
  "Finisher Damage",
  "Fire Rate",
  "Flight Speed",
  "Heat",
  "Heavy Attack Efficiency",
  "Impact",
  "Initial Combo",
  "Magazine Capacity",
  "Melee Damage",
  "Multishot",
  "Projectile Speed",
  "Punch Through",
  "Puncture",
  "Range",
  "Reload Speed",
  "Slash",
  "Status Chance",
  "Status Duration",
  "Toxin",
  "Weapon Recoil",
  "Zoom",
]);

// Windows OCR drops or splits different tokens at different sizes and shapes,
// so it reads every crop several ways and each stat is checked per reading.
const WIN_VARIANTS = [
  ...["plain", "iconmask"].flatMap((mode) =>
    [1.5, 2, 2.5, 3, 4].map((scale) => ({ mode, sx: scale, sy: scale })),
  ),
  { mode: "plain", sx: 3.2, sy: 2.4 },
  { mode: "plain", sx: 2.2, sy: 2.8 },
  { mode: "plain", sx: 2.5, sy: 2.5, filter: "sharpen" },
  { mode: "plain", sx: 2.5, sy: 2.5, filter: "blur" },
];
// A stat counts as confirmed when this many Windows readings contain it exactly.
const MIN_CONFIRMING_READINGS = 2;
const BATCH = 16;

function parseArgs(argv) {
  const positional = [];
  const opts = { limit: 0, files: null, decisions: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "--files") opts.files = new Set(argv[++i].split(","));
    else if (arg === "--decisions") opts.decisions = argv[++i];
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new Error(USAGE);
  return { src: path.resolve(positional[0]), out: path.resolve(positional[1]), ...opts };
}

let logStream = null;
function log(line) {
  console.log(line);
  logStream?.write(`${line}\n`);
}

function toCanon(stat) {
  const sign = stat.multiplier ? "x" : (stat.displayPositive ?? stat.positive) ? "+" : "-";
  return { name: stat.name, sign, value: stat.value };
}

function statKey(s) {
  return `${s.sign}${s.value ?? "?"} ${s.name}`;
}

function listKey(stats) {
  return stats.map(statKey).sort().join(" | ");
}

function sameList(a, b) {
  return a.length > 0 && listKey(a) === listKey(b);
}

function isCurse(s) {
  if (s.sign === "x") return s.value !== null && s.value < 1;
  if (s.name === "Weapon Recoil") return s.sign === "+";
  return s.sign === "-";
}

function plausibility(stats) {
  if (!stats || stats.length === 0) return "empty";
  if (stats.length < 2 || stats.length > 4) return `${stats.length} stats`;
  const names = new Set();
  for (const s of stats) {
    if (!RIVEN_STAT_NAMES.has(s.name)) return `bad name ${s.name}`;
    if (names.has(s.name)) return `duplicate ${s.name}`;
    names.add(s.name);
    if (s.value === null || !Number.isFinite(s.value)) return `no value ${s.name}`;
    const faction = s.name.startsWith("Damage to ");
    if (faction !== (s.sign === "x")) return `multiplier on ${s.name}`;
    if (s.value > 500) return `value ${s.value}`;
  }
  const curses = stats.filter(isCurse).length;
  const buffs = stats.length - curses;
  if (curses > 1) return `${curses} curses`;
  if (buffs < 2 || buffs > 3) return `${buffs} buffs`;
  return null;
}

function parseTypedStats(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim().replace(/,/g, ".");
    if (!line) continue;
    const m = /^([+\-–x])\s*(\d+(?:\.\d+)?)\s*%?\s*s?\s+(.+)$/i.exec(line);
    if (!m) return null;
    const sign = m[1].toLowerCase() === "x" ? "x" : m[1] === "+" ? "+" : "-";
    out.push({ name: m[3].trim(), sign, value: Number(m[2]) });
  }
  return out;
}

// Signed numbers in raw OCR text, read without the shared parser: a value both
// readers saw but neither parsed shows up here and nowhere else.
function signedValues(text) {
  const norm = String(text || "")
    .replace(/[–—]/g, "-")
    .replace(/0\/0/g, "%")
    .replace(/(\d)\s*,\s*(\d)/g, "$1.$2")
    .replace(/([+-])\s+(\d)/g, "$1$2")
    .replace(/\bx\s*[lI]\s*[.,]?\s*(\d)/g, "x1.$1");
  const values = new Set();
  for (const m of norm.matchAll(/(?:^|[^\w.])([+-]|x\s?)(\d+(?:\.\d+)?)(?!\s*fo)/gi)) {
    values.add(Number(m[2]));
  }
  return [...values];
}

// The card prints decimal commas, so a space inside a signed number is a split
// glyph run ("+1 1 5,6%"), never a decimal point.
function normalizeWinText(text) {
  return String(text || "")
    .replace(/[—–]/g, "-")
    .replace(/([+-])\s+(?=\d)/g, "$1")
    .replace(/([+-]\d[\d ]*\d)/g, (run) => run.replace(/ /g, ""))
    .replace(/(\d)\s+,/g, "$1,")
    .replace(/(\d),\s+(?=\d)/g, "$1,")
    .replace(/\bx\s*[lI1]\s*[,.]\s*(\d)/g, "x1,$1");
}

function confirmations(stat, readings) {
  return readings.filter((reading) =>
    reading.stats.some(
      (s) => s.name === stat.name && s.sign === stat.sign && s.value === stat.value,
    ),
  ).length;
}

function nameSupport(name, readings) {
  return readings.filter((reading) => reading.stats.some((s) => s.name === name)).length;
}

function conflictSupport(stat, readings) {
  const counts = new Map();
  for (const reading of readings) {
    const keys = new Set(
      reading.stats
        .filter((s) => s.name === stat.name && s.value !== null && statKey(s) !== statKey(stat))
        .map(statKey),
    );
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function voteReadings(readings) {
  const byName = new Map();
  for (const reading of readings) {
    reading.stats.forEach((stat, index) => {
      const entry = byName.get(stat.name) ?? {
        name: stat.name,
        support: 0,
        pos: [],
        values: new Map(),
      };
      entry.support += 1;
      entry.pos.push(index);
      if (stat.value !== null && stat.value <= 500) {
        const key = `${stat.sign}|${stat.value}`;
        entry.values.set(key, (entry.values.get(key) ?? 0) + 1);
      }
      byName.set(stat.name, entry);
    });
  }
  const minSupport = Math.max(2, Math.ceil(readings.length * 0.3));
  return [...byName.values()]
    .filter((entry) => entry.support >= minSupport)
    .map((entry) => {
      let best = null;
      for (const [key, count] of entry.values) {
        if (!best || count > best.count || (count === best.count && key.length > best.key.length)) {
          best = { key, count };
        }
      }
      const [sign, value] = best ? best.key.split("|") : ["?", null];
      return {
        name: entry.name,
        sign,
        value: value === null ? null : Number(value),
        support: entry.support,
        valueSupport: best ? best.count : 0,
        pos: median(entry.pos),
      };
    })
    .sort((a, b) => a.pos - b.pos);
}

function independentRect(width, height) {
  // Card text block of the centered card: title to the last stat line, above the MR row.
  return {
    left: Math.round(width / 2 - 0.16 * height),
    top: Math.round(0.585 * height),
    width: Math.round(0.32 * height),
    height: Math.round(0.18 * height),
  };
}

async function maskedRaw(file, rect, mode) {
  const { data, info } = await sharp(file)
    .extract(rect)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (mode === "iconmask") {
    for (let i = 0; i < data.length; i += 3) {
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      if (max > 70 && (max - min) / max > 0.5) {
        data[i] = 32;
        data[i + 1] = 30;
        data[i + 2] = 36;
      }
    }
  }
  return { data, info };
}

async function winRead(recognize, scratch, input, variant) {
  let image = input.info
    ? sharp(input.data, {
        raw: { width: input.info.width, height: input.info.height, channels: 3 },
      })
    : sharp(input.file);
  const width = input.info ? input.info.width : input.width;
  const height = input.info ? input.info.height : input.height;
  image = image.resize(Math.round(width * variant.sx), Math.round(height * variant.sy), {
    fit: "fill",
    kernel: "lanczos3",
  });
  if (variant.filter === "sharpen") image = image.sharpen({ sigma: 1.2 });
  if (variant.filter === "blur") image = image.blur(1.2);
  await image.png().toFile(scratch);
  const result = await recognize(scratch, null, null, null);
  const raw = result.text || "";
  const stats = parseRivenStats(normalizeWinText(raw)).map(toCanon);
  return { raw, stats };
}

async function ocrRegion(recognize, scratch, file, rect, scale) {
  await sharp(file)
    .extract(rect)
    .resize(Math.round(rect.width * scale), Math.round(rect.height * scale), { kernel: "lanczos3" })
    .png()
    .toFile(scratch);
  return (await recognize(scratch, null, null, null)).text || "";
}

async function classify(recognize, scratch, file, width, height) {
  const cx = width / 2;
  const button = {
    left: Math.round(cx - 0.26 * height),
    top: Math.round(0.86 * height),
    width: Math.round(0.52 * height),
    height: Math.round(0.055 * height),
  };
  const buttonText = await ocrRegion(recognize, scratch, file, button, 2);
  if (/confirm/i.test(buttonText)) return { cls: "roll", evidence: buttonText };
  if (/cycle/i.test(buttonText)) {
    const corner = {
      left: Math.round(width * 0.75),
      top: Math.round(0.9 * height),
      width: Math.round(width * 0.24),
      height: Math.round(0.065 * height),
    };
    const cornerText = await ocrRegion(recognize, scratch, file, corner, 2);
    const cls = /cancel/i.test(cornerText) ? "single-initial" : "single-after-choice";
    return { cls, evidence: `${buttonText} / ${cornerText}` };
  }
  const full = await ocrRegion(recognize, scratch, file, { left: 0, top: 0, width, height }, 1);
  const rivenLike = /[+-]\s?\d+[.,]\d\s?%|x\s?\d[.,]\d+\s+damage\s+to/i.test(full);
  return { cls: rivenLike ? "other-riven" : "not-riven", evidence: buttonText };
}

function jobsFor(cls) {
  if (cls === "roll")
    return [{ profile: "roll", crop: "rollCard", rollReveal: true, label: "roll-right" }];
  if (cls.startsWith("single")) {
    return [{ profile: "single", crop: "singleCard", rollReveal: false, label: "initial-card" }];
  }
  if (cls === "other-riven") {
    return [
      { profile: "single", crop: "singleCard", rollReveal: false, label: "initial-card" },
      { profile: "chat", crop: "chatCard", rollReveal: false, label: "chat-card" },
    ];
  }
  return [];
}

async function installBench({ app: electronApp }, { root }) {
  await electronApp.whenReady();
  const load = (file) => process.mainModule.require(`${root}/.electron-build/${file}.js`);
  const nodeFs = process.mainModule.require("node:fs");
  const onnx = load("services/rivenOcrOnnx");
  if (!onnx.rivenOcrOnnxAvailable()) throw new Error("Riven ONNX models are missing");
  const ocr = load("ipc/overlay/rivenScanOcr");
  const image = load("ipc/overlay/rivenScanImage");
  const text = load("ipc/overlay/rivenScanText");
  const sharpLib = load("services/sharpRuntime").loadSharp();
  const { nativeImage } = process.mainModule.require("electron");
  let current = null;

  // Wrappers only record what passes through; production code and results are unchanged.
  const recognizeStatArea = onnx.recognizeStatArea;
  onnx.recognizeStatArea = async (buf, width, height) => {
    const started = Date.now();
    const result = await recognizeStatArea(buf, width, height);
    if (current) {
      current.attempts.push({
        attempt: current.attempts.length,
        width,
        height,
        ocrMs: Date.now() - started,
        minConfidence: result.minConfidence,
        yoloBoxCount: result.yoloBoxCount,
        lines: result.lines.map((line) => ({
          text: line.text,
          confidence: Number(line.confidence.toFixed(4)),
        })),
        text: result.text,
      });
      current.buffers.push({ buf: Buffer.from(buf), width, height });
    }
    return result;
  };
  const parseRivenStats = text.parseRivenStats;
  text.parseRivenStats = (value, diagnostics) => {
    const stats = parseRivenStats(value, diagnostics);
    const attempt = current?.attempts[current.attempts.length - 1];
    if (attempt && attempt.stats === undefined) {
      attempt.stats = stats;
      attempt.droppedLines = diagnostics ? [...diagnostics.droppedLines] : [];
      attempt.titleSeen = diagnostics?.titleSeen;
      const whole = attempt.droppedLines.some(text.looksLikeWholeStatLine);
      attempt.incomplete = ocr.isIncompleteRivenRead(stats, whole, attempt.titleSeen !== false);
    }
    return stats;
  };

  globalThis.__rivenBench = {
    async run(jobs, cropsDir) {
      const results = [];
      for (const job of jobs) {
        const frame = nativeImage.createFromPath(job.file);
        if (frame.isEmpty()) {
          results.push({ key: job.key, error: "image failed to decode" });
          continue;
        }
        const rect = image.RIVEN_SCAN_CROPS[job.crop];
        const { statCrop } = image.cropRivenStatImage(frame, rect, "window");
        nodeFs.writeFileSync(`${cropsDir}/${job.key}-prodstat.png`, statCrop.toPNG());
        current = { attempts: [], buffers: [] };
        const started = Date.now();
        let final;
        try {
          final = await ocr.recognizeRivenCardStats(frame, rect, {
            generation: 1,
            isStale: () => false,
            sourceType: "window",
            rollReveal: job.rollReveal,
            label: job.label,
          });
        } catch (error) {
          final = { error: String(error) };
        }
        const totalMs = Date.now() - started;
        const record = { key: job.key, totalMs, final, attempts: current.attempts };
        for (const [index, item] of current.buffers.entries()) {
          await sharpLib(item.buf, { raw: { width: item.width, height: item.height, channels: 4 } })
            .jpeg({ quality: 85 })
            .toFile(`${cropsDir}/${job.key}-a${index}.jpg`);
        }
        current = null;
        results.push(record);
      }
      return results;
    },
  };
}

async function runProduction(jobs, cropsDir, onBatch) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-riven-bench-"));
  const userData = path.join(workDir, "profile");
  fs.mkdirSync(userData);
  const env = {
    ...process.env,
    WFHELPER_USER_DATA: userData,
    WFHELPER_DISABLE_KEYBOARD_HOOK: "1",
    WFHELPER_DISABLE_DBWIN: "1",
    APPDATA: path.join(workDir, "roaming"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let ok = false;
  const results = [];
  const timing = { launchMs: 0, warmupMs: 0 };
  try {
    const launched = Date.now();
    app = await _electron.launch({ args: ["--no-sandbox", path.join(__dirname, "host.cjs")], env });
    const host = app.process();
    for (const stream of ["stdout", "stderr"]) {
      host[stream]?.on("data", (chunk) =>
        fs.appendFileSync(path.join(workDir, `${stream}.log`), chunk),
      );
    }
    await app.evaluate(installBench, { root: ROOT });
    timing.launchMs = Date.now() - launched;
    if (jobs.length > 0) {
      const warm = Date.now();
      await app.evaluate(
        (_electron, args) => globalThis.__rivenBench.run(args.jobs, args.cropsDir),
        {
          jobs: [{ ...jobs[0], key: "_warmup" }],
          cropsDir,
        },
      );
      timing.warmupMs = Date.now() - warm;
      for (const name of fs.readdirSync(cropsDir)) {
        if (name.startsWith("_warmup")) fs.rmSync(path.join(cropsDir, name));
      }
    }
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      const out = await app.evaluate(
        (_electron, args) => globalThis.__rivenBench.run(args.jobs, args.cropsDir),
        { jobs: batch, cropsDir },
      );
      results.push(...out);
      onBatch(results.length, jobs.length);
    }
    await closeNativeElectron(app);
    app = null;
    ok = true;
  } finally {
    if (app) await closeNativeElectron(app).catch(() => {});
    if (ok) fs.rmSync(workDir, { recursive: true, force: true });
    else log(`production diagnostics retained at ${workDir}`);
  }
  return { results, timing };
}

function productionRead(prod) {
  if (!prod || prod.final?.error) return [];
  if (prod.final.stats.length > 0) return prod.final.stats.map(toCanon);
  if (prod.final.text) return parseRivenStats(prod.final.text).map(toCanon);
  let best = null;
  for (const attempt of prod.attempts) {
    const stats = attempt.stats ?? [];
    if (!best || stats.length > best.stats.length) best = { stats };
  }
  return (best?.stats ?? []).map(toCanon);
}

function verdictOf(prod) {
  if (!prod) return "not-run";
  if (prod.final?.error) return "error";
  if (prod.final.stats.length > 0) return "accepted";
  if (prod.final.lowConfidence)
    return prod.final.text ? "rejected-incomplete" : "rejected-low-confidence";
  return "empty";
}

function titleOf(card) {
  const counts = new Map();
  for (const reading of card.win?.readings ?? []) {
    const head = normalizeWinText(reading.raw).split(/[+-]\d|\bx\s?\d/)[0];
    const title = head.toLowerCase().replace(/[^a-z-]+/g, "");
    if (title.length >= 5) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [title, count] of counts) {
    if (count > bestCount) {
      best = title;
      bestCount = count;
    }
  }
  return best;
}

function assignGroups(cards) {
  let group = 0;
  let prev = null;
  for (const card of cards) {
    const same =
      prev &&
      card.title &&
      prev.title &&
      levenshteinDistance(card.title, prev.title) <= Math.max(1, Math.floor(card.title.length / 8));
    if (!same) group += 1;
    card.group = `g${String(group).padStart(3, "0")}`;
    prev = card;
  }
}

function compareToTruth(out, truth) {
  const detail = [];
  let names = 0;
  let signs = 0;
  let values = 0;
  for (const t of truth) {
    const o = out.find((stat) => stat.name === t.name);
    if (!o) {
      detail.push({ kind: "missing", truth: statKey(t) });
      continue;
    }
    names += 1;
    if (o.sign === t.sign) signs += 1;
    else detail.push({ kind: "sign", truth: statKey(t), got: statKey(o) });
    if (o.value === t.value) values += 1;
    else detail.push({ kind: "value", truth: statKey(t), got: statKey(o) });
  }
  for (const o of out) {
    if (!truth.some((t) => t.name === o.name)) detail.push({ kind: "extra", got: statKey(o) });
  }
  return { exact: sameList(out, truth), names, signs, values, total: truth.length, detail };
}

function missingCause(card, stat) {
  const inProdText = card.prod.attempts.some((a) => signedValues(a.text).includes(stat.value));
  if (inProdText) return "read-but-not-parsed";
  const cropReadings = card.winProdCrop ?? [];
  const inCrop = cropReadings.some(
    (r) =>
      signedValues(normalizeWinText(r.raw)).includes(stat.value) ||
      r.stats.some((s) => s.name === stat.name),
  );
  return inCrop ? "in-crop-not-recognized" : "outside-production-crop";
}

function failureClass(card) {
  const verdict = card.verdict;
  if (
    verdict === "rejected-low-confidence" ||
    verdict === "rejected-incomplete" ||
    verdict === "empty"
  ) {
    const readOk = sameList(card.prodRead, card.truth);
    return `${verdict}${readOk ? " (best read was correct)" : ""}`;
  }
  const cmp = card.eval;
  const kinds = [...new Set(cmp.detail.map((d) => d.kind))].sort();
  if (kinds.includes("missing")) {
    const causes = cmp.detail
      .filter((d) => d.kind === "missing")
      .map((d) =>
        missingCause(
          card,
          card.truth.find((t) => statKey(t) === d.truth),
        ),
      );
    return `missing stat: ${[...new Set(causes)].join("+")}`;
  }
  if (kinds.includes("extra")) return "phantom stat";
  if (kinds.includes("value")) {
    const d = cmp.detail.find((x) => x.kind === "value");
    const t = d.truth.split(" ")[0];
    const g = d.got.split(" ")[0];
    if (g.endsWith("?")) return "value missing";
    return t.replace(/\D/g, "").length !== g.replace(/\D/g, "").length
      ? "value digit dropped/added"
      : "value digit misread";
  }
  if (kinds.includes("sign")) return "sign misread";
  return kinds.join("+") || "unknown";
}

function disagreementKind(card) {
  if (card.prodRead.length === 0) return "production read nothing";
  if (card.prodPlausible !== null) return `production implausible (${card.prodPlausible})`;
  if (card.winExtraNames.length) return "windows reads a stat production lacks";
  const readings = card.win.readings;
  const kinds = card.prodRead
    .filter(
      (stat, i) =>
        card.confirms[i] < MIN_CONFIRMING_READINGS ||
        conflictSupport(stat, readings) >= card.confirms[i],
    )
    .map((stat) => {
      if (nameSupport(stat.name, readings) === 0) return "windows never reads this stat name";
      const conflict = conflictSupport(stat, readings) >= MIN_CONFIRMING_READINGS;
      return conflict ? "value conflict" : "value unconfirmed (windows reads name only)";
    });
  const order = [
    "value conflict",
    "windows never reads this stat name",
    "value unconfirmed (windows reads name only)",
  ];
  return order.find((kind) => kinds.includes(kind)) ?? "unknown";
}

function analyze(cards, decisions) {
  const productionCards = cards.filter((card) => card.prod);
  for (const card of productionCards) {
    card.verdict = verdictOf(card.prod);
    card.prodRead = productionRead(card.prod);
    card.prodOut = card.verdict === "accepted" ? card.prod.final.stats.map(toCanon) : [];
    card.winRead = card.win.vote.map(({ name, sign, value }) => ({ name, sign, value }));
    card.title = titleOf(card);
    card.prodPlausible = plausibility(card.prodRead);
    card.winPlausible = plausibility(card.winRead);
  }
  assignGroups(productionCards);
  const byGroup = new Map();
  for (const card of productionCards) {
    if (!byGroup.has(card.group)) byGroup.set(card.group, []);
    byGroup.get(card.group).push(card);
  }
  const decided = new Map();
  for (const decision of decisions) {
    for (const file of decision.files ?? []) decided.set(file, decision);
  }
  for (const card of productionCards) {
    const readings = card.win.readings;
    const minNameSupport = Math.max(2, Math.ceil(readings.length * 0.2));
    card.confirms = card.prodRead.map((stat) => confirmations(stat, readings));
    card.winExtraNames = [...new Set(readings.flatMap((r) => r.stats.map((s) => s.name)))].filter(
      (name) =>
        !card.prodRead.some((s) => s.name === name) &&
        nameSupport(name, readings) >= minNameSupport,
    );
    card.voteEqual = sameList(card.prodRead, card.winRead);
    // A matching minority does not confirm production when as many Windows
    // readings give another value. Requiring no conflict at all would dispute
    // 88 of 218 agreed cards over routine 12-to-2 digit noise.
    card.agreed =
      card.prodPlausible === null &&
      card.confirms.every((n) => n >= MIN_CONFIRMING_READINGS) &&
      card.prodRead.every((stat, i) => conflictSupport(stat, readings) < card.confirms[i]) &&
      card.winExtraNames.length === 0;
    // The owner looked at the card, so a decision outranks reader agreement.
    const decision = decided.get(card.file);
    card.tier = null;
    card.truth = null;
    if (decision?.decision === "unreadable") {
      card.tier = "UNREADABLE";
    } else if (decision) {
      card.tier = "OWNER";
      card.truth = parseTypedStats(decision.stats ?? []) ?? [];
    } else if (card.agreed) {
      card.tier = "AGREED";
      card.truth = card.prodRead;
    }
  }
  for (const card of productionCards) {
    const siblings = byGroup.get(card.group).filter((other) => other !== card);
    const truthSibling =
      siblings.find((other) => other.tier === "OWNER") ??
      siblings.find((other) => other.tier === "AGREED");
    if (card.tier === null) {
      if (
        truthSibling &&
        (sameList(card.prodRead, truthSibling.truth) || sameList(card.winRead, truthSibling.truth))
      ) {
        card.tier = "AGREED-SIBLING";
        card.truth = truthSibling.truth;
      } else if (card.prodPlausible !== null && card.winPlausible !== null && !truthSibling) {
        card.tier = "UNREADABLE";
      } else {
        card.tier = "DISPUTED";
        card.disagreement = disagreementKind(card);
      }
    }
    if (card.truth) {
      card.eval = compareToTruth(card.prodOut, card.truth);
      card.failure = card.eval.exact ? null : failureClass(card);
      const unexplained = (text) =>
        signedValues(text).filter((v) => !card.truth.some((s) => s.value === v));
      const prodExtra = unexplained(card.prod.final?.text || card.prod.attempts[0]?.text);
      const winExtra = card.win.readings.map((r) => unexplained(normalizeWinText(r.raw)));
      const sharedExtra = prodExtra.filter(
        (v) => winExtra.filter((list) => list.includes(v)).length >= 2,
      );
      if (sharedExtra.length) card.sharedParserSuspect = sharedExtra;
    }
  }
  return productionCards;
}

function pct(n, d) {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function accuracy(cards) {
  const withTruth = cards.filter((card) => card.truth && card.eval);
  const sum = (key) => withTruth.reduce((total, card) => total + card.eval[key], 0);
  const total = sum("total");
  return {
    cards: withTruth.length,
    exact: withTruth.filter((card) => card.eval.exact).length,
    stats: total,
    names: sum("names"),
    signs: sum("signs"),
    values: sum("values"),
  };
}

function formatAccuracy(label, acc) {
  return (
    `${label}: ${acc.cards} cards, card exact ${acc.exact}/${acc.cards} (${pct(acc.exact, acc.cards)}), ` +
    `stat present ${acc.names}/${acc.stats} (${pct(acc.names, acc.stats)}), ` +
    `sign ${acc.signs}/${acc.names} (${pct(acc.signs, acc.names)}), ` +
    `value ${acc.values}/${acc.names} (${pct(acc.values, acc.names)})`
  );
}

function tally(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === undefined) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

function summarize(allCards, cards, timing) {
  const lines = [];
  const byClass = tally(allCards, (card) => card.cls);
  lines.push(`screenshots: ${allCards.length}`);
  lines.push(`classes: ${byClass.map(([k, v]) => `${k}=${v.length}`).join(", ")}`);
  const tiers = tally(cards, (card) => card.tier);
  lines.push(`tiers (per card): ${tiers.map(([k, v]) => `${k}=${v.length}`).join(", ")}`);
  const verdicts = tally(cards, (card) => card.verdict);
  lines.push(`production verdicts: ${verdicts.map(([k, v]) => `${k}=${v.length}`).join(", ")}`);
  const groups = new Set(cards.map((card) => card.group));
  lines.push(`riven groups (same card across screenshots): ${groups.size}`);
  lines.push(formatAccuracy("AGREED", accuracy(cards.filter((c) => c.tier === "AGREED"))));
  lines.push(
    formatAccuracy(
      "AGREED+SIBLING",
      accuracy(cards.filter((c) => c.tier === "AGREED" || c.tier === "AGREED-SIBLING")),
    ),
  );
  lines.push(formatAccuracy("all established truth", accuracy(cards)));
  const agreed = cards.filter((card) => card.tier === "AGREED");
  lines.push(
    `AGREED cards whose Windows majority vote alone equals production: ` +
      `${agreed.filter((card) => card.voteEqual).length}/${agreed.length}`,
  );
  const established = cards.filter((card) => card.truth).length;
  const disputed = cards.filter((card) => card.tier === "DISPUTED").length;
  const exact = accuracy(cards).exact;
  lines.push(
    `bounds over readable cards: card exact between ${pct(exact, established + disputed)} ` +
      `and ${pct(exact + disputed, established + disputed)}`,
  );
  lines.push("failure classes (established truth, production output wrong):");
  for (const [kind, list] of tally(cards, (card) => card.failure)) {
    lines.push(
      `  ${kind}: ${list.length} e.g. ${list
        .slice(0, 3)
        .map((c) => c.file)
        .join(", ")}`,
    );
  }
  lines.push("disputed by kind:");
  for (const [kind, list] of tally(cards, (card) =>
    card.tier === "DISPUTED" ? card.disagreement : null,
  )) {
    lines.push(
      `  ${kind}: ${list.length} e.g. ${list
        .slice(0, 3)
        .map((c) => c.file)
        .join(", ")}`,
    );
  }
  const suspects = cards.filter((card) => card.sharedParserSuspect);
  lines.push(
    `shared-parser suspects (signed raw value in both readers, in no truth stat): ${suspects.length}` +
      (suspects.length
        ? ` e.g. ${suspects
            .slice(0, 3)
            .map((c) => c.file)
            .join(", ")}`
        : ""),
  );
  const winVsProdParse = cards.filter(
    (card) => card.truth && !sameList(card.winRead, card.truth),
  ).length;
  lines.push(`windows reader wrong on established truth: ${winVsProdParse}`);
  const times = cards.map((card) => card.prod.totalMs).sort((a, b) => a - b);
  const ocrCalls = cards.reduce((total, card) => total + card.prod.attempts.length, 0);
  lines.push(
    `production timing per card: median ${median(times)} ms, p90 ${times[Math.floor(times.length * 0.9)]} ms, ` +
      `max ${times[times.length - 1]} ms, ${ocrCalls} OCR passes for ${cards.length} cards`,
  );
  lines.push(
    `run timing: total ${(timing.totalMs / 1000).toFixed(1)} s, classify ${(timing.classifyMs / 1000).toFixed(1)} s, ` +
      `production ${(timing.productionMs / 1000).toFixed(1)} s (launch ${timing.launchMs} ms, warmup ${timing.warmupMs} ms), ` +
      `windows reader ${(timing.winMs / 1000).toFixed(1)} s`,
  );
  return lines;
}

function reviewItems(cards) {
  const disputed = cards.filter((card) => card.tier === "DISPUTED");
  const groups = new Map();
  for (const card of disputed) {
    if (!groups.has(card.group)) groups.set(card.group, []);
    groups.get(card.group).push(card);
  }
  const items = [];
  for (const [group, list] of groups) {
    const all = cards.filter((card) => card.group === group);
    const candidates = new Map();
    const add = (label, stats, note) => {
      if (!stats || stats.length === 0 || stats.some((s) => s.value === null)) return;
      const key = listKey(stats);
      if (!candidates.has(key))
        candidates.set(key, { labels: [], stats: stats.map(statKey), note });
      candidates.get(key).labels.push(label);
    };
    for (const card of all) {
      const short = card.file.replace(/\.\w+$/, "");
      if (card.prodOut.length) add(`production output ${short}`, card.prodOut);
      else add(`production read (rejected) ${short}`, card.prodRead);
      add(`windows ocr ${short}`, card.winRead);
    }
    const unconfirmedOnly = (card) => card.disagreement.startsWith("value unconfirmed");
    const shownWrong = list.some((card) => card.verdict === "accepted" && !unconfirmedOnly(card));
    const rejected = list.some((card) => card.verdict !== "accepted");
    const impact = shownWrong ? 3 : rejected ? 2 : 1;
    items.push({
      group,
      impact,
      reasons: [...new Set(list.map((card) => card.disagreement))],
      files: all.map((card) => card.file),
      cards: all.map((card) => ({
        file: card.file,
        cls: card.cls,
        tier: card.tier,
        verdict: card.verdict,
        crop: `crops/${card.key}.png`,
        prodCrop: `crops/${card.key}-a0.jpg`,
        prodLines: card.prod.attempts.flatMap((a) =>
          a.lines.map((l) => `a${a.attempt} ${l.confidence.toFixed(2)} ${l.text}`),
        ),
        winRaw: card.win.readings.find((r) => r.mode === "plain" && r.sx === 3)?.raw ?? "",
      })),
      candidates: [...candidates.values()].map((c) => ({ ...c, labels: c.labels })),
    });
  }
  items.sort((a, b) => b.impact - a.impact || b.cards.length - a.cards.length);
  return items;
}

function reviewHtml(items, summaryLines) {
  const data = JSON.stringify({ items, summary: summaryLines }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Riven Scan Review</title>
<style>
:root { --bg: #f6f6f4; --fg: #1d1d1f; --muted: #66666c; --card: #ffffff; --line: #d8d8dc; --accent: #3b5bdb; --ok: #2b8a3e; --warn: #c92a2a; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececf0; --muted: #9a9aa2; --card: #212125; --line: #3a3a40; --accent: #7c97ff; --ok: #69db7c; --warn: #ff8787; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
header h1 { font-size: 17px; margin: 0; }
button { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { border-color: var(--accent); color: var(--accent); }
button.chosen { background: var(--accent); color: #fff; border-color: var(--accent); }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
.item { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 18px; }
.item.current { outline: 2px solid var(--accent); }
.item.done { opacity: 0.72; }
.meta { color: var(--muted); font-size: 13px; }
.crops { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
.crops figure { margin: 0; }
.crops img { display: block; width: min(100%, 560px); height: auto; border-radius: 6px; background: #000; }
.crops img.prod { width: min(100%, 360px); }
.crops figcaption { font-size: 12px; color: var(--muted); max-width: 560px; overflow-wrap: anywhere; }
.cands { display: grid; gap: 8px; margin: 10px 0; }
.cand { text-align: left; display: block; width: 100%; }
.cand .stats { font-family: ui-monospace, Consolas, monospace; font-size: 15px; }
.cand .labels { font-size: 12px; color: var(--muted); }
textarea { width: 100%; min-height: 96px; font: 14px ui-monospace, Consolas, monospace; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.status { font-weight: 600; }
.status.ok { color: var(--ok); }
.status.unreadable { color: var(--warn); }
details { margin-top: 8px; }
pre { white-space: pre-wrap; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Riven scan review</h1>
  <span id="progress" class="meta"></span>
  <span class="meta">Keys: 1-9 pick candidate, e edit, u unreadable, j/k next/previous</span>
  <button class="primary" id="download">Download JSON</button>
  <button id="copy">Copy JSON</button>
</header>
<main>
  <details><summary>Benchmark summary</summary><pre id="summary"></pre></details>
  <p class="meta">Each entry is one riven; every screenshot showing it is listed. Pick the reading that matches the card, type a correction (one stat per line, for example <code>+72,7 Fire Rate</code>, <code>x1,45 Damage to Infested</code>, <code>-66,2 Weapon Recoil</code>), or mark it unreadable. Decisions stay in this browser until exported.</p>
  <div id="list"></div>
</main>
<script type="application/json" id="data">${data}</script>
<script>
const DATA = JSON.parse(document.getElementById("data").textContent);
const KEY = "riven-review-decisions-v1";
let decisions = {};
try { decisions = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { decisions = {}; }
let current = 0;
function save() { try { localStorage.setItem(KEY, JSON.stringify(decisions)); } catch (e) {} render(); }
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v; else if (k.startsWith("on")) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}
function decide(item, decision) { decisions[item.files[0]] = { group: item.group, files: item.files, ...decision }; save(); }
function render() {
  document.getElementById("summary").textContent = DATA.summary.join("\\n");
  const list = document.getElementById("list");
  list.textContent = "";
  let done = 0;
  DATA.items.forEach((item, index) => {
    const d = decisions[item.files[0]];
    if (d) done++;
    const box = el("section", { class: "item" + (index === current ? " current" : "") + (d ? " done" : ""), id: "item-" + index, onclick: () => { current = index; } });
    const status = d ? (d.decision === "unreadable" ? el("span", { class: "status unreadable" }, "unreadable") : el("span", { class: "status ok" }, "decided: " + d.decision)) : el("span", { class: "status" }, "open");
    box.append(el("div", { class: "row" }, el("strong", {}, "#" + (index + 1) + " " + item.group), status, el("span", { class: "meta" }, "impact " + item.impact + ", " + item.cards.length + " screenshot(s): " + item.reasons.join("; "))));
    const crops = el("div", { class: "crops" });
    for (const card of item.cards) {
      crops.append(el("figure", {}, el("img", { src: card.crop, alt: card.file, loading: "lazy" }), el("figcaption", {}, card.file + " | " + card.cls + " | " + card.tier + " | production " + card.verdict)));
    }
    box.append(crops);
    const cands = el("div", { class: "cands" });
    item.candidates.forEach((cand, ci) => {
      const chosen = d && d.decision === "candidate" && d.candidate === ci;
      cands.append(el("button", { class: "cand" + (chosen ? " chosen" : ""), onclick: (ev) => { ev.stopPropagation(); current = index; decide(item, { decision: "candidate", candidate: ci, stats: cand.stats }); } },
        el("div", { class: "stats" }, (ci + 1) + ". " + cand.stats.join("   ")), el("div", { class: "labels" }, cand.labels.join(", "))));
    });
    box.append(cands);
    const area = el("textarea", { id: "edit-" + index, placeholder: "one stat per line" });
    area.value = d && d.stats ? d.stats.join("\\n") : (item.candidates[0] ? item.candidates[0].stats.join("\\n") : "");
    box.append(area);
    box.append(el("div", { class: "row" },
      el("button", { onclick: (ev) => { ev.stopPropagation(); current = index; decide(item, { decision: "typed", stats: area.value.split("\\n").map((s) => s.trim()).filter(Boolean) }); } }, "Save typed stats"),
      el("button", { onclick: (ev) => { ev.stopPropagation(); current = index; decide(item, { decision: "unreadable", stats: [] }); } }, "Unreadable"),
      el("button", { onclick: (ev) => { ev.stopPropagation(); current = index; delete decisions[item.files[0]]; save(); } }, "Clear")));
    const det = el("details", {}, el("summary", {}, "Raw OCR"));
    for (const card of item.cards) {
      det.append(el("pre", {}, card.file + "\\nproduction lines (attempt, confidence, text):\\n" + card.prodLines.join("\\n") + "\\nwindows ocr (x3): " + card.winRaw));
      det.append(el("img", { src: card.prodCrop, alt: "production input " + card.file, loading: "lazy", style: "max-width:100%;height:auto" }));
    }
    box.append(det);
    list.append(box);
  });
  document.getElementById("progress").textContent = done + " of " + DATA.items.length + " decided";
}
function exportJson() { return JSON.stringify(Object.values(decisions), null, 2); }
document.getElementById("download").addEventListener("click", () => {
  const blob = new Blob([exportJson()], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "riven-review-decisions.json" });
  document.body.append(a); a.click(); a.remove();
});
document.getElementById("copy").addEventListener("click", async () => {
  const text = exportJson();
  try { await navigator.clipboard.writeText(text); } catch (e) {
    const t = el("textarea", {}); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
  }
});
function go(delta) {
  current = Math.max(0, Math.min(DATA.items.length - 1, current + delta));
  render();
  document.getElementById("item-" + current).scrollIntoView({ block: "start", behavior: "smooth" });
}
document.addEventListener("keydown", (ev) => {
  if (ev.target.tagName === "TEXTAREA") return;
  const item = DATA.items[current];
  if (!item) return;
  if (ev.key >= "1" && ev.key <= "9") {
    const ci = Number(ev.key) - 1;
    if (item.candidates[ci]) { decide(item, { decision: "candidate", candidate: ci, stats: item.candidates[ci].stats }); go(1); }
  } else if (ev.key === "u") { decide(item, { decision: "unreadable", stats: [] }); go(1); }
  else if (ev.key === "e") { ev.preventDefault(); document.getElementById("edit-" + current).focus(); }
  else if (ev.key === "j") go(1);
  else if (ev.key === "k") go(-1);
});
render();
</script>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(BUILD, "ipc/overlay/rivenScanOcr.js"))) {
    throw new Error("Run pnpm run build:main before the Riven benchmark");
  }
  ({ parseRivenStats } = require(path.join(BUILD, "ipc/overlay/rivenScanText.js")));
  ({ levenshteinDistance } = require(path.join(BUILD, "services/rewardScannerUtils.js")));
  const { recognize } = require("@napi-rs/system-ocr");
  const cropsDir = path.join(args.out, "crops");
  fs.mkdirSync(cropsDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(args.out, "bench.log"));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-riven-bench-ocr-"));
  const scratch = path.join(scratchDir, "ocr.png");
  const decisions = args.decisions ? JSON.parse(fs.readFileSync(args.decisions, "utf8")) : [];
  const timing = {};
  const started = Date.now();

  let files = fs
    .readdirSync(args.src)
    .filter((name) => /\.(jpe?g|png)$/i.test(name))
    .sort();
  if (args.files) files = files.filter((name) => args.files.has(name));
  if (args.limit > 0) files = files.slice(0, args.limit);
  log(`${files.length} screenshots`);

  const cards = [];
  const all = [];
  try {
    const classifyStart = Date.now();
    for (const name of files) {
      const file = path.join(args.src, name);
      const meta = await sharp(file).metadata();
      const { cls, evidence } = await classify(recognize, scratch, file, meta.width, meta.height);
      const entry = { file: name, width: meta.width, height: meta.height, cls, evidence };
      all.push(entry);
      for (const job of jobsFor(cls)) {
        const key = `${name.replace(/\.\w+$/, "")}-${job.profile}`;
        cards.push({ ...entry, key, job: { ...job, key, file } });
      }
    }
    timing.classifyMs = Date.now() - classifyStart;
    log(
      `classified in ${timing.classifyMs} ms: ${tally(all, (e) => e.cls)
        .map(([k, v]) => `${k}=${v.length}`)
        .join(", ")}`,
    );

    const productionStart = Date.now();
    const { results, timing: prodTiming } = await runProduction(
      cards.map((card) => card.job),
      cropsDir,
      (done, total) => log(`production ${done}/${total}`),
    );
    timing.productionMs = Date.now() - productionStart;
    Object.assign(timing, prodTiming);
    const byKey = new Map(results.map((result) => [result.key, result]));
    for (const card of cards) card.prod = byKey.get(card.key);

    const winStart = Date.now();
    for (const [index, card] of cards.entries()) {
      const file = card.job.file;
      const rect = independentRect(card.width, card.height);
      await sharp(file)
        .extract(rect)
        .png()
        .toFile(path.join(cropsDir, `${card.key}.png`));
      const readings = [];
      const inputs = {};
      for (const variant of WIN_VARIANTS) {
        inputs[variant.mode] ??= await maskedRaw(file, rect, variant.mode);
        const reading = await winRead(recognize, scratch, inputs[variant.mode], variant);
        readings.push({ ...variant, ...reading });
      }
      card.win = { readings, vote: voteReadings(readings) };
      const prodCrop = path.join(cropsDir, `${card.key}-prodstat.png`);
      if (fs.existsSync(prodCrop)) {
        const meta = await sharp(prodCrop).metadata();
        const input = { file: prodCrop, width: meta.width, height: meta.height };
        card.winProdCrop = [];
        for (const variant of WIN_VARIANTS.filter((v) => v.mode === "plain").slice(1, 5)) {
          card.winProdCrop.push({
            ...variant,
            ...(await winRead(recognize, scratch, input, variant)),
          });
        }
      }
      if ((index + 1) % 25 === 0) log(`windows reader ${index + 1}/${cards.length}`);
    }
    timing.winMs = Date.now() - winStart;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  const analyzed = analyze(cards, decisions);
  timing.totalMs = Date.now() - started;
  const summaryLines = summarize(all, analyzed, timing);
  const items = reviewItems(analyzed);
  summaryLines.push(
    `review queue: ${items.length} riven groups, ${items.reduce((n, i) => n + i.cards.length, 0)} screenshots`,
  );
  fs.writeFileSync(
    path.join(args.out, "results.json"),
    JSON.stringify({ screenshots: all, cards: analyzed }, null, 1),
  );
  fs.writeFileSync(path.join(args.out, "summary.txt"), `${summaryLines.join("\n")}\n`);
  fs.writeFileSync(path.join(args.out, "review.html"), reviewHtml(items, summaryLines));
  for (const line of summaryLines) log(line);
  logStream.end();
}

main().catch((error) => {
  console.error(error);
  logStream?.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
