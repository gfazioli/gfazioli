#!/usr/bin/env node
/**
 * Renders cards/<repo>.svg, a repository's card for its own README: hero,
 * stat tiles, a year of commits, the weekly rhythm, languages and essentials,
 * latest commits and releases, contributors — laid out like FinderGit's
 * repository view, drawn from GitHub's public data.
 *
 * One card per repository listed in scripts/repo-cards.json. Zero
 * dependencies (Node >= 20, global fetch). Run by
 * .github/workflows/github-stats.yml once a day, beside the profile card;
 * locally:
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/repo-card.mjs            # every listed repo
 *   GITHUB_TOKEN=$(gh auth token) node scripts/repo-card.mjs octoscope  # just one
 *
 * A project's README embeds its card from this repository, so the daily commit
 * lands here and the project's own history stays free of bot commits:
 *
 *   <img src="https://raw.githubusercontent.com/gfazioli/gfazioli/master/cards/<repo>.svg" width="880" alt="…" />
 *
 * Every number is public whatever token renders it (a repository's public
 * data reads the same to any viewer). Commit times are read in one time zone,
 * repo-cards.json `timeZone`: the API returns them in UTC and drops the
 * author's offset, while the calendar and the rhythm need a local day and hour.
 *
 * An <img> renders an SVG in isolation — no external fonts, images or scripts —
 * so avatars are embedded as data URIs and the text uses the system font,
 * whose widths are estimated from GLYPHS to fit chips and clip long lines.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { OCTICONS } from "./octicons.mjs";

const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = "cards";

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required (locally: GITHUB_TOKEN=$(gh auth token))");
  process.exit(1);
}

const CONFIG = JSON.parse(await readFile(new URL("./repo-cards.json", import.meta.url), "utf8"));
const TZ = CONFIG.timeZone || "UTC";

// ─── Data ────────────────────────────────────────────────────────────────────

const HEADERS = {
  Authorization: `bearer ${TOKEN}`,
  "User-Agent": "gfazioli-repo-card",
};

// GitHub answers a heavy query with a 502 now and then; a second try usually
// lands.
async function request(url, init, attempt = 1) {
  const res = await fetch(url, init);
  if (res.status >= 500 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return request(url, init, attempt + 1);
  }
  return res;
}

async function graphql(query, variables) {
  const res = await request("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

async function rest(path) {
  const res = await request(`https://api.github.com${path}`, {
    headers: { ...HEADERS, Accept: "application/vnd.github+json" },
  });
  if (res.status === 204) return { data: [], link: "" };
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return { data: await res.json(), link: res.headers.get("link") ?? "" };
}

const REPO_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    name nameWithOwner description homepageUrl createdAt pushedAt diskUsage isArchived
    stargazerCount forkCount
    watchers { totalCount }
    licenseInfo { spdxId }
    isSecurityPolicyEnabled
    repositoryTopics(first: 20) { nodes { topic { name } } }
    languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
      totalSize
      edges { size node { name color } }
    }
    branches: refs(refPrefix: "refs/heads/") { totalCount }
    tags: refs(refPrefix: "refs/tags/", first: 1, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      totalCount
      nodes { name }
    }
    openIssues: issues(states: OPEN) { totalCount }
    closedIssues: issues(states: CLOSED) { totalCount }
    openPRs: pullRequests(states: OPEN) { totalCount }
    mergedPRs: pullRequests(states: MERGED) { totalCount }
    releases(first: 5, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes { tagName publishedAt description }
    }
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 6) {
            totalCount
            nodes { abbreviatedOid messageHeadline authoredDate author { name user { login } } }
          }
        }
      }
    }
  }
}`;

const RELEASES_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    releases(first: 100, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { publishedAt releaseAssets(first: 100) { nodes { downloadCount } } }
    }
  }
}`;

const HISTORY_QUERY = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, since: $since, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { authoredDate }
          }
        }
      }
    }
  }
}`;

// A year of a busy repository is a few thousand commits; past this many pages
// the calendar would cost more than it tells.
const MAX_HISTORY_PAGES = 50;

async function fetchReleases(owner, name) {
  const releases = [];
  let after = null;
  do {
    const page = (await graphql(RELEASES_QUERY, { owner, name, after })).repository.releases;
    releases.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return releases;
}

async function fetchHistory(owner, name, since) {
  const dates = [];
  let after = null;
  let pages = 0;
  do {
    const repo = (await graphql(HISTORY_QUERY, { owner, name, since, after })).repository;
    const page = repo.defaultBranchRef.target.history;
    dates.push(...page.nodes.map((c) => c.authoredDate));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after && ++pages < MAX_HISTORY_PAGES);
  return dates;
}

async function fetchContributors(full) {
  const { data, link } = await rest(`/repos/${full}/contributors?per_page=100`);
  let total = data.length;
  if (/rel="next"/.test(link)) {
    const last = await rest(`/repos/${full}/contributors?per_page=1`);
    total = Number(last.link.match(/[?&]page=(\d+)>; rel="last"/)?.[1] ?? total);
  }
  return { list: data, total };
}

async function fetchTree(full, branch) {
  const { data } = await rest(`/repos/${full}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  return data.tree ?? [];
}

async function fetchImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

// ─── Time ────────────────────────────────────────────────────────────────────

const DAY = 24 * 3600 * 1000;
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });

/** The YYYY-MM-DD an instant falls on in TZ. */
const localDay = (iso) => dayFormat.format(new Date(iso));
const localHour = (iso) => Number(hourFormat.format(new Date(iso)));
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day, n) => new Date(dayMs(day) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / DAY);
/** Monday 0 … Sunday 6. */
const weekday = (day) => (new Date(dayMs(day)).getUTCDay() + 6) % 7;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function ago(iso, today) {
  const d = daysBetween(localDay(iso), today);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  if (d < 14) return "last week";
  if (d < 30) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 60) return "last month";
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  const y = Math.floor(d / 365);
  return y === 1 ? "last year" : `${y} years ago`;
}

function age(createdAt, now) {
  const from = new Date(createdAt);
  const months =
    (now.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - from.getUTCMonth()) -
    (now.getUTCDate() < from.getUTCDate() ? 1 : 0);
  if (months < 1) return "new";
  if (months < 24) return `${months} month${months === 1 ? "" : "s"}`;
  return `${Math.floor(months / 12)} years`;
}

function cadence(dates) {
  const recent = dates.slice(0, 10);
  if (recent.length < 2) return null;
  const span = (Date.parse(recent[0]) - Date.parse(recent.at(-1))) / DAY;
  const every = span / (recent.length - 1);
  if (every < 1.5) return "One a day";
  if (every < 10) return `One every ${Math.round(every)} days`;
  if (every < 45) {
    const w = Math.round(every / 7);
    return w === 1 ? "One a week" : `One every ${w} weeks`;
  }
  const m = Math.round(every / 30);
  return m === 1 ? "One a month" : `One every ${m} months`;
}

// ─── Text ────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const full = (n) => n.toLocaleString("en-US");

function compact(n) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

function size(kb) {
  if (kb < 1024) return [String(kb), "KB"];
  const mb = kb / 1024;
  if (mb < 1024) return [mb < 100 ? mb.toFixed(1) : String(Math.round(mb)), "MB"];
  return [(mb / 1024).toFixed(1), "GB"];
}

const plural = (n, one, many = `${one}s`) => `${full(n)} ${n === 1 ? one : many}`;

// Advance widths of ASCII 32–126 per 100 px, measured in Chrome on macOS for
// the card's font stack. The system font widens its letters at small sizes,
// so body text (under 20 px) reads the 12.5 px table and the big numbers the
// 34 px one. Segoe UI and Noto Sans run narrower or within a few percent,
// which SLACK covers.
const GLYPHS = {
  text: {
    400: [28,31,48,63,63,92,71,29,38,38,47,62,29,47,29,30,63,46,60,62,64,62,63,58,64,63,29,29,62,62,62,51,92,67,65,71,72,59,57,74,74,26,54,66,56,87,74,77,63,77,65,63,62,73,67,96,68,65,66,38,30,38,63,54,50,55,61,56,61,57,36,60,58,24,24,54,25,87,58,58,61,60,39,51,36,58,54,77,52,54,54,38,26,38,63],
    600: [26,34,54,66,66,100,73,33,41,41,48,65,33,48,33,32,66,49,63,65,67,64,66,61,67,66,33,33,65,65,65,54,92,71,68,73,74,61,59,75,77,30,58,69,58,89,76,78,66,78,68,66,64,75,70,99,71,68,67,41,32,41,66,57,50,57,64,57,64,58,39,63,62,27,27,58,28,91,61,60,63,63,42,54,40,61,57,82,56,58,55,41,28,41,66],
    700: [25,35,57,67,67,103,74,34,43,43,48,67,34,48,34,33,68,51,64,67,68,66,68,62,69,68,34,34,67,66,67,55,92,73,69,74,74,62,60,76,78,32,60,71,59,90,76,78,67,78,69,67,65,76,72,100,73,70,67,43,33,43,67,59,50,59,65,58,65,60,41,64,63,28,28,60,29,93,62,61,64,64,44,55,41,62,58,84,58,59,56,43,30,43,67],
  },
  display: {
    400: [22,28,42,62,62,82,68,26,33,33,41,61,23,44,23,29,62,46,58,60,62,60,63,56,61,63,23,23,61,61,61,50,89,65,62,70,69,56,54,72,71,24,51,61,54,84,71,74,59,74,61,60,58,71,64,94,65,62,63,33,29,33,62,52,51,51,56,51,56,52,32,56,55,22,22,50,22,82,54,54,56,56,32,48,31,54,49,73,48,50,48,33,23,33,62],
    600: [21,31,45,64,64,87,70,28,37,37,45,64,24,45,24,31,65,48,60,63,64,62,65,57,64,65,24,24,64,64,64,53,90,68,64,71,70,58,55,73,73,26,55,65,55,86,72,76,62,76,64,63,60,72,67,96,68,66,64,37,31,37,65,56,51,54,59,54,59,55,35,59,58,24,24,53,24,86,57,57,59,59,36,51,35,57,53,78,52,54,50,37,24,37,64],
    700: [21,33,47,65,66,90,71,29,39,39,48,66,25,45,25,31,67,49,61,64,66,64,66,58,66,66,25,25,66,66,66,54,90,70,65,72,71,58,56,74,74,28,57,66,55,87,73,76,63,76,65,64,61,72,69,98,70,67,64,39,31,39,67,57,51,56,61,56,61,57,37,60,60,25,25,55,25,88,59,58,60,60,38,53,37,59,55,80,54,56,52,39,25,39,66],
  },
};
// The few non-ASCII characters the card writes itself.
const EXTRA = { "·": 33, "—": 90, "…": 90, "’": 33 };
const SLACK = 1.02;

function textWidth(s, size, weight = 400, mono = false) {
  const table = GLYPHS[size < 20 ? "text" : "display"][weight >= 650 ? 700 : weight >= 500 ? 600 : 400];
  let units = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (mono) units += c < 0x2e80 ? 60 : 100;
    else units += c >= 32 && c < 127 ? table[c - 32] : (EXTRA[ch] ?? (c < 0x2e80 ? 66 : 100));
  }
  return (units * size * SLACK) / 100;
}

/** `s` clipped with an ellipsis to fit `max` px, never inside a surrogate pair. */
function fit(s, max, size, weight = 400, mono = false) {
  const t = String(s);
  if (textWidth(t, size, weight, mono) <= max) return t;
  const chars = Array.from(t);
  while (chars.length > 1 && textWidth(`${chars.join("")}…`, size, weight, mono) > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

/** `s` broken into at most `lines` lines of `max` px, the last one clipped. */
function wrap(s, max, size, weight, lines) {
  const out = [];
  let line = "";
  const words = String(s).split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (textWidth(next, size, weight) <= max || !line) {
      line = next;
      continue;
    }
    if (out.length === lines - 1) return [...out, fit([line, ...words.slice(i)].join(" "), max, size, weight)];
    out.push(line);
    line = words[i];
  }
  if (line) out.push(fit(line, max, size, weight));
  return out;
}

/** The first line of a release note that reads as prose, Markdown removed. */
function excerpt(body) {
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw
      .replace(/<[^>]+>/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]+/g, "")
      .replace(/^\s*(?:[-+>]|\d+\.)\s+/, "")
      .trim();
    if (line && !/^#/.test(raw.trim())) return line;
  }
  return "";
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

const W = 880;
const PAD = 24;
const IW = W - PAD * 2;
const GAP = 12;
const SECTION = 16;
const HALF = (IW - SECTION) / 2;

const C = {
  green: "#4ade80",
  teal: "#2dd4bf",
  cyan: "#22d3ee",
  sky: "#38bdf8",
  blue: "#60a5fa",
  indigo: "#818cf8",
  purple: "#c084fc",
  rose: "#fb7185",
  orange: "#fb923c",
  yellow: "#facc15",
  slate: "#94a3b8",
  muted: "rgba(230,237,243,0.5)",
};

const LEVEL_FILL = ["rgba(255,255,255,0.07)", "#0e4429", "#006d32", "#26a641", "#39d353"];

function icon(name, x, y, fill, size = 16) {
  const s = size / 16;
  const paths = OCTICONS[name].map((d) => `<path d="${d}"/>`).join("");
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="${fill}">${paths}</g>`;
}

function panel(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" class="panel"/>`;
}

function panelTitle(x, y, name, color, title, right) {
  return `
  ${icon(name, x + 18, y + 16, color)}
  <text x="${x + 42}" y="${y + 29}" class="title" style="fill: ${color}">${esc(title)}</text>${
    right ? `\n  <text x="${right.x}" y="${y + 29}" class="caption" text-anchor="end">${esc(right.text)}</text>` : ""
  }`;
}

/**
 * A pill: an optional icon, a label and an optional bold value. Returns its
 * markup and width so callers can flow pills along a row.
 */
function pill(x, y, { label, value, icon: name, color = C.muted, fill = "rgba(255,255,255,0.06)", stroke = "rgba(255,255,255,0.08)", labelClass = "pill" }) {
  const h = 22;
  const padX = 9;
  const iconW = name ? 18 : 0;
  const labelW = textWidth(label, 11.5, value ? 400 : 600);
  const valueW = value ? 5 + textWidth(value, 11.5, 700) : 0;
  const w = padX * 2 + iconW + labelW + valueW;
  const tx = x + padX + iconW;
  const svg = `
  <rect x="${x}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}"/>
  ${name ? icon(name, x + padX - 1, y + 4, color, 14) : ""}
  <text x="${tx.toFixed(1)}" y="${y + 15}" class="${value ? "pill-k" : labelClass}">${esc(label)}${
    value ? `<tspan dx="5" class="pill-v">${esc(value)}</tspan>` : ""
  }</text>`;
  return { svg, w };
}

/** Pills flowed left to right, wrapping within `maxW`, at most `rows` rows. */
function flow(x, y, maxW, items, rows = Infinity, rowStep = 30) {
  let cx = x;
  let row = 0;
  const out = [];
  for (const item of items) {
    const probe = pill(0, 0, item);
    if (cx > x && cx + probe.w > x + maxW) {
      if (row + 1 >= rows) break;
      row += 1;
      cx = x;
    }
    out.push(pill(cx, y + row * rowStep, item).svg);
    cx += probe.w + 8;
  }
  return { svg: out.join(""), h: (row + 1) * rowStep - (rowStep - 22) };
}

function header(r, updated, y) {
  return `
  <text x="${PAD + 2}" y="${y + 24}" class="h-name">${esc(r.name)}</text>
  <text x="${PAD + 2}" y="${y + 46}" class="h-sub">${esc(`${r.nameWithOwner} · ${r.defaultBranchRef.name}`)}</text>
  <text x="${W - PAD - 2}" y="${y + 22}" class="updated" text-anchor="end">Updated ${updated}</text>`;
}

function sparkline(values, x, y, w, h) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [x + (i * w) / (values.length - 1), y + h - (v / max) * (h - 4)]);
  const clamp = (v) => Math.min(y + h, Math.max(y, v));
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1] ?? pts[i], pts[i], pts[i + 1], pts[i + 2] ?? pts[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return `
  <path d="${d} L${x + w} ${y + h} L${x} ${y + h} Z" fill="url(#spark)"/>
  <path d="${d}" fill="none" stroke="${C.green}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function hero(s, y) {
  const r = s.repo;
  const x = PAD;
  const rightW = 250;
  const leftW = IW - 36 - rightW - 28;
  const lx = x + 18;
  const parts = [];

  const status = r.isArchived
    ? { label: "Archived", color: C.slate }
    : s.idleDays <= 30
      ? { label: "Active", color: C.green }
      : s.idleDays <= 180
        ? { label: "Quiet", color: C.yellow }
        : { label: "Dormant", color: C.slate };
  const since = new Date(r.createdAt);
  const badges = [
    { label: status.label, icon: "pulse", color: status.color, fill: `${status.color}26`, stroke: `${status.color}33` },
    { label: `Since ${MONTHS[since.getUTCMonth()]} ${since.getUTCFullYear()} · ${age(r.createdAt, s.now)}`, icon: "calendar", color: C.blue, fill: `${C.blue}26`, stroke: `${C.blue}33` },
  ];
  if (s.latestTag) badges.push({ label: s.latestTag, icon: "tag", color: C.cyan, fill: `${C.cyan}26`, stroke: `${C.cyan}33` });
  let cy = y + 18;
  const badgeRow = flow(lx, cy, leftW, badges, 1);
  parts.push(badgeRow.svg);
  cy += badgeRow.h + 14;

  if (r.description) {
    const lines = wrap(r.description, leftW, 15, 700, 2);
    lines.forEach((line, i) => parts.push(`<text x="${lx}" y="${cy + 14 + i * 21}" class="desc">${esc(line)}</text>`));
    cy += 14 + (lines.length - 1) * 21 + 14;
  }

  const topics = r.repositoryTopics.nodes.map((t) => ({ label: t.topic.name }));
  if (topics.length) {
    const row = flow(lx, cy, leftW, topics, 2, 28);
    parts.push(row.svg);
    cy += row.h + 10;
  }

  const links = [{ label: `github.com/${r.nameWithOwner}`, icon: "mark-github" }];
  if (r.homepageUrl) links.push({ label: r.homepageUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""), icon: "link" });
  const linkRow = flow(lx, cy, leftW, links.map((l) => ({ ...l, color: "rgba(230,237,243,0.7)", fill: "rgba(255,255,255,0.05)" })), 1);
  parts.push(linkRow.svg);
  cy += linkRow.h + 18;

  const h = Math.max(cy - y, 168);
  const rx = x + IW - 18 - rightW;
  const big = full(s.last30);
  const bigW = textWidth(big, 34, 700) / SLACK;
  return {
    h,
    svg: `
  <rect x="${x}" y="${y}" width="${IW}" height="${h}" rx="16" fill="url(#hero)" stroke="${C.green}40"/>
  ${parts.join("")}
  <text x="${rx}" y="${y + 50}" class="big">${big}</text>
  <text x="${(rx + bigW + 8).toFixed(1)}" y="${y + 50}" class="big-cap">commits in 30 days</text>
  ${sparkline(s.weekly, rx, y + 66, rightW, h - 66 - 38)}
  <text x="${rx}" y="${y + h - 16}" class="axis">${s.weekly.length} weeks ago</text>
  <text x="${rx + rightW}" y="${y + h - 16}" class="axis" text-anchor="end">This week</text>`,
  };
}

function tiles(items, y) {
  const cols = 6;
  const w = (IW - GAP * (cols - 1)) / cols;
  const h = 98;
  const inner = w - 28;
  const svg = items
    .map((t, i) => {
      const x = PAD + (i % cols) * (w + GAP);
      const ty = y + Math.floor(i / cols) * (h + GAP);
      return `
  <g>
    <rect x="${x.toFixed(1)}" y="${ty}" width="${w.toFixed(1)}" height="${h}" rx="14" fill="url(#tile-${i})" stroke="rgba(255,255,255,0.10)"/>
    ${icon(t.icon, x + 14, ty + 14, t.color)}
    <text x="${(x + 14).toFixed(1)}" y="${ty + 60}" class="value">${esc(t.value)}${t.unit ? `<tspan dx="4" class="unit">${t.unit}</tspan>` : ""}</text>
    <text x="${(x + 14).toFixed(1)}" y="${ty + 78}" class="label">${esc(fit(t.label, inner, 12, 600))}</text>
    <text x="${(x + 14).toFixed(1)}" y="${ty + 91}" class="sub">${esc(fit(t.sub, inner, 10.5))}</text>
  </g>`;
    })
    .join("");
  return { svg, h: Math.ceil(items.length / cols) * (h + GAP) - GAP };
}

function tileGradients(items) {
  return items
    .map(
      (t, i) => `
    <linearGradient id="tile-${i}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.color}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="${t.color}" stop-opacity="0.08"/>
    </linearGradient>`,
    )
    .join("");
}

function activity(s, y) {
  const x = PAD;
  const step = 14;
  const cell = 11;
  const weeks = s.grid;
  const gridW = weeks.length * step - (step - cell);
  const labelW = 30;
  const gx = x + (IW - gridW - labelW) / 2 + labelW;
  const gy = y + 100;
  const h = 100 + 7 * step + 34;

  const level = (n) => (n === 0 ? 0 : n <= s.quartiles[0] ? 1 : n <= s.quartiles[1] ? 2 : n <= s.quartiles[2] ? 3 : 4);
  const cells = weeks
    .flatMap((week, wi) =>
      week.map((d, di) => {
        if (!d) return "";
        const today = d.day === s.today ? ` stroke="${C.green}" stroke-width="1.5"` : "";
        return `<rect x="${gx + wi * step}" y="${gy + di * step}" width="${cell}" height="${cell}" rx="2.5" fill="${LEVEL_FILL[level(d.count)]}"${today}/>`;
      }),
    )
    .join("");

  // A month label sits over the first week that starts in that month; labels
  // closer than three weeks apart would overlap, so the earlier one is dropped.
  const marks = [];
  weeks.forEach((week, wi) => {
    const m = Number(week[0].day.slice(5, 7)) - 1;
    const prev = wi > 0 ? Number(weeks[wi - 1][0].day.slice(5, 7)) - 1 : -1;
    if (m !== prev) marks.push({ wi, m });
  });
  const kept = marks.filter((mk, i) => !(marks[i + 1] && marks[i + 1].wi - mk.wi < 3));
  const months = kept
    .map((mk) => `<text x="${gx + mk.wi * step}" y="${gy - 8}" class="axis">${MONTHS[mk.m]}</text>`)
    .join("");
  const days = [
    [0, "Mon"],
    [2, "Wed"],
    [4, "Fri"],
  ]
    .map(([r, n]) => `<text x="${gx - 8}" y="${gy + r * step + 9}" class="axis" text-anchor="end">${n}</text>`)
    .join("");

  const lx = gx + gridW - LEVEL_FILL.length * step - 30;
  const legend = `
  <text x="${lx - 8}" y="${y + h - 16}" class="axis" text-anchor="end">Less</text>
  ${LEVEL_FILL.map((f, i) => `<rect x="${lx + i * step}" y="${y + h - 25}" width="${cell}" height="${cell}" rx="2.5" fill="${f}"/>`).join("")}
  <text x="${lx + LEVEL_FILL.length * step + 5}" y="${y + h - 16}" class="axis">More</text>`;

  const chips = flow(x + 18, y + 44, IW - 36, [
    { label: "Current streak", value: plural(s.streak, "day"), icon: "flame", color: C.orange },
    { label: "Longest streak", value: plural(s.longest, "day"), icon: "trophy", color: C.yellow },
    { label: "Active days", value: full(s.activeDays), icon: "calendar", color: C.green },
  ]);

  return {
    h,
    svg: `
  ${panel(x, y, IW, h)}
  ${panelTitle(x, y, "apps", C.green, "Activity", { x: x + IW - 18, text: `${plural(s.yearCommits, "commit")} in the last year` })}
  ${chips.svg}
  ${months}${days}${cells}${legend}`,
  };
}

function rhythm(s, x, y, h) {
  const labelW = 22;
  const gx = x + 18 + labelW;
  const step = (HALF - 36 - labelW) / 24;
  const rowStep = 21;
  const gy = y + 96;
  const max = Math.max(1, ...s.punch.flat());
  const dots = s.punch
    .flatMap((row, d) =>
      row.map((n, hr) => {
        const cx = (gx + hr * step + step / 2).toFixed(1);
        const cy = gy + d * rowStep;
        if (n === 0) return `<circle cx="${cx}" cy="${cy}" r="1.2" fill="rgba(255,255,255,0.16)"/>`;
        const k = n / max;
        return `<circle cx="${cx}" cy="${cy}" r="${(2 + Math.sqrt(k) * 5.2).toFixed(2)}" fill="${C.rose}" fill-opacity="${(0.5 + 0.5 * k).toFixed(2)}"/>`;
      }),
    )
    .join("");
  const rows = ["M", "T", "W", "T", "F", "S", "S"]
    .map((l, d) => `<text x="${x + 22}" y="${gy + d * rowStep + 3.5}" class="axis">${l}</text>`)
    .join("");
  const hours = [0, 6, 12, 18]
    .map((hr) => `<text x="${(gx + hr * step + step / 2).toFixed(1)}" y="${gy + 6 * rowStep + 24}" class="axis" text-anchor="middle">${hr}</text>`)
    .join("");
  const chips = flow(
    x + 18,
    y + 44,
    HALF - 36,
    s.yearCommits
      ? [
          { label: "Busiest day", value: s.busiestDay, icon: "sun", color: C.yellow },
          { label: "Peak hour", value: String(s.peakHour), icon: "zap", color: C.rose },
        ]
      : [{ label: "No commits in the last year", icon: "sun", color: C.slate }],
  );
  return `
  ${panel(x, y, HALF, h)}
  ${panelTitle(x, y, "clock", C.rose, "Rhythm")}
  ${chips.svg}
  ${rows}${dots}${hours}`;
}

function code(s, x, y, h) {
  const w = HALF;
  const barX = x + 18;
  const barW = w - 36;
  const barY = y + 46;
  let cursor = barX;
  const segments = s.languages
    .map((l) => {
      const sw = l.share * barW;
      const seg = `<rect x="${cursor.toFixed(2)}" y="${barY}" width="${Math.max(0, sw - 1).toFixed(2)}" height="10" fill="${l.color}"/>`;
      cursor += sw;
      return seg;
    })
    .join("");
  const colW = (barW - 24) / 2;
  const rows = s.languages
    .map((l, i) => {
      const lx = barX + (i % 2) * (colW + 24);
      const ly = y + 86 + Math.floor(i / 2) * 22;
      return `
    <circle cx="${lx + 5}" cy="${ly - 4}" r="4.5" fill="${l.color}"/>
    <text x="${lx + 17}" y="${ly}" class="row">${esc(fit(l.name, colW - 70, 12.5, 500))}</text>
    <text x="${lx + colW}" y="${ly}" class="pct" text-anchor="end">${(l.share * 100).toFixed(1)}%</text>`;
    })
    .join("");
  const legendBottom = y + 86 + Math.ceil(s.languages.length / 2) * 22 - 8;
  const essentials = flow(
    barX,
    legendBottom + 40,
    barW,
    s.essentials.map((e) =>
      e.ok
        ? { label: e.label, icon: "check-circle-fill", color: C.green, fill: "rgba(74,222,128,0.10)", stroke: "rgba(74,222,128,0.18)" }
        : { label: e.label, icon: "x-circle", color: "rgba(230,237,243,0.4)", labelClass: "pill-off", fill: "rgba(255,255,255,0.03)", stroke: "rgba(255,255,255,0.08)" },
    ),
  );
  return `
  ${panel(x, y, w, h)}
  ${panelTitle(x, y, "code", C.sky, "Code", { x: x + w - 18, text: plural(s.files, "file") })}
  <clipPath id="langbar"><rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5"/></clipPath>
  <g clip-path="url(#langbar)"><rect x="${barX}" y="${barY}" width="${barW}" height="10" fill="rgba(255,255,255,0.08)"/>${segments}</g>
  ${rows}
  <line x1="${barX}" y1="${legendBottom + 4}" x2="${barX + barW}" y2="${legendBottom + 4}" stroke="rgba(255,255,255,0.08)"/>
  <text x="${barX}" y="${legendBottom + 28}" class="section">Essentials</text>
  ${essentials.svg}`;
}

function codeHeight(s) {
  return 86 + Math.ceil(s.languages.length / 2) * 22 - 8 + 40 + 2 * 30 + 4;
}

function commits(s, x, y, h) {
  const w = HALF;
  const rows = s.commits
    .map((c, i) => {
      const ry = y + 66 + i * 46;
      const who = c.author?.user?.login ?? c.author?.name ?? "unknown";
      return `
    <circle cx="${x + 25}" cy="${ry - 5}" r="5.5" fill="none" stroke="${C.indigo}" stroke-width="2.2"/>
    <text x="${x + 42}" y="${ry}" class="commit">${esc(fit(c.messageHeadline, w - 60, 13, 600))}</text>
    <text x="${x + 42}" y="${ry + 17}" class="meta"><tspan class="mono">${esc(c.abbreviatedOid)}</tspan> · ${esc(fit(who, 150, 11))} · ${ago(c.authoredDate, s.today)}</text>`;
    })
    .join("");
  return `
  ${panel(x, y, w, h)}
  ${panelTitle(x, y, "history", C.indigo, "Latest commits", { x: x + w - 18, text: `${plural(s.totalCommits, "commit")} on ${s.repo.defaultBranchRef.name}` })}
  ${rows}`;
}

function releases(s, x, y, h) {
  const w = HALF;
  const list = s.repo.releases.nodes;
  const top = y + (s.cadence ? 98 : 66);
  const rows = list
    .map((rel, i) => {
      const ry = top + i * 46;
      const when = ago(rel.publishedAt, s.today);
      const whenW = textWidth(when, 11);
      return `
    <circle cx="${x + 27}" cy="${ry - 5}" r="9" fill="#0e3a52" stroke="${C.sky}" stroke-width="1.2"/>
    ${icon("tag", x + 21, ry - 11, C.sky, 12)}
    <text x="${x + 46}" y="${ry}" class="tagname">${esc(fit(rel.tagName, w - 80 - whenW, 13, 700, true))}</text>
    <text x="${x + w - 18}" y="${ry}" class="meta" text-anchor="end">${when}</text>
    <text x="${x + 46}" y="${ry + 17}" class="excerpt">${esc(fit(excerpt(rel.description), w - 64, 11.5))}</text>`;
    })
    .join("");
  const line =
    list.length > 1
      ? `<line x1="${x + 27}" y1="${top - 5}" x2="${x + 27}" y2="${top - 5 + (list.length - 1) * 46}" stroke="${C.sky}" stroke-opacity="0.35" stroke-width="2"/>`
      : "";
  const empty = list.length ? "" : `<text x="${x + 18}" y="${y + 70}" class="excerpt">No releases yet.</text>`;
  const chip = s.cadence ? flow(x + 18, y + 44, w - 36, [{ label: "Cadence", value: s.cadence, icon: "stopwatch", color: C.sky }]).svg : "";
  return `
  ${panel(x, y, w, h)}
  ${panelTitle(x, y, "package", C.sky, "Releases", { x: x + w - 18, text: plural(s.repo.releases.totalCount, "release") })}
  ${chip}${line}${rows}${empty}`;
}

function contributors(s, y) {
  const x = PAD;
  const shown = s.contributors.slice(0, 6);
  const rowH = 46;
  const h = 58 + shown.length * rowH + 22;
  const max = Math.max(1, ...shown.map((c) => c.contributions));
  const trackX = x + 62;
  const trackW = IW - 18 - (trackX - x);
  const rows = shown
    .map((c, i) => {
      const ry = y + 58 + i * rowH;
      const cx = x + 32;
      const cy = ry + 10;
      const face = c.avatar
        ? `<clipPath id="av-${i}"><circle cx="${cx}" cy="${cy}" r="14"/></clipPath><image href="${c.avatar}" x="${cx - 14}" y="${cy - 14}" width="28" height="28" clip-path="url(#av-${i})" preserveAspectRatio="xMidYMid slice"/>`
        : `<circle cx="${cx}" cy="${cy}" r="14" fill="#3b4256"/>`;
      return `
    ${face}
    <circle cx="${cx}" cy="${cy}" r="14.5" fill="none" stroke="rgba(255,255,255,0.18)"/>
    <text x="${trackX}" y="${ry + 6}" class="who">${esc(c.login)}</text>
    <text x="${x + IW - 18}" y="${ry + 6}" class="count" text-anchor="end">${full(c.contributions)}</text>
    <rect x="${trackX}" y="${ry + 15}" width="${trackW}" height="4" rx="2" fill="rgba(255,255,255,0.08)"/>
    <rect x="${trackX}" y="${ry + 15}" width="${Math.max(4, (c.contributions / max) * trackW).toFixed(1)}" height="4" rx="2" fill="${C.orange}"/>`;
    })
    .join("");
  const more = s.contributorCount > shown.length ? ` · ${s.contributorCount - shown.length} more not shown` : "";
  return {
    h,
    svg: `
  ${panel(x, y, IW, h)}
  ${panelTitle(x, y, "people", C.orange, "Contributors", { x: x + IW - 18, text: plural(s.contributorCount, "contributor") })}
  ${rows}
  <text x="${x + 18}" y="${y + h - 14}" class="foot">Commits on ${esc(s.repo.defaultBranchRef.name)}, according to GitHub${more}</text>`,
  };
}

// ─── Model ───────────────────────────────────────────────────────────────────

const ESSENTIALS = [
  ["README", (p) => /^(\.github\/|docs\/)?readme(\.|$)/i.test(p)],
  ["License", (p, r) => /^(licen[cs]e|copying)(\.|$)/i.test(p) || Boolean(r.licenseInfo)],
  [".gitignore", (p) => p === ".gitignore"],
  ["Contributing", (p) => /^(\.github\/|docs\/)?contributing(\.|$)/i.test(p)],
  ["Security policy", (p, r) => /^(\.github\/|docs\/)?security(\.|$)/i.test(p) || r.isSecurityPolicyEnabled],
  ["CI", (p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)],
];

async function model(full) {
  const [owner, name] = full.split("/");
  const now = new Date();
  const today = localDay(now);
  const repo = (await graphql(REPO_QUERY, { owner, name })).repository;
  if (!repo.defaultBranchRef) throw new Error(`${full} has no default branch`);

  // Weeks run Monday to Sunday; the last column is the current week.
  const firstWeek = addDays(addDays(today, -weekday(today)), -52 * 7);
  const [dates, allReleases, contribs, tree] = await Promise.all([
    fetchHistory(owner, name, `${addDays(firstWeek, -1)}T00:00:00Z`),
    fetchReleases(owner, name),
    fetchContributors(full),
    fetchTree(full, repo.defaultBranchRef.name),
  ]);

  const perDay = new Map();
  const punch = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const iso of dates) {
    const day = localDay(iso);
    if (day < firstWeek || day > today) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    punch[weekday(day)][localHour(iso)] += 1;
  }

  const grid = [];
  for (let wi = 0; wi < 53; wi++) {
    grid.push(
      Array.from({ length: 7 }, (_, di) => {
        const day = addDays(firstWeek, wi * 7 + di);
        return day > today ? null : { day, count: perDay.get(day) ?? 0 };
      }),
    );
  }
  const counts = [...perDay.values()].sort((a, b) => a - b);
  const q = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] ?? 0;

  let streak = 0;
  for (let d = (perDay.get(today) ? today : addDays(today, -1)); perDay.get(d); d = addDays(d, -1)) streak += 1;
  let longest = 0;
  let run = 0;
  for (let d = firstWeek; d <= today; d = addDays(d, 1)) {
    run = perDay.get(d) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  const dayTotals = punch.map((row) => row.reduce((a, b) => a + b, 0));
  const hourTotals = punch[0].map((_, hr) => punch.reduce((a, row) => a + row[hr], 0));

  const weekly = grid.slice(-26).map((week) => week.reduce((a, d) => a + (d?.count ?? 0), 0));
  const last30 = [...perDay].filter(([d]) => daysBetween(d, today) < 30).reduce((a, [, n]) => a + n, 0);

  const total = repo.languages.totalSize || 1;
  const langs = repo.languages.edges.map((e) => ({ name: e.node.name, color: e.node.color ?? "#6e7681", share: e.size / total }));
  const languages = langs.slice(0, 5);
  const rest = langs.slice(5).reduce((a, l) => a + l.share, 0);
  if (rest > 0) languages.push({ name: "Other", color: "#6e7681", share: rest });

  const paths = tree.map((t) => t.path);
  const essentials = ESSENTIALS.map(([label, test]) => ({ label, ok: paths.some((p) => test(p, repo)) }));

  const contributors = await Promise.all(
    contribs.list.slice(0, 6).map(async (c) => ({
      login: c.login,
      contributions: c.contributions,
      avatar: await fetchImage(`${c.avatar_url}${c.avatar_url.includes("?") ? "&" : "?"}s=56`),
    })),
  );

  const published = allReleases.map((r) => r.publishedAt).filter(Boolean);
  const downloads = allReleases.reduce((a, r) => a + r.releaseAssets.nodes.reduce((b, n) => b + n.downloadCount, 0), 0);
  const history = repo.defaultBranchRef.target.history;

  return {
    repo,
    now,
    today,
    idleDays: daysBetween(localDay(repo.pushedAt), today),
    latestTag: repo.tags.nodes[0]?.name ?? null,
    grid,
    quartiles: [q(0.25), q(0.5), q(0.75)],
    yearCommits: [...perDay.values()].reduce((a, b) => a + b, 0),
    streak,
    longest,
    activeDays: perDay.size,
    punch,
    busiestDay: DAYS[dayTotals.indexOf(Math.max(...dayTotals))],
    peakHour: hourTotals.indexOf(Math.max(...hourTotals)),
    weekly,
    last30,
    languages,
    files: tree.filter((t) => t.type === "blob").length,
    essentials,
    commits: history.nodes,
    totalCommits: history.totalCount,
    cadence: cadence(published),
    downloads,
    contributors,
    contributorCount: contribs.total,
    bots: contribs.list.filter((c) => c.type === "Bot").length,
  };
}

// ─── Card ────────────────────────────────────────────────────────────────────

function card(s) {
  const r = s.repo;
  const updated = (() => {
    const [yy, mm, dd] = s.today.split("-").map(Number);
    return `${MONTHS[mm - 1]} ${dd}, ${yy}`;
  })();
  const [kb, unit] = size(r.diskUsage ?? 0);

  const tileItems = [
    { icon: "git-commit", color: C.indigo, value: compact(s.totalCommits), label: "Commits", sub: s.commits[0] ? `last ${ago(s.commits[0].authoredDate, s.today)}` : "none yet" },
    { icon: "people", color: C.teal, value: compact(s.contributorCount), label: "Contributors", sub: s.bots ? `incl. ${plural(s.bots, "bot")}` : "all-time" },
    { icon: "git-branch", color: C.green, value: compact(r.branches.totalCount), label: "Branches", sub: `default ${r.defaultBranchRef.name}` },
    { icon: "tag", color: C.cyan, value: compact(r.tags.totalCount), label: "Tags", sub: s.latestTag ? `latest ${s.latestTag}` : "none yet" },
    { icon: "package", color: C.blue, value: compact(r.releases.totalCount), label: "Releases", sub: r.releases.nodes[0] ? `latest ${ago(r.releases.nodes[0].publishedAt, s.today)}` : "none yet" },
    s.downloads > 0
      ? { icon: "download", color: C.purple, value: compact(s.downloads), label: "Downloads", sub: "release assets" }
      : { icon: "law", color: C.purple, value: r.licenseInfo?.spdxId && r.licenseInfo.spdxId !== "NOASSERTION" ? r.licenseInfo.spdxId : "—", label: "License", sub: "SPDX" },
    { icon: "star", color: C.yellow, value: compact(r.stargazerCount), label: "Stars", sub: "stargazers" },
    { icon: "repo-forked", color: C.teal, value: compact(r.forkCount), label: "Forks", sub: "of this repo" },
    { icon: "eye", color: C.slate, value: compact(r.watchers.totalCount), label: "Watchers", sub: "subscribed" },
    { icon: "issue-opened", color: C.orange, value: compact(r.openIssues.totalCount), label: "Open issues", sub: `${compact(r.closedIssues.totalCount)} closed` },
    { icon: "git-pull-request", color: C.purple, value: compact(r.openPRs.totalCount), label: "Pull requests", sub: `open · ${compact(r.mergedPRs.totalCount)} merged` },
    { icon: "database", color: C.rose, value: kb, unit, label: "Size", sub: plural(s.files, "file") },
  ];

  let y = PAD;
  const parts = [header(r, updated, y)];
  y += 58 + 10;
  const top = hero(s, y);
  parts.push(top.svg);
  y += top.h + SECTION;
  const grid = tiles(tileItems, y);
  parts.push(grid.svg);
  y += grid.h + SECTION;
  const act = activity(s, y);
  parts.push(act.svg);
  y += act.h + SECTION;
  const midH = Math.max(96 + 6 * 21 + 44, codeHeight(s));
  parts.push(rhythm(s, PAD, y, midH));
  parts.push(code(s, PAD + HALF + SECTION, y, midH));
  y += midH + SECTION;
  // Rows sit 46 px apart and the last one needs 36 px below its baseline.
  const lowH = Math.max(66 + (Math.max(1, s.commits.length) - 1) * 46 + 36, (s.cadence ? 98 : 66) + (Math.max(1, r.releases.nodes.length) - 1) * 46 + 36);
  parts.push(commits(s, PAD, y, lowH));
  parts.push(releases(s, PAD + HALF + SECTION, y, lowH));
  y += lowH + SECTION;
  const people = contributors(s, y);
  parts.push(people.svg);
  y += people.h + PAD;
  const H = y;

  const summary =
    `${r.description ? `${r.description}. ` : ""}` +
    `${plural(s.totalCommits, "commit")}, ${plural(s.yearCommits, "commit")} in the last year, ` +
    `${plural(r.stargazerCount, "star")}, ${plural(r.releases.totalCount, "release")}` +
    `${s.latestTag ? ` (latest ${s.latestTag})` : ""}, ${plural(s.contributorCount, "contributor")}.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(r.nameWithOwner)} at a glance</title>
<desc id="d">${esc(summary)}</desc>
<style>
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; fill: #e6edf3; }
  .mono, .tagname { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
  .h-name { font-size: 26px; font-weight: 700; fill: #ffffff; }
  .h-sub { font-size: 12.5px; fill: rgba(230,237,243,0.6); }
  .updated { font-size: 11px; fill: rgba(230,237,243,0.5); }
  .desc { font-size: 15px; font-weight: 700; fill: #ffffff; }
  .pill { font-size: 11.5px; font-weight: 600; fill: rgba(230,237,243,0.88); }
  .pill-off { font-size: 11.5px; font-weight: 600; fill: rgba(230,237,243,0.45); }
  .pill-k { font-size: 11.5px; fill: rgba(230,237,243,0.7); }
  .pill-v { font-size: 11.5px; font-weight: 700; fill: #ffffff; }
  .big { font-size: 34px; font-weight: 700; fill: #ffffff; }
  .big-cap { font-size: 12px; font-weight: 600; fill: rgba(230,237,243,0.75); }
  .value { font-size: 26px; font-weight: 700; fill: #ffffff; }
  .unit { font-size: 14px; font-weight: 600; fill: rgba(255,255,255,0.8); }
  .label { font-size: 12px; font-weight: 600; fill: rgba(255,255,255,0.9); }
  .sub { font-size: 10.5px; fill: rgba(255,255,255,0.55); }
  .title { font-size: 14px; font-weight: 700; }
  .caption { font-size: 12px; font-weight: 600; fill: rgba(230,237,243,0.6); }
  .section { font-size: 11.5px; font-weight: 600; fill: rgba(230,237,243,0.6); }
  .axis { font-size: 10px; fill: rgba(230,237,243,0.5); }
  .row { font-size: 12.5px; font-weight: 500; fill: rgba(230,237,243,0.92); }
  .pct { font-size: 11.5px; fill: rgba(230,237,243,0.6); }
  .commit { font-size: 13px; font-weight: 600; fill: rgba(230,237,243,0.95); }
  .meta { font-size: 11px; fill: rgba(230,237,243,0.55); }
  .tagname { font-size: 13px; font-weight: 700; fill: #ffffff; }
  .excerpt { font-size: 11.5px; fill: rgba(230,237,243,0.6); }
  .who { font-size: 13px; font-weight: 600; fill: rgba(230,237,243,0.95); }
  .count { font-size: 12px; font-weight: 700; fill: #e6edf3; }
  .foot { font-size: 11px; fill: rgba(230,237,243,0.42); }
  .panel { fill: rgba(255,255,255,0.045); stroke: rgba(255,255,255,0.09); }
</style>
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1a2238"/>
    <stop offset="1" stop-color="#232338"/>
  </linearGradient>
  <radialGradient id="glow-a" cx="0.12" cy="0.06" r="0.5">
    <stop offset="0" stop-color="#2f6fe0" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#2f6fe0" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glow-b" cx="0.9" cy="0.94" r="0.5">
    <stop offset="0" stop-color="#7c3aed" stop-opacity="0.2"/>
    <stop offset="1" stop-color="#7c3aed" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#16a34a" stop-opacity="0.26"/>
    <stop offset="1" stop-color="#0f766e" stop-opacity="0.08"/>
  </linearGradient>
  <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.green}" stop-opacity="0.32"/>
    <stop offset="1" stop-color="${C.green}" stop-opacity="0"/>
  </linearGradient>${tileGradients(tileItems)}
</defs>
<rect width="${W}" height="${H}" rx="18" fill="url(#bg)"/>
<rect width="${W}" height="${H}" rx="18" fill="url(#glow-a)"/>
<rect width="${W}" height="${H}" rx="18" fill="url(#glow-b)"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="17.5" fill="none" stroke="rgba(255,255,255,0.10)"/>
${parts.join("\n")}
</svg>
`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

// No argument renders every listed repository; an argument names one of them
// by its short name, or any repository as owner/name for a preview.
const only = process.argv.slice(2);
const targets = only.length
  ? only.map((arg) => (arg.includes("/") ? arg : CONFIG.repos.find((full) => full.split("/")[1] === arg)))
  : CONFIG.repos;
if (!targets.length || targets.includes(undefined)) {
  console.error(`Not listed in scripts/repo-cards.json: ${only.join(", ")} (pass owner/name for any repository)`);
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
let failed = 0;
for (const full of targets) {
  try {
    const s = await model(full);
    const svg = card(s);
    const out = `${OUT_DIR}/${s.repo.name}.svg`;
    await writeFile(out, svg);
    console.log(`${out}: ${(svg.length / 1024).toFixed(1)} KB — ${s.totalCommits} commits, ${s.yearCommits} this year, ${s.repo.stargazerCount} stars`);
  } catch (err) {
    failed += 1;
    console.error(`${full}: ${err.message}`);
  }
}
// A failed repository leaves its previous card in place; the others still
// render, and the exit code makes the run fail so the failure is seen.
process.exit(failed ? 1 : 0);
