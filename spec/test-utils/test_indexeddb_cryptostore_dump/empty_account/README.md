## Dump of an empty libolm indexeddb cryptostore to test skipping migration

A dump of an account which is almost completely empty, and totally unsuitable
for use as a real account.

This dump was manually created by copying and editing full_account.

Created to test
["Unable to restore session" error due due to half-initialised legacy indexeddb crypto store #27447](https://github.com/element-hq/element-web/issues/27447).
We should not launch the Rust migration code when we find a DB in this state.
