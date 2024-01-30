#!/usr/bin/env node

const fs = require("fs");

async function getRelease(github, dependency) {
    let owner;
    let repo;
    let tag;
    if (dependency.includes("/") && dependency.includes("@")) {
        owner = dependency.split("/")[0];
        repo = dependency.split("/")[1].split("@")[0];
        tag = dependency.split("@")[1];
    } else {
        const upstreamPackageJson = JSON.parse(fs.readFileSync(`./node_modules/${dependency}/package.json`, "utf8"));
        [owner, repo] = upstreamPackageJson.repository.url.split("/").slice(-2);
        tag = `v${upstreamPackageJson.version}`;
    }

    const response = await github.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag,
    });
    return response.data;
}

const HEADING_PREFIX = "## ";

const categories = [
    "🔒 SECURITY FIXES",
    "🚨 BREAKING CHANGESd",
    "🦖 Deprecations",
    "✨ Features",
    "🐛 Bug Fixes",
    "🧰 Maintenance",
];

const parseReleaseNotes = (body, sections) => {
    let heading = null;
    for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith(HEADING_PREFIX)) {
            heading = trimmed.slice(HEADING_PREFIX.length);
            if (!categories.includes(heading)) heading = null;
            continue;
        }
        if (heading && trimmed) {
            sections[heading].push(trimmed);
        }
    }
};

const main = async ({ github, releaseId, dependencies }) => {
    const { GITHUB_REPOSITORY } = process.env;
    const [owner, repo] = GITHUB_REPOSITORY.split("/");

    const sections = Object.fromEntries(categories.map((cat) => [cat, []]));
    for (const dependency of dependencies) {
        const release = await getRelease(github, dependency);
        parseReleaseNotes(release.body, sections);
    }

    const { data: release } = await github.rest.repos.getRelease({
        owner,
        repo,
        release_id: releaseId,
    });

    const intro = release.body.split(HEADING_PREFIX, 2)[0].trim();

    let output = "";
    if (intro) {
        output = intro + "\n\n";
    }

    for (const section in sections) {
        const lines = sections[section];
        if (!lines.length) continue;
        output += HEADING_PREFIX + section + "\n\n";
        output += lines.join("\n");
        output += "\n\n";
    }

    return output;
};

// This is just for testing locally
// Needs environment variables GITHUB_TOKEN & GITHUB_REPOSITORY
if (require.main === module) {
    const { Octokit } = require("@octokit/rest");
    const github = new Octokit({ auth: process.env.GITHUB_TOKEN });
    if (process.argv.length < 4) {
        // eslint-disable-next-line no-console
        console.error("Usage: node merge-release-notes.js owner/repo:release_id npm-package-name ...");
        process.exit(1);
    }
    const [releaseId, ...dependencies] = process.argv.slice(2);
    main({ github, releaseId, dependencies }).then((output) => {
        // eslint-disable-next-line no-console
        console.log(output);
    });
}

module.exports = main;
