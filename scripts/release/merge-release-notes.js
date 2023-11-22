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

const main = async ({ github, releaseId, dependencies }) => {
    const { GITHUB_REPOSITORY } = process.env;
    const [owner, repo] = GITHUB_REPOSITORY.split("/");

    const sections = new Map();
    let heading = null;
    for (const dependency of dependencies) {
        const release = await getRelease(github, dependency);
        for (const line of release.body.split("\n")) {
            if (line.startsWith(HEADING_PREFIX)) {
                heading = line.trim();
                sections.set(heading, []);
                continue;
            }
            if (heading && line) {
                sections.get(heading).push(line.trim());
            }
        }
    }

    const { data: release } = await github.rest.repos.getRelease({
        owner,
        repo,
        release_id: releaseId,
    });

    const headings = ["🚨 BREAKING CHANGES", "🦖 Deprecations", "✨ Features", "🐛 Bug Fixes", "🧰 Maintenance"].map(
        (h) => HEADING_PREFIX + h,
    );

    heading = null;
    const output = [];
    for (const line of [...release.body.split("\n"), null]) {
        if (line === null || line.startsWith(HEADING_PREFIX)) {
            // If we have a heading, and it's not the first in the list of pending headings, output the section.
            // If we're processing the last line (null) then output all remaining sections.
            while (headings.length > 0 && (line === null || (heading && headings[0] !== heading))) {
                const heading = headings.shift();
                if (sections.has(heading)) {
                    output.push(heading);
                    output.push(...sections.get(heading));
                }
            }

            if (heading && sections.has(heading)) {
                const lastIsBlank = !output.at(-1)?.trim();
                if (lastIsBlank) output.pop();
                output.push(...sections.get(heading));
                if (lastIsBlank) output.push("");
            }
            heading = line;
        }
        output.push(line);
    }

    return output.join("\n");
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
