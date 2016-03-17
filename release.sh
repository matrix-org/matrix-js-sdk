#!/bin/sh
#
# Script to perform a release of matrix-js-sdk. Performs the steps documented
# in RELEASING.md
#
# Requires githib-changelog-generator; to install, do 
#   pip install git+https://github.com/matrix-org/github-changelog-generator.git

set -e

if [ $# -ne 1 ]; then
    echo 2>&1 "Usage: $0 vX.Y.Z"
    exit 1
fi

tag=$1

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

cd `dirname $0`

# we might already be on the release branch, in which case, yay
if [ $(git symbolic-ref --short HEAD) != "$rel_branch" ]; then
    echo "Creating release branch"
    git checkout -b "$rel_branch"
fi

echo "Generating changelog"
update_changelog "$release"
read -p "Edit CHANGELOG.md manually, or press enter to continue " REPLY

if [ -n "$(git ls-files --modified CHANGELOG.md)" ]; then
    echo "Committing updated changelog"
    git commit "CHANGELOG.md" -m "Prepare changelog for $tag"
fi

# Bump package.json, build the dist, and tag
echo "npm version"
npm version "$release"

# generate the docs
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

# merge release branch to master
echo "updating master branch"
git checkout master
git pull
git merge --ff-only "$rel_branch"

# push everything to github
git push origin master "$rel_branch" "$tag" "gh-pages"

# publish to npmjs
npm publish
