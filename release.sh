#!/bin/bash
#
# Script to perform a release of matrix-js-sdk.
#
# Requires:
#   github-changelog-generator; to install, do
#     pip install git+https://github.com/matrix-org/github-changelog-generator.git
#   jq; install from your distibution's package manager (https://stedolan.github.io/jq/)

set -e

jq --version > /dev/null || (echo "jq is required: please install it"; kill $$)
hub --version > /dev/null || (echo "hub is required: please install it"; kill $$)

USAGE="$0 [-xz] [-c changelog_file] vX.Y.Z"

help() {
    cat <<EOF
$USAGE

    -c changelog_file:  specify name of file containing changelog
    -x:                 skip updating the changelog
    -z:                 skip generating the jsdoc
EOF
}

ret=0
cat package.json | jq '.dependencies[]' | grep -q '#develop' || ret=$?
if [ "$ret" -eq 0 ]; then
    echo "package.json contains develop dependencies. Refusing to release."
    exit
fi

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

if [ -z "$skip_changelog" ]; then
    # update_changelog doesn't have a --version flag
    update_changelog -h > /dev/null || (echo "github-changelog-generator is required: please install it"; exit)
fi

# ignore leading v on release
release="${1#v}"
tag="v${release}"
rel_branch="release-$tag"

prerelease=0
# We check if this build is a prerelease by looking to
# see if the version has a hyphen in it. Crude,
# but semver doesn't support postreleases so anything
# with a hyphen is a prerelease.
echo $release | grep -q '-' && prerelease=1

if [ $prerelease -eq 1 ]; then
    echo Making a PRE-RELEASE
fi

if [ -z "$skip_changelog" ]; then
    if ! command -v update_changelog >/dev/null 2>&1; then
        echo "release.sh requires github-changelog-generator. Try:" >&2
        echo "    pip install git+https://github.com/matrix-org/github-changelog-generator.git" >&2
        exit 1
    fi
fi

# we might already be on the release branch, in which case, yay
# If we're on any branch starting with 'release', we don't create
# a separate release branch (this allows us to use the same
# release branch for releases and release candidates).
curbranch=$(git symbolic-ref --short HEAD)
if [[ "$curbranch" != release* ]]; then
    echo "Creating release branch"
    git checkout -b "$rel_branch"
else
    echo "Using current branch ($curbranch) for release"
    rel_branch=$curbranch
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
latest_changes=`mktemp`
cat "${changelog_file}" | `dirname $0`/scripts/changelog_head.py > "${latest_changes}"

set -x

# Bump package.json and build the dist
echo "npm version"
# npm version will automatically commit its modification
# and make a release tag. We don't want it to create the tag
# because it can only sign with the default key, but we can
# only turn off both of these behaviours, so we have to
# manually commit the result.
npm version --no-git-tag-version "$release"
git commit package.json -m "$tag"


# figure out if we should be signing this release
signing_id=
if [ -f release_config.yaml ]; then
    signing_id=`cat release_config.yaml | python -c "import yaml; import sys; print yaml.load(sys.stdin)['signing_id']"`
fi


# If there is a 'dist' script in the package.json,
# run it in a separate checkout of the project, then
# upload any files in the 'dist' directory as release
# assets.
# We make a completely separate checkout to be sure
# we're using released versions of the dependencies
# (rather than whatever we're pulling in from npm link)
assets=''
dodist=0
jq -e .scripts.dist package.json 2> /dev/null || dodist=$?
if [ $dodist -eq 0 ]; then
    projdir=`pwd`
    builddir=`mktemp -d 2>/dev/null || mktemp -d -t 'mytmpdir'`
    echo "Building distribution copy in $builddir"
    pushd "$builddir"
    git clone "$projdir" .
    git checkout "$rel_branch"
    npm install
    # We haven't tagged yet, so tell the dist script what version
    # it's building
    DIST_VERSION="$tag" npm run dist

    popd

    for i in "$builddir"/dist/*; do
        assets="$assets -a $i"
        if [ -n "$signing_id" ]
        then
            gpg -u "$signing_id" --armor --output "$i".asc --detach-sig "$i"
            assets="$assets -a $i.asc"
        fi
    done
fi

# push the release branch (github can't release from
# a branch it doesn't have)
git push origin "$rel_branch"

if [ -n "$signing_id" ]; then
    # make a signed tag
    # gnupg seems to fail to get the right tty device unless we set it here
    GIT_COMMITTER_EMAIL="$signing_id" GPG_TTY=`tty` git tag -u "$signing_id" -F "${latest_changes}" "$tag"
else
    git tag -a -F "${latest_changes}" "$tag"
fi

# push the tag
git push origin "$tag"

hubflags=''
if [ $prerelease -eq 1 ]; then
    hubflags='-p'
fi

release_text=`mktemp`
echo "$tag" > "${release_text}"
echo >> "${release_text}"
cat "${latest_changes}" >> "${release_text}"
hub release create $hubflags $assets -f "${release_text}" "$tag"

if [ $dodist -eq 0 ]; then
    rm -rf "$builddir"
fi
rm "${release_text}"
rm "${latest_changes}"

if [ -z "$skip_jsdoc" ]; then
    echo "generating jsdocs"
    npm run gendoc

    echo "copying jsdocs to gh-pages branch"
    git checkout gh-pages
    git pull
    cp -a ".jsdoc/matrix-js-sdk/$release" .
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

# push master  and docs (if generated) to github
git push origin master
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
