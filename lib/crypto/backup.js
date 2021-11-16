"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.algorithmsByName = exports.DefaultAlgorithm = exports.Curve25519 = exports.BackupManager = exports.Aes256 = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _client = require("../client");

var _logger = require("../logger");

var _olmlib = require("./olmlib");

var _key_passphrase = require("./key_passphrase");

var _utils = require("../utils");

var _indexeddbCryptoStore = require("./store/indexeddb-crypto-store");

var _recoverykey = require("./recoverykey");

var _aes = require("./aes");

var _NamespacedValue = require("../NamespacedValue");

/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * @module crypto/backup
 *
 * Classes for dealing with key backup.
 */
const KEY_BACKUP_KEYS_PER_REQUEST = 200;

/**
 * Manages the key backup.
 */
class BackupManager {
  // The info dict from /room_keys/version
  // Have we checked the server for a backup we can use?
  // Are we currently sending backups?
  constructor(baseApis, getKey) {
    this.baseApis = baseApis;
    this.getKey = getKey;
    (0, _defineProperty2.default)(this, "algorithm", void 0);
    (0, _defineProperty2.default)(this, "backupInfo", void 0);
    (0, _defineProperty2.default)(this, "checkedForBackup", void 0);
    (0, _defineProperty2.default)(this, "sendingBackups", void 0);
    this.checkedForBackup = false;
    this.sendingBackups = false;
  }

  get version() {
    return this.backupInfo && this.backupInfo.version;
  }
  /**
   * Performs a quick check to ensure that the backup info looks sane.
   *
   * Throws an error if a problem is detected.
   *
   * @param {IKeyBackupInfo} info the key backup info
   */


  static checkBackupVersion(info) {
    const Algorithm = algorithmsByName[info.algorithm];

    if (!Algorithm) {
      throw new Error("Unknown backup algorithm: " + info.algorithm);
    }

    if (!(typeof info.auth_data === "object")) {
      throw new Error("Invalid backup data returned");
    }

    return Algorithm.checkBackupVersion(info);
  }

  static async makeAlgorithm(info, getKey) {
    const Algorithm = algorithmsByName[info.algorithm];

    if (!Algorithm) {
      throw new Error("Unknown backup algorithm");
    }

    return await Algorithm.init(info.auth_data, getKey);
  }

  async enableKeyBackup(info) {
    this.backupInfo = info;

    if (this.algorithm) {
      this.algorithm.free();
    }

    this.algorithm = await BackupManager.makeAlgorithm(info, this.getKey);
    this.baseApis.emit('crypto.keyBackupStatus', true); // There may be keys left over from a partially completed backup, so
    // schedule a send to check.

    this.scheduleKeyBackupSend();
  }
  /**
   * Disable backing up of keys.
   */


  disableKeyBackup() {
    if (this.algorithm) {
      this.algorithm.free();
    }

    this.algorithm = undefined;
    this.backupInfo = undefined;
    this.baseApis.emit('crypto.keyBackupStatus', false);
  }

  getKeyBackupEnabled() {
    if (!this.checkedForBackup) {
      return null;
    }

    return Boolean(this.algorithm);
  }

  async prepareKeyBackupVersion(key, algorithm // eslint-disable-next-line camelcase
  ) {
    const Algorithm = algorithm ? algorithmsByName[algorithm] : DefaultAlgorithm;

    if (!Algorithm) {
      throw new Error("Unknown backup algorithm");
    }

    const [privateKey, authData] = await Algorithm.prepare(key);
    const recoveryKey = (0, _recoverykey.encodeRecoveryKey)(privateKey);
    return {
      algorithm: Algorithm.algorithmName,
      auth_data: authData,
      recovery_key: recoveryKey,
      privateKey
    };
  }

  async createKeyBackupVersion(info) {
    this.algorithm = await BackupManager.makeAlgorithm(info, this.getKey);
  }
  /**
   * Check the server for an active key backup and
   * if one is present and has a valid signature from
   * one of the user's verified devices, start backing up
   * to it.
   */


  async checkAndStart() {
    _logger.logger.log("Checking key backup status...");

    if (this.baseApis.isGuest()) {
      _logger.logger.log("Skipping key backup check since user is guest");

      this.checkedForBackup = true;
      return null;
    }

    let backupInfo;

    try {
      backupInfo = await this.baseApis.getKeyBackupVersion();
    } catch (e) {
      _logger.logger.log("Error checking for active key backup", e);

      if (e.httpStatus === 404) {
        // 404 is returned when the key backup does not exist, so that
        // counts as successfully checking.
        this.checkedForBackup = true;
      }

      return null;
    }

    this.checkedForBackup = true;
    const trustInfo = await this.isKeyBackupTrusted(backupInfo);

    if (trustInfo.usable && !this.backupInfo) {
      _logger.logger.log("Found usable key backup v" + backupInfo.version + ": enabling key backups");

      await this.enableKeyBackup(backupInfo);
    } else if (!trustInfo.usable && this.backupInfo) {
      _logger.logger.log("No usable key backup: disabling key backup");

      this.disableKeyBackup();
    } else if (!trustInfo.usable && !this.backupInfo) {
      _logger.logger.log("No usable key backup: not enabling key backup");
    } else if (trustInfo.usable && this.backupInfo) {
      // may not be the same version: if not, we should switch
      if (backupInfo.version !== this.backupInfo.version) {
        _logger.logger.log("On backup version " + this.backupInfo.version + " but found " + "version " + backupInfo.version + ": switching.");

        this.disableKeyBackup();
        await this.enableKeyBackup(backupInfo); // We're now using a new backup, so schedule all the keys we have to be
        // uploaded to the new backup. This is a bit of a workaround to upload
        // keys to a new backup in *most* cases, but it won't cover all cases
        // because we don't remember what backup version we uploaded keys to:
        // see https://github.com/vector-im/element-web/issues/14833

        await this.scheduleAllGroupSessionsForBackup();
      } else {
        _logger.logger.log("Backup version " + backupInfo.version + " still current");
      }
    }

    return {
      backupInfo,
      trustInfo
    };
  }
  /**
   * Forces a re-check of the key backup and enables/disables it
   * as appropriate.
   *
   * @return {Object} Object with backup info (as returned by
   *     getKeyBackupVersion) in backupInfo and
   *     trust information (as returned by isKeyBackupTrusted)
   *     in trustInfo.
   */


  async checkKeyBackup() {
    this.checkedForBackup = false;
    return this.checkAndStart();
  }
  /**
   * Check if the given backup info is trusted.
   *
   * @param {IKeyBackupInfo} backupInfo key backup info dict from /room_keys/version
   * @return {object} {
   *     usable: [bool], // is the backup trusted, true iff there is a sig that is valid & from a trusted device
   *     sigs: [
   *         valid: [bool || null], // true: valid, false: invalid, null: cannot attempt validation
   *         deviceId: [string],
   *         device: [DeviceInfo || null],
   *     ]
   * }
   */


  async isKeyBackupTrusted(backupInfo) {
    const ret = {
      usable: false,
      trusted_locally: false,
      sigs: []
    };

    if (!backupInfo || !backupInfo.algorithm || !backupInfo.auth_data || !backupInfo.auth_data.signatures) {
      _logger.logger.info("Key backup is absent or missing required data");

      return ret;
    }

    const trustedPubkey = this.baseApis.crypto.sessionStore.getLocalTrustedBackupPubKey();

    if ("public_key" in backupInfo.auth_data && backupInfo.auth_data.public_key === trustedPubkey) {
      _logger.logger.info("Backup public key " + trustedPubkey + " is trusted locally");

      ret.trusted_locally = true;
    }

    const mySigs = backupInfo.auth_data.signatures[this.baseApis.getUserId()] || [];

    for (const keyId of Object.keys(mySigs)) {
      const keyIdParts = keyId.split(':');

      if (keyIdParts[0] !== 'ed25519') {
        _logger.logger.log("Ignoring unknown signature type: " + keyIdParts[0]);

        continue;
      } // Could be a cross-signing master key, but just say this is the device
      // ID for backwards compat


      const sigInfo = {
        deviceId: keyIdParts[1]
      }; // first check to see if it's from our cross-signing key

      const crossSigningId = this.baseApis.crypto.crossSigningInfo.getId();

      if (crossSigningId === sigInfo.deviceId) {
        sigInfo.crossSigningId = true;

        try {
          await (0, _olmlib.verifySignature)(this.baseApis.crypto.olmDevice, backupInfo.auth_data, this.baseApis.getUserId(), sigInfo.deviceId, crossSigningId);
          sigInfo.valid = true;
        } catch (e) {
          _logger.logger.warn("Bad signature from cross signing key " + crossSigningId, e);

          sigInfo.valid = false;
        }

        ret.sigs.push(sigInfo);
        continue;
      } // Now look for a sig from a device
      // At some point this can probably go away and we'll just support
      // it being signed by the cross-signing master key


      const device = this.baseApis.crypto.deviceList.getStoredDevice(this.baseApis.getUserId(), sigInfo.deviceId);

      if (device) {
        sigInfo.device = device;
        sigInfo.deviceTrust = await this.baseApis.checkDeviceTrust(this.baseApis.getUserId(), sigInfo.deviceId);

        try {
          await (0, _olmlib.verifySignature)(this.baseApis.crypto.olmDevice, backupInfo.auth_data, this.baseApis.getUserId(), device.deviceId, device.getFingerprint());
          sigInfo.valid = true;
        } catch (e) {
          _logger.logger.info("Bad signature from key ID " + keyId + " userID " + this.baseApis.getUserId() + " device ID " + device.deviceId + " fingerprint: " + device.getFingerprint(), backupInfo.auth_data, e);

          sigInfo.valid = false;
        }
      } else {
        sigInfo.valid = null; // Can't determine validity because we don't have the signing device

        _logger.logger.info("Ignoring signature from unknown key " + keyId);
      }

      ret.sigs.push(sigInfo);
    }

    ret.usable = ret.sigs.some(s => {
      return s.valid && (s.device && s.deviceTrust.isVerified() || s.crossSigningId);
    });
    ret.usable = ret.usable || ret.trusted_locally;
    return ret;
  }
  /**
   * Schedules sending all keys waiting to be sent to the backup, if not already
   * scheduled. Retries if necessary.
   *
   * @param maxDelay Maximum delay to wait in ms. 0 means no delay.
   */


  async scheduleKeyBackupSend(maxDelay = 10000) {
    if (this.sendingBackups) return;
    this.sendingBackups = true;

    try {
      // wait between 0 and `maxDelay` seconds, to avoid backup
      // requests from different clients hitting the server all at
      // the same time when a new key is sent
      const delay = Math.random() * maxDelay;
      await (0, _utils.sleep)(delay, undefined);
      let numFailures = 0; // number of consecutive failures

      for (;;) {
        if (!this.algorithm) {
          return;
        }

        try {
          const numBackedUp = await this.backupPendingKeys(KEY_BACKUP_KEYS_PER_REQUEST);

          if (numBackedUp === 0) {
            // no sessions left needing backup: we're done
            return;
          }

          numFailures = 0;
        } catch (err) {
          numFailures++;

          _logger.logger.log("Key backup request failed", err);

          if (err.data) {
            if (err.data.errcode == 'M_NOT_FOUND' || err.data.errcode == 'M_WRONG_ROOM_KEYS_VERSION') {
              // Re-check key backup status on error, so we can be
              // sure to present the current situation when asked.
              await this.checkKeyBackup(); // Backup version has changed or this backup version
              // has been deleted

              this.baseApis.crypto.emit("crypto.keyBackupFailed", err.data.errcode);
              throw err;
            }
          }
        }

        if (numFailures) {
          // exponential backoff if we have failures
          await (0, _utils.sleep)(1000 * Math.pow(2, Math.min(numFailures - 1, 4)), undefined);
        }
      }
    } finally {
      this.sendingBackups = false;
    }
  }
  /**
   * Take some e2e keys waiting to be backed up and send them
   * to the backup.
   *
   * @param {integer} limit Maximum number of keys to back up
   * @returns {integer} Number of sessions backed up
   */


  async backupPendingKeys(limit) {
    const sessions = await this.baseApis.crypto.cryptoStore.getSessionsNeedingBackup(limit);

    if (!sessions.length) {
      return 0;
    }

    let remaining = await this.baseApis.crypto.cryptoStore.countSessionsNeedingBackup();
    this.baseApis.crypto.emit("crypto.keyBackupSessionsRemaining", remaining);
    const rooms = {};

    for (const session of sessions) {
      const roomId = session.sessionData.room_id;

      if (rooms[roomId] === undefined) {
        rooms[roomId] = {
          sessions: {}
        };
      }

      const sessionData = await this.baseApis.crypto.olmDevice.exportInboundGroupSession(session.senderKey, session.sessionId, session.sessionData);
      sessionData.algorithm = _olmlib.MEGOLM_ALGORITHM;
      const forwardedCount = (sessionData.forwarding_curve25519_key_chain || []).length;
      const userId = this.baseApis.crypto.deviceList.getUserByIdentityKey(_olmlib.MEGOLM_ALGORITHM, session.senderKey);
      const device = this.baseApis.crypto.deviceList.getDeviceByIdentityKey(_olmlib.MEGOLM_ALGORITHM, session.senderKey);
      const verified = this.baseApis.crypto.checkDeviceInfoTrust(userId, device).isVerified();
      rooms[roomId]['sessions'][session.sessionId] = {
        first_message_index: sessionData.first_known_index,
        forwarded_count: forwardedCount,
        is_verified: verified,
        session_data: await this.algorithm.encryptSession(sessionData)
      };
    }

    await this.baseApis.sendKeyBackup(undefined, undefined, this.backupInfo.version, {
      rooms
    });
    await this.baseApis.crypto.cryptoStore.unmarkSessionsNeedingBackup(sessions);
    remaining = await this.baseApis.crypto.cryptoStore.countSessionsNeedingBackup();
    this.baseApis.crypto.emit("crypto.keyBackupSessionsRemaining", remaining);
    return sessions.length;
  }

  async backupGroupSession(senderKey, sessionId) {
    await this.baseApis.crypto.cryptoStore.markSessionsNeedingBackup([{
      senderKey: senderKey,
      sessionId: sessionId
    }]);

    if (this.backupInfo) {
      // don't wait for this to complete: it will delay so
      // happens in the background
      this.scheduleKeyBackupSend();
    } // if this.backupInfo is not set, then the keys will be backed up when
    // this.enableKeyBackup is called

  }
  /**
   * Marks all group sessions as needing to be backed up and schedules them to
   * upload in the background as soon as possible.
   */


  async scheduleAllGroupSessionsForBackup() {
    await this.flagAllGroupSessionsForBackup(); // Schedule keys to upload in the background as soon as possible.

    this.scheduleKeyBackupSend(0
    /* maxDelay */
    );
  }
  /**
   * Marks all group sessions as needing to be backed up without scheduling
   * them to upload in the background.
   * @returns {Promise<int>} Resolves to the number of sessions now requiring a backup
   *     (which will be equal to the number of sessions in the store).
   */


  async flagAllGroupSessionsForBackup() {
    await this.baseApis.crypto.cryptoStore.doTxn('readwrite', [_indexeddbCryptoStore.IndexedDBCryptoStore.STORE_INBOUND_GROUP_SESSIONS, _indexeddbCryptoStore.IndexedDBCryptoStore.STORE_BACKUP], txn => {
      this.baseApis.crypto.cryptoStore.getAllEndToEndInboundGroupSessions(txn, session => {
        if (session !== null) {
          this.baseApis.crypto.cryptoStore.markSessionsNeedingBackup([session], txn);
        }
      });
    });
    const remaining = await this.baseApis.crypto.cryptoStore.countSessionsNeedingBackup();
    this.baseApis.emit("crypto.keyBackupSessionsRemaining", remaining);
    return remaining;
  }
  /**
   * Counts the number of end to end session keys that are waiting to be backed up
   * @returns {Promise<int>} Resolves to the number of sessions requiring backup
   */


  countSessionsNeedingBackup() {
    return this.baseApis.crypto.cryptoStore.countSessionsNeedingBackup();
  }

}

exports.BackupManager = BackupManager;

class Curve25519 {
  constructor(authData, publicKey, // FIXME: PkEncryption
  getKey) {
    this.authData = authData;
    this.publicKey = publicKey;
    this.getKey = getKey;
  }

  static async init(authData, getKey) {
    if (!authData || !("public_key" in authData)) {
      throw new Error("auth_data missing required information");
    }

    const publicKey = new global.Olm.PkEncryption();
    publicKey.set_recipient_key(authData.public_key);
    return new Curve25519(authData, publicKey, getKey);
  }

  static async prepare(key) {
    const decryption = new global.Olm.PkDecryption();

    try {
      const authData = {};

      if (!key) {
        authData.public_key = decryption.generate_key();
      } else if (key instanceof Uint8Array) {
        authData.public_key = decryption.init_with_private_key(key);
      } else {
        const derivation = await (0, _key_passphrase.keyFromPassphrase)(key);
        authData.private_key_salt = derivation.salt;
        authData.private_key_iterations = derivation.iterations;
        authData.public_key = decryption.init_with_private_key(derivation.key);
      }

      const publicKey = new global.Olm.PkEncryption();
      publicKey.set_recipient_key(authData.public_key);
      return [decryption.get_private_key(), authData];
    } finally {
      decryption.free();
    }
  }

  static checkBackupVersion(info) {
    if (!("public_key" in info.auth_data)) {
      throw new Error("Invalid backup data returned");
    }
  }

  get untrusted() {
    return true;
  }

  async encryptSession(data) {
    const plainText = Object.assign({}, data);
    delete plainText.session_id;
    delete plainText.room_id;
    delete plainText.first_known_index;
    return this.publicKey.encrypt(JSON.stringify(plainText));
  }

  async decryptSessions(sessions) {
    const privKey = await this.getKey();
    const decryption = new global.Olm.PkDecryption();

    try {
      const backupPubKey = decryption.init_with_private_key(privKey);

      if (backupPubKey !== this.authData.public_key) {
        // eslint-disable-next-line no-throw-literal
        throw {
          errcode: _client.MatrixClient.RESTORE_BACKUP_ERROR_BAD_KEY
        };
      }

      const keys = [];

      for (const [sessionId, sessionData] of Object.entries(sessions)) {
        try {
          const decrypted = JSON.parse(decryption.decrypt(sessionData.session_data.ephemeral, sessionData.session_data.mac, sessionData.session_data.ciphertext));
          decrypted.session_id = sessionId;
          keys.push(decrypted);
        } catch (e) {
          _logger.logger.log("Failed to decrypt megolm session from backup", e, sessionData);
        }
      }

      return keys;
    } finally {
      decryption.free();
    }
  }

  async keyMatches(key) {
    const decryption = new global.Olm.PkDecryption();
    let pubKey;

    try {
      pubKey = decryption.init_with_private_key(key);
    } finally {
      decryption.free();
    }

    return pubKey === this.authData.public_key;
  }

  free() {
    this.publicKey.free();
  }

}

exports.Curve25519 = Curve25519;
(0, _defineProperty2.default)(Curve25519, "algorithmName", "m.megolm_backup.v1.curve25519-aes-sha2");

function randomBytes(size) {
  var _window;

  const crypto = (0, _utils.getCrypto)();

  if (crypto) {
    // nodejs version
    return crypto.randomBytes(size);
  }

  if ((_window = window) !== null && _window !== void 0 && _window.crypto) {
    // browser version
    const buf = new Uint8Array(size);
    window.crypto.getRandomValues(buf);
    return buf;
  }

  throw new Error("No usable crypto implementation");
}

const UNSTABLE_MSC3270_NAME = new _NamespacedValue.UnstableValue(null, "org.matrix.msc3270.v1.aes-hmac-sha2");

class Aes256 {
  constructor(authData, key) {
    this.authData = authData;
    this.key = key;
  }

  static async init(authData, getKey) {
    if (!authData) {
      throw new Error("auth_data missing");
    }

    const key = await getKey();

    if (authData.mac) {
      const {
        mac
      } = await (0, _aes.calculateKeyCheck)(key, authData.iv);

      if (authData.mac.replace(/=+$/g, '') !== mac.replace(/=+/g, '')) {
        throw new Error("Key does not match");
      }
    }

    return new Aes256(authData, key);
  }

  static async prepare(key) {
    let outKey;
    const authData = {};

    if (!key) {
      outKey = randomBytes(32);
    } else if (key instanceof Uint8Array) {
      outKey = new Uint8Array(key);
    } else {
      const derivation = await (0, _key_passphrase.keyFromPassphrase)(key);
      authData.private_key_salt = derivation.salt;
      authData.private_key_iterations = derivation.iterations;
      outKey = derivation.key;
    }

    const {
      iv,
      mac
    } = await (0, _aes.calculateKeyCheck)(outKey);
    authData.iv = iv;
    authData.mac = mac;
    return [outKey, authData];
  }

  static checkBackupVersion(info) {
    if (!("iv" in info.auth_data && "mac" in info.auth_data)) {
      throw new Error("Invalid backup data returned");
    }
  }

  get untrusted() {
    return false;
  }

  async encryptSession(data) {
    const plainText = Object.assign({}, data);
    delete plainText.session_id;
    delete plainText.room_id;
    delete plainText.first_known_index;
    return await (0, _aes.encryptAES)(JSON.stringify(plainText), this.key, data.session_id);
  }

  async decryptSessions(sessions) {
    const keys = [];

    for (const [sessionId, sessionData] of Object.entries(sessions)) {
      try {
        const decrypted = JSON.parse(await (0, _aes.decryptAES)(sessionData.session_data, this.key, sessionId));
        decrypted.session_id = sessionId;
        keys.push(decrypted);
      } catch (e) {
        _logger.logger.log("Failed to decrypt megolm session from backup", e, sessionData);
      }
    }

    return keys;
  }

  async keyMatches(key) {
    if (this.authData.mac) {
      const {
        mac
      } = await (0, _aes.calculateKeyCheck)(key, this.authData.iv);
      return this.authData.mac.replace(/=+$/g, '') === mac.replace(/=+/g, '');
    } else {
      // if we have no information, we have to assume the key is right
      return true;
    }
  }

  free() {
    this.key.fill(0);
  }

}

exports.Aes256 = Aes256;
(0, _defineProperty2.default)(Aes256, "algorithmName", UNSTABLE_MSC3270_NAME.name);
const algorithmsByName = {
  [Curve25519.algorithmName]: Curve25519,
  [Aes256.algorithmName]: Aes256
};
exports.algorithmsByName = algorithmsByName;
const DefaultAlgorithm = Curve25519;
exports.DefaultAlgorithm = DefaultAlgorithm;