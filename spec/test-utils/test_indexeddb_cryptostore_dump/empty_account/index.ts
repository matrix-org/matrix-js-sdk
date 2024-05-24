import { DumpDataSetInfo } from "../index";

/**
 * A key query response containing the current keys of the tested user.
 * To be used during tests with fetchmock.
 */
const KEYS_QUERY_RESPONSE: any = {
    device_keys: {},
    master_keys: {},
    self_signing_keys: {},
    user_signing_keys: {},
};

/**
 * A `/room_keys/version` response containing the current server-side backup info.
 * To be used during tests with fetchmock.
 */
const BACKUP_RESPONSE: any = {};

/**
 * A dataset containing the information for the tested user.
 * To be used during tests.
 */
export const EMPTY_ACCOUNT_DATASET: DumpDataSetInfo = {
    userId: "@emptyuser:example.com",
    deviceId: "EMPTYDEVIC",
    pickleKey: "+/bcdefghijklmnopqrstu1/zyxvutsrqponmlkjih2",
    backupResponse: BACKUP_RESPONSE,
    keyQueryResponse: KEYS_QUERY_RESPONSE,
    dumpPath: "spec/test-utils/test_indexeddb_cryptostore_dump/empty_account/dump.json",
};
