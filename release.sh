#!/bin/sh
#
# Script to perform a release of matrix-js-sdk. Performs the steps documented
# in RELEASING.md
#
# Requires githib-changelog-generator; to install, do 
#   pip install git+https://github.com/matrix-org/github-changelog-generator.git

set -e

USAGE="$0 [-xz] [-c changelog_file] vX.Y.Z"

help() {
    cat <<EOF
$USAGE

    -c changelog_file:  specify name of file containing changelog
    -x:                 skip updating the changelog
    -z:                 skip generating the jsdoc
EOF
}

skip_changelog=
skip_jsdoc=
changelog_file="CHANGELOG.md"
while getopts hc:xz f; do
    case $f in
        h)
            help
            exit 0
            ;;
        c)
            changelog_file="$OPTARG"
            ;;
        x)
            skip_changelog=1
            ;;
        z)
            skip_jsdoc=1
            ;;
    esac
done
shift `expr $OPTIND - 1`

if [ $# -ne 1 ]; then
    echo "Usage: $USAGE" >&2
    exit 1
fi

tag="$1"

case "$tag" in
    v*) ;;
    
    *)
        echo 2>&1 "Tag $tag must start with v"
        exit 1
        ;;
esac

# strip leading 'v' to get release
release="${tag#v}"
rel_branch="release-$tag"

# we might already be on the release branch, in which case, yay
if [ $(git symbolic-ref --short HEAD) != "$rel_branch" ]; then
    echo "Creating release branch"
    git checkout -b "$rel_branch"
fi

if [ -z "$skip_changelog" ]; then
    echo "Generating changelog"
    update_changelog -f "$changelog_file" "$release"
    read -p "Edit $changelog_file manually, or press enter to continue " REPLY

    if [ -n "$(git ls-files --modified $changelog_file)" ]; then
        echo "Committing updated changelog"
        git commit "$changelog_file" -m "Prepare changelog for $tag"
    fi
fi

# Bump package.json, build the dist, and tag
echo "npm version"
npm version "$release"

if [ -z "$skip_jsdoc" ]; then
    echo "generating jsdocs"
    npm run gendoc

    echo "copying jsdocs to gh-pages branch"
    git checkout gh-pages
    git pull
    cp -ar ".jsdoc/matrix-js-sdk/$release" .
    perl -i -pe 'BEGIN {$rel=shift} $_ =~ /^<\/ul>/ && print
        "<li><a href=\"${rel}/index.html\">Version ${rel}</a></li>\n"' \
        $release index.html
    git add "$release"
    git commit --no-verify -m "Add jsdoc for $release" index.html "$release"
fi

# merge release branch to master
echo "updating master branch"
git checkout master
git pull
git merge --ff-only "$rel_branch"

# push everything to github
git push origin master "$rel_branch" "$tag"
if [ -z "$skip_jsdoc" ]; then
    git push origin gh-pages
fi

# publish to npmjs
npm publish

# finally, merge master back onto develop
git checkout develop
git pull
git merge master
git push origin develop
