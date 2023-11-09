# Release Process

## Hotfix and off-cycle releases

1. Prepare the `staging` branch by using the backport automation and manually merging
2. Go to [Releasing](#Releasing)

## Release candidates

1. Prepare the `staging` branch by running the [branch cut automation](https://github.com/vector-im/element-web/actions/workflows/release_prepare.yml)
2. Go to [Releasing](#Releasing)

## Releasing

1. Open the [Releases page](https://github.com/matrix-org/matrix-js-sdk/releases) and inspect the draft release there
2. Make any modifications to the release notes and tag/version as required
3. Run [workflow](https://github.com/matrix-org/matrix-js-sdk/actions/workflows/release.yml) with the type set appropriately

## Artifacts

Releasing the Matrix JS SDK has just two artifacts:

-   Package published to [npm](https://github.com/matrix-org/matrix-js-sdk)
-   Docs published to [Github Pages](https://matrix-org.github.io/matrix-js-sdk/)
