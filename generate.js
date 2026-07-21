#!/usr/bin/env node
/**
 * README generator — pure Node.js replacement for muesli/readme-scribe.
 *
 * readme-scribe (markscribe) relies on GitHub GraphQL queries
 * (contributionsCollection / repositoriesContributedTo) that now fail with
 * RESOURCE_LIMITS_EXCEEDED for very active accounts. This script produces the
 * same two sections using only the REST API:
 *
 *   {{recentContributions}}  repos the user most recently pushed to
 *   {{recentReleases}}       repos the user committed to, ordered by their
 *                            latest release date
 *
 * Usage: node generate.js [template] [output]
 * Env:   GITHUB_TOKEN (required), GITHUB_REPOSITORY_OWNER (default: shyim)
 */

const fs = require("fs");

const USERNAME = process.env.GITHUB_REPOSITORY_OWNER || "shyim";
const TOKEN = process.env.GITHUB_TOKEN;
const CONTRIBUTIONS_COUNT = 9;
const RELEASES_COUNT = 9;
const MAX_RELEASE_CANDIDATES = 250; // cap API calls for the releases section

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "shyim-readme-generator",
};

async function api(endpoint) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com${endpoint}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${res.status} for ${url}: ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

/** Run fn over items with at most `limit` concurrent calls. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Port of markscribe's humanize: flatten to UTC midnight, then relative. */
function humanize(date) {
  const flat = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  const diff = Date.now() - flat;
  const DAY = 24 * 3600 * 1000;
  const days = diff / DAY;
  if (days <= 1) return "today";
  if (days < 2) return "1 day ago";
  if (days < 7) return `${Math.floor(days)} days ago`;
  if (days < 14) return "1 week ago";
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return "1 month ago";
  if (days < 360) return `${Math.floor(days / 30)} months ago`;
  if (days < 540) return "1 year ago";
  if (days < 720) return "2 years ago";
  return `${Math.floor(days / 360)} years ago`;
}

/**
 * Repos the user most recently pushed to (last 90 days of events),
 * private repos and the meta-repo excluded — same as markscribe.
 */
async function recentContributions(count) {
  const pushed = [];
  const seen = new Set();

  for (let page = 1; page <= 3; page++) {
    const events = await api(
      `/users/${USERNAME}/events?per_page=100&page=${page}`,
    );
    if (!Array.isArray(events) || events.length === 0) break;
    for (const ev of events) {
      if (ev.type !== "PushEvent") continue;
      const name = ev.repo.name;
      if (name === `${USERNAME}/${USERNAME}` || seen.has(name)) continue;
      seen.add(name);
      pushed.push({ fullName: name, occurredAt: new Date(ev.created_at) });
    }
    if (events.length < 100) break;
  }

  // Resolve repo details (description, privacy) until we have enough public repos.
  const contributions = [];
  for (let i = 0; i < pushed.length && contributions.length < count; i += 10) {
    const batch = pushed.slice(i, i + 10);
    const repos = await mapLimit(batch, 5, (c) =>
      api(`/repos/${c.fullName}`).catch(() => null),
    );
    for (let j = 0; j < batch.length && contributions.length < count; j++) {
      const repo = repos[j];
      if (!repo || repo.private) continue;
      contributions.push({
        name: repo.full_name,
        url: repo.html_url,
        description: repo.description || "",
        occurredAt: batch[j].occurredAt,
      });
    }
  }
  return contributions;
}

/**
 * Candidate repos for the releases section: union of own repos, repos with
 * commits/merged PRs by the user (search API), and recently pushed repos.
 */
async function releaseCandidates(pushedRepoNames) {
  const names = new Set();
  const add = (name) => {
    if (name && name !== `${USERNAME}/${USERNAME}`) names.add(name);
  };

  // Own repos (most recently pushed first)
  const own = await api(
    "/user/repos?per_page=100&affiliation=owner&sort=pushed&direction=desc",
  );
  for (const repo of own) {
    if (!repo.private && repo.owner.login === USERNAME) add(repo.full_name);
  }

  // Repos with commits by the user (up to 500 most recent commits)
  for (let page = 1; page <= 5; page++) {
    const res = await api(
      `/search/commits?q=author:${USERNAME}&sort=committer-date&order=desc&per_page=100&page=${page}`,
    );
    for (const item of res.items || []) {
      if (!item.repository.private) add(item.repository.full_name);
    }
    if (!res.items || res.items.length < 100) break;
  }

  // Repos with merged PRs by the user
  const prs = await api(
    `/search/issues?q=is:pr+author:${USERNAME}+is:merged&sort=updated&order=desc&per_page=100`,
  );
  for (const item of prs.items || []) {
    add(item.repository_url.replace("https://api.github.com/repos/", ""));
  }

  for (const name of pushedRepoNames) add(name);

  return [...names].slice(0, MAX_RELEASE_CANDIDATES);
}

/**
 * markscribe's release pick: of the 10 newest releases, at least one must be
 * a proper release (not draft/prerelease); the newest one is then shown.
 */
function pickRelease(releases) {
  if (!releases.length) return null;
  if (!releases.some((r) => !r.draft && !r.prerelease)) return null;
  const latest = releases[0];
  if (!latest.tag_name || !latest.published_at) return null;
  return {
    tagName: latest.tag_name,
    url: latest.html_url,
    publishedAt: new Date(latest.published_at),
  };
}

async function recentReleases(pushedRepoNames) {
  const candidates = await releaseCandidates(pushedRepoNames);
  console.log(`Checking releases of ${candidates.length} repos...`);

  const repos = await mapLimit(candidates, 10, async (name) => {
    const releases = await api(`/repos/${name}/releases?per_page=10`).catch(
      () => null,
    );
    if (!releases) return null;
    const release = pickRelease(releases);
    if (!release) return null;
    return {
      name,
      url: `https://github.com/${name}`,
      description: "", // filled below only for the few repos that make the cut
      release,
    };
  });

  const sorted = repos
    .filter(Boolean)
    .sort((a, b) => b.release.publishedAt - a.release.publishedAt)
    .slice(0, RELEASES_COUNT);

  await mapLimit(sorted, 5, async (repo) => {
    const details = await api(`/repos/${repo.name}`).catch(() => null);
    repo.description = (details && details.description) || "";
  });

  return sorted;
}

async function main() {
  const templatePath = process.argv[2] || "templates/README.md.tpl";
  const outputPath = process.argv[3] || "README.md";

  const contributions = await recentContributions(CONTRIBUTIONS_COUNT);
  console.log(`Found ${contributions.length} recent contributions`);
  const releases = await recentReleases(
    contributions.map((c) => c.name),
  );
  console.log(`Found ${releases.length} recent releases`);

  const contributionsMd = contributions
    .map(
      (c) =>
        `- [${c.name}](${c.url}) - ${c.description} (${humanize(c.occurredAt)})`,
    )
    .join("\n");
  const releasesMd = releases
    .map(
      (r) =>
        `- [${r.name}](${r.url}) ([${r.release.tagName}](${r.release.url}), ${humanize(r.release.publishedAt)}) - ${r.description}`,
    )
    .join("\n");

  const output = fs
    .readFileSync(templatePath, "utf8")
    .replace("{{recentContributions}}", contributionsMd)
    .replace("{{recentReleases}}", releasesMd);

  fs.writeFileSync(outputPath, output);
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
