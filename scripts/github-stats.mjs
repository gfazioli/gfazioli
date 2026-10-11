#!/usr/bin/env node
/**
 * Renders github-stats.svg, the "GitHub activity" card of the profile README:
 * profile header, stat tiles, the contribution calendar, top repositories and
 * languages, laid out like FinderGit's Account view.
 *
 * Zero dependencies (Node >= 20, global fetch). Run by
 * .github/workflows/github-stats.yml once a day; locally:
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/github-stats.mjs github-stats.svg
 *
 * Every number is the PUBLIC one, whatever token renders it: repositories are
 * queried with `privacy: PUBLIC` and the PR/issue counts are searches with
 * `is:public`. The one exception is the contribution calendar, which GitHub
 * computes per viewer: the workflow's GITHUB_TOKEN sees what an anonymous
 * visitor sees, while a personal token adds private contributions, so a local
 * render can show higher calendar and commit numbers than the committed card.
 *
 * An <img> renders an SVG in isolation — no external fonts, images or scripts —
 * so the avatar is embedded as a data URI and the text uses the system font.
 */

import { writeFile } from "node:fs/promises";
import { OCTICONS } from "./octicons.mjs";

const LOGIN = process.env.STATS_LOGIN || "gfazioli";
const OUT = process.argv[2] || "github-stats.svg";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required (locally: GITHUB_TOKEN=$(gh auth token))");
  process.exit(1);
}

// ─── Data ────────────────────────────────────────────────────────────────────

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${LOGIN}-github-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

const PROFILE_QUERY = `
query($login: String!, $prs: String!, $merged: String!, $issues: String!) {
  user(login: $login) {
    login name bio company location websiteUrl createdAt
    avatarUrl(size: 160)
    followers { totalCount }
    following { totalCount }
    organizations(first: 1) { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalRepositoriesWithContributedCommits
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date weekday contributionLevel } }
      }
    }
  }
  prs: search(query: $prs, type: ISSUE) { issueCount }
  merged: search(query: $merged, type: ISSUE) { issueCount }
  issues: search(query: $issues, type: ISSUE) { issueCount }
}`;

const REPOS_QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes { name stargazerCount forkCount primaryLanguage { name color } }
    }
  }
}`;

async function fetchRepos() {
  const repos = [];
  let after = null;
  do {
    const page = (await graphql(REPOS_QUERY, { login: LOGIN, after })).user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

async function fetchAvatar(url) {
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

// ─── Formatting ──────────────────────────────────────────────────────────────

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

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function icon(name, x, y, fill, size = 16) {
  const s = size / 16;
  const paths = OCTICONS[name].map((d) => `<path d="${d}"/>`).join("");
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="${fill}">${paths}</g>`;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

const W = 880;
const PAD = 24;
const IW = W - PAD * 2;
const GAP = 12;

const LEVEL_FILL = {
  NONE: "rgba(255,255,255,0.07)",
  FIRST_QUARTILE: "#0e4429",
  SECOND_QUARTILE: "#006d32",
  THIRD_QUARTILE: "#26a641",
  FOURTH_QUARTILE: "#39d353",
};

function panel(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" class="panel"/>`;
}

function header(user, avatar, updated, y) {
  const h = 104;
  const cx = PAD + 20 + 36;
  const cy = y + h / 2;
  const meta = [
    user.company,
    user.location,
    user.websiteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    `Joined ${new Date(user.createdAt).getUTCFullYear()}`,
  ]
    .filter(Boolean)
    .map(esc)
    .join("  ·  ");
  const face = avatar
    ? `<image href="${avatar}" x="${cx - 36}" y="${cy - 36}" width="72" height="72" clip-path="url(#avatar)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="36" fill="#2b5aa8"/>`;
  return `
  <rect x="${PAD}" y="${y}" width="${IW}" height="${h}" rx="14" fill="url(#hero)" stroke="rgba(255,255,255,0.10)"/>
  <clipPath id="avatar"><circle cx="${cx}" cy="${cy}" r="36"/></clipPath>
  ${face}
  <circle cx="${cx}" cy="${cy}" r="37.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="3"/>
  <text x="${cx + 56}" y="${y + 38}"><tspan class="name">${esc(user.name || user.login)}</tspan><tspan dx="8" class="login">@${esc(user.login)}</tspan></text>
  <text x="${cx + 56}" y="${y + 60}" class="bio">${esc(clip((user.bio || "").trim(), 92))}</text>
  <text x="${cx + 56}" y="${y + 84}" class="meta">${meta}</text>
  <text x="${PAD + IW - 16}" y="${y + 28}" class="updated" text-anchor="end">Updated ${updated}</text>`;
}

function tiles(items, y) {
  const cols = 5;
  const w = (IW - GAP * (cols - 1)) / cols;
  const h = 98;
  return items
    .map((t, i) => {
      const x = PAD + (i % cols) * (w + GAP);
      const ty = y + Math.floor(i / cols) * (h + GAP);
      return `
  <g>
    <rect x="${x}" y="${ty}" width="${w}" height="${h}" rx="14" fill="url(#tile-${i})" stroke="rgba(255,255,255,0.10)"/>
    ${icon(t.icon, x + 14, ty + 14, t.color)}
    <text x="${x + 14}" y="${ty + 60}" class="value">${t.value}</text>
    <text x="${x + 14}" y="${ty + 78}" class="label">${t.label}</text>
    <text x="${x + 14}" y="${ty + 91}" class="sub">${t.sub}</text>
  </g>`;
    })
    .join("");
}

function tileGradients(items) {
  return items
    .map(
      (t, i) => `
    <linearGradient id="tile-${i}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.color}" stop-opacity="0.42"/>
      <stop offset="1" stop-color="${t.color}" stop-opacity="0.12"/>
    </linearGradient>`,
    )
    .join("");
}

function contributions(calendar, y) {
  const h = 214;
  const step = 14;
  const cell = 11;
  const weeks = calendar.weeks;
  const gridW = weeks.length * step - (step - cell);
  const labelW = 30;
  const left = PAD + (IW - gridW - labelW) / 2;
  const gx = left + labelW;
  const gy = y + 82;

  const cells = weeks
    .flatMap((week, wi) =>
      week.contributionDays.map(
        (d) =>
          `<rect x="${gx + wi * step}" y="${gy + d.weekday * step}" width="${cell}" height="${cell}" rx="2.5" fill="${LEVEL_FILL[d.contributionLevel] ?? LEVEL_FILL.NONE}"/>`,
      ),
    )
    .join("");

  // A month label sits over the first week that starts in that month; labels
  // closer than three weeks apart would overlap, so the earlier one is dropped.
  const marks = [];
  weeks.forEach((week, wi) => {
    const m = Number(week.contributionDays[0].date.slice(5, 7)) - 1;
    const prev = wi > 0 ? Number(weeks[wi - 1].contributionDays[0].date.slice(5, 7)) - 1 : -1;
    if (m !== prev) marks.push({ wi, m });
  });
  const kept = marks.filter((mk, i) => !(marks[i + 1] && marks[i + 1].wi - mk.wi < 3));
  const months = kept
    .map((mk) => `<text x="${gx + mk.wi * step}" y="${gy - 8}" class="axis">${MONTHS[mk.m]}</text>`)
    .join("");
  const days = [
    [1, "Mon"],
    [3, "Wed"],
    [5, "Fri"],
  ]
    .map(([r, n]) => `<text x="${gx - 8}" y="${gy + r * step + 9}" class="axis" text-anchor="end">${n}</text>`)
    .join("");

  const levels = Object.values(LEVEL_FILL);
  const lx = gx + gridW - levels.length * step - 30;
  const legend = `
  <text x="${lx - 8}" y="${y + h - 18}" class="axis" text-anchor="end">Less</text>
  ${levels.map((f, i) => `<rect x="${lx + i * step}" y="${y + h - 27}" width="${cell}" height="${cell}" rx="2.5" fill="${f}"/>`).join("")}
  <text x="${lx + levels.length * step + 5}" y="${y + h - 18}" class="axis">More</text>`;

  return `
  ${panel(PAD, y, IW, h)}
  ${icon("flame", PAD + 18, y + 16, "#39d353")}
  <text x="${PAD + 42}" y="${y + 29}" class="title" fill="#39d353">Contributions</text>
  <text x="${PAD + 18}" y="${y + 52}" class="headline">${full(calendar.totalContributions)} contributions in the last year</text>
  ${months}${days}${cells}${legend}`;
}

function topRepos(repos, x, y, w, h) {
  const caption = `Most starred of ${repos.length} public repositories`;
  const rows = repos
    .slice(0, 6)
    .map((r, i) => {
      const ry = y + 80 + i * 21;
      return `
    <circle cx="${x + 23}" cy="${ry - 4}" r="4.5" fill="${r.primaryLanguage?.color ?? "#6e7681"}"/>
    <text x="${x + 36}" y="${ry}" class="row">${esc(clip(r.name, 40))}</text>
    ${icon("star", x + w - 66, ry - 11, "#facc15", 13)}
    <text x="${x + w - 18}" y="${ry}" class="count" text-anchor="end">${r.stargazerCount}</text>`;
    })
    .join("");
  return `
  ${panel(x, y, w, h)}
  ${icon("star", x + 18, y + 16, "#facc15")}
  <text x="${x + 42}" y="${y + 29}" class="title" fill="#facc15">Top repositories</text>
  <text x="${x + 18}" y="${y + 52}" class="headline">${caption}</text>
  ${rows}`;
}

function languages(langs, x, y, w, h) {
  const total = langs.reduce((s, l) => s + l.count, 0);
  const barX = x + 18;
  const barW = w - 36;
  const barY = y + 46;
  let cursor = barX;
  const segments = langs
    .map((l) => {
      const sw = (l.count / total) * barW;
      const seg = `<rect x="${cursor.toFixed(2)}" y="${barY}" width="${sw.toFixed(2)}" height="8" fill="${l.color}"/>`;
      cursor += sw;
      return seg;
    })
    .join("");
  const rows = langs
    .map((l, i) => {
      const ry = y + 80 + i * 21;
      const pct = Math.round((l.count / total) * 100);
      return `
    <circle cx="${x + 23}" cy="${ry - 4}" r="4.5" fill="${l.color}"/>
    <text x="${x + 36}" y="${ry}" class="row">${esc(l.name)}</text>
    <text x="${x + w - 54}" y="${ry}" class="pct" text-anchor="end">${pct}%</text>
    <text x="${x + w - 18}" y="${ry}" class="count" text-anchor="end">${l.count}</text>`;
    })
    .join("");
  return `
  ${panel(x, y, w, h)}
  ${icon("code", x + 18, y + 16, "#4ade80")}
  <text x="${x + 42}" y="${y + 29}" class="title" fill="#4ade80">Languages</text>
  <clipPath id="langbar"><rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4"/></clipPath>
  <g clip-path="url(#langbar)">${segments}</g>
  ${rows}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const data = await graphql(PROFILE_QUERY, {
  login: LOGIN,
  prs: `author:${LOGIN} is:pr is:public`,
  merged: `author:${LOGIN} is:pr is:merged is:public`,
  issues: `author:${LOGIN} is:issue is:public`,
});
const user = data.user;
const repos = await fetchRepos();
const avatar = await fetchAvatar(user.avatarUrl);

const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
const forks = repos.reduce((s, r) => s + r.forkCount, 0);
const cc = user.contributionsCollection;

const byLanguage = new Map();
for (const r of repos) {
  if (!r.primaryLanguage) continue;
  const l = byLanguage.get(r.primaryLanguage.name) ?? { ...r.primaryLanguage, count: 0 };
  l.count += 1;
  byLanguage.set(l.name, l);
}
const ranked = [...byLanguage.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
const langs = ranked.slice(0, 5);
const rest = ranked.slice(5).reduce((s, l) => s + l.count, 0);
if (rest > 0) langs.push({ name: "Other", color: "#6e7681", count: rest });

const tileItems = [
  { icon: "people", color: "#60a5fa", value: compact(user.followers.totalCount), label: "Followers", sub: "on GitHub" },
  { icon: "person", color: "#22d3ee", value: compact(user.following.totalCount), label: "Following", sub: "developers" },
  { icon: "star", color: "#facc15", value: compact(stars), label: "Stars", sub: "across public repos" },
  { icon: "repo", color: "#818cf8", value: compact(repos.length), label: "Public repos", sub: "owned, non-fork" },
  { icon: "repo-forked", color: "#2dd4bf", value: compact(forks), label: "Forks", sub: "of my repos" },
  { icon: "git-pull-request", color: "#c084fc", value: compact(data.prs.issueCount), label: "Pull requests", sub: `${compact(data.merged.issueCount)} merged` },
  { icon: "issue-opened", color: "#4ade80", value: compact(data.issues.issueCount), label: "Issues", sub: "opened" },
  { icon: "git-commit", color: "#fb923c", value: compact(cc.totalCommitContributions), label: "Commits", sub: "last year" },
  { icon: "graph", color: "#fb7185", value: compact(cc.totalRepositoriesWithContributedCommits), label: "Contributed", sub: "repos, last year" },
  { icon: "organization", color: "#94a3b8", value: compact(user.organizations.totalCount), label: "Organizations", sub: "member of" },
];

const now = new Date();
const updated = `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`;

let y = PAD;
const parts = [];
parts.push(header(user, avatar, updated, y));
y += 104 + 16;
parts.push(tiles(tileItems, y));
y += 98 * 2 + GAP + 16;
parts.push(contributions(cc.contributionCalendar, y));
y += 214 + 16;
const half = (IW - 16) / 2;
const bottomH = 202;
parts.push(topRepos([...repos].sort((a, b) => b.stargazerCount - a.stargazerCount), PAD, y, half, bottomH));
parts.push(languages(langs, PAD + half + 16, y, half, bottomH));
y += bottomH + PAD;
const H = y;

const name = user.name || user.login;
const summary =
  `${full(cc.contributionCalendar.totalContributions)} contributions in the last year, ` +
  `${full(stars)} stars across ${repos.length} public repositories, ` +
  `${full(data.prs.issueCount)} pull requests, ${full(user.followers.totalCount)} followers.`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(name)}'s GitHub activity</title>
<desc id="d">${esc(summary)}</desc>
<style>
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; fill: #e6edf3; }
  .name { font-size: 20px; font-weight: 700; fill: #ffffff; }
  .login { font-size: 13px; fill: rgba(230,237,243,0.62); }
  .bio { font-size: 13px; fill: rgba(230,237,243,0.88); }
  .meta { font-size: 11.5px; fill: rgba(230,237,243,0.62); }
  .updated { font-size: 11px; fill: rgba(230,237,243,0.5); }
  .value { font-size: 27px; font-weight: 700; fill: #ffffff; }
  .label { font-size: 12px; font-weight: 600; fill: rgba(255,255,255,0.9); }
  .sub { font-size: 10.5px; fill: rgba(255,255,255,0.55); }
  .title { font-size: 13.5px; font-weight: 700; }
  .headline { font-size: 12.5px; font-weight: 600; fill: rgba(230,237,243,0.9); }
  .axis { font-size: 10px; fill: rgba(230,237,243,0.5); }
  .row { font-size: 12.5px; font-weight: 500; fill: rgba(230,237,243,0.92); }
  .count { font-size: 12px; font-weight: 700; fill: #e6edf3; }
  .pct { font-size: 11px; fill: rgba(230,237,243,0.5); }
  .panel { fill: rgba(255,255,255,0.045); stroke: rgba(255,255,255,0.09); }
</style>
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#1a2238"/>
    <stop offset="1" stop-color="#232338"/>
  </linearGradient>
  <radialGradient id="glow-a" cx="0.12" cy="0.08" r="0.55">
    <stop offset="0" stop-color="#2f6fe0" stop-opacity="0.32"/>
    <stop offset="1" stop-color="#2f6fe0" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glow-b" cx="0.9" cy="0.92" r="0.55">
    <stop offset="0" stop-color="#7c3aed" stop-opacity="0.22"/>
    <stop offset="1" stop-color="#7c3aed" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2d63c4" stop-opacity="0.55"/>
    <stop offset="1" stop-color="#2d63c4" stop-opacity="0.16"/>
  </linearGradient>${tileGradients(tileItems)}
</defs>
<rect width="${W}" height="${H}" rx="18" fill="url(#bg)"/>
<rect width="${W}" height="${H}" rx="18" fill="url(#glow-a)"/>
<rect width="${W}" height="${H}" rx="18" fill="url(#glow-b)"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="17.5" fill="none" stroke="rgba(255,255,255,0.10)"/>
${parts.join("\n")}
</svg>
`;

await writeFile(OUT, svg);
console.log(`${OUT}: ${(svg.length / 1024).toFixed(1)} KB — ${summary}`);
