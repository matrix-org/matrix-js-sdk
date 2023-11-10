#!/usr/bin/env node

const fs = require("fs");

async function getRelease(github, dependency) {
    const upstreamPackageJson = JSON.parse(fs.readFileSync(`./node_modules/${dependency}/package.json`, "utf8"));
    const [owner, repo] = upstreamPackageJson.repository.url.split("/").slice(-2);
    const tag = `v${upstreamPackageJson.version}`;

    const response = await github.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag,
    });
    return response.data;
}

const main = async ({ github, releaseId, dependencies }) => {
    const { GITHUB_REPOSITORY } = process.env;
    const [owner, repo] = GITHUB_REPOSITORY.split("/");

    const sections = new Map();
    let heading = null;
    for (const dependency of dependencies) {
        const release = await getRelease(github, dependency);
        for (const line of release.body.split("\n")) {
            if (line.startsWith("#")) {
                heading = line;
                sections.set(heading, []);
                continue;
            }
            if (heading && line) {
                sections.get(heading).push(line);
            }
        }
    }

    const { data: release } = await github.rest.repos.getRelease({
        owner,
        repo,
        release_id: releaseId,
    });

    heading = null;
    const output = [];
    for (const line of [...release.body.split("\n"), null]) {
        if (line === null || line.startsWith("#")) {
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
