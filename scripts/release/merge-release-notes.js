#!/usr/bin/env node

const fs = require("fs");

async function listReleases(github, owner, repo) {
    const response = await github.rest.repos.listReleases({
        owner,
        repo,
        per_page: 100,
    });
    // Filters out draft releases
    return response.data.filter((release) => !release.draft);
}

// Dependency can be a tuple of dependency, from version, to version, in which case a list of releases in that range (to inclusive) will be returned
// Or it can be a string in the form accepted by `getRelease`
async function getReleases(github, dependency) {
    if (Array.isArray(dependency)) {
        const [dep, fromVersion, toVersion] = dependency;
        const upstreamPackageJson = getDependencyPackageJson(dep);
        const [owner, repo] = upstreamPackageJson.repository.url.split("/").slice(-2);

        const unfilteredReleases = await listReleases(github, owner, repo);
        // Only include non-draft & non-prerelease releases, unless the to-release is a pre-release, include that one
        const releases = unfilteredReleases.filter(
            (release) => !release.prerelease || release.tag_name === `v${toVersion}`,
        );

        const fromVersionIndex = releases.findIndex((release) => release.tag_name === `v${fromVersion}`);
        const toVersionIndex = releases.findIndex((release) => release.tag_name === `v${toVersion}`);

        return releases.slice(toVersionIndex, fromVersionIndex);
    }

    return [await getRelease(github, dependency)];
}

// Dependency can be the name of an entry in package.json, in which case the owner, repo & version will be looked up in its own package.json
// Or it can be a string in the form owner/repo@tag - in this case the tag is used exactly to find the release
// Or it can be a string in the form owner/repo~tag - in this case the latest tag in the same major.minor.patch set is used to find the release
async function getRelease(github, dependency) {
    let owner;
    let repo;
    let tag;

    if (dependency.includes("/")) {
        let rest;
        [owner, rest] = dependency.split("/");

        if (dependency.includes("@")) {
            [repo, tag] = rest.split("@");
        } else if (dependency.includes("~")) {
            [repo, tag] = rest.split("~");

            if (tag.includes("-rc.")) {
                // If the tag is an RC, find the latest matching RC in the set
                try {
                    const releases = await listReleases(github, owner, repo);
                    const baseVersion = tag.split("-rc.")[0];
                    const release = releases.find((release) => release.tag_name.startsWith(baseVersion));
                    if (release) return release;
                } catch (e) {
                    // Fall back to getReleaseByTag
                }
            }
        }
    } else {
        const upstreamPackageJson = getDependencyPackageJson(dependency);
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

function getDependencyPackageJson(dependency) {
    return JSON.parse(fs.readFileSync(`./node_modules/${dependency}/package.json`, "utf8"));
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

    const { data: release } = await github.rest.repos.getRelease({
        owner,
        repo,
        release_id: releaseId,
    });

    const sections = Object.fromEntries(categories.map((cat) => [cat, []]));
    parseReleaseNotes(release.body, sections);
    for (const dependency of dependencies) {
        const releases = await getReleases(github, dependency);
        for (const release of releases) {
            parseReleaseNotes(release.body, sections);
        }
    }

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
