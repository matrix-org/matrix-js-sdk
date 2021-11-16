"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.MemoryCryptoStore = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _logger = require("../../logger");

var utils = _interopRequireWildcard(require("../../utils"));

function _getRequireWildcardCache(nodeInterop) { if (typeof WeakMap !== "function") return null; var cacheBabelInterop = new WeakMap(); var cacheNodeInterop = new WeakMap(); return (_getRequireWildcardCache = function (nodeInterop) { return nodeInterop ? cacheNodeInterop : cacheBabelInterop; })(nodeInterop); }

function _interopRequireWildcard(obj, nodeInterop) { if (!nodeInterop && obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(nodeInterop); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) { symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); } keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { (0, _defineProperty2.default)(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

/**
 * Internal module. in-memory storage for e2e.
 *
 * @module
 */

/**
 * @implements {module:crypto/store/base~CryptoStore}
 */
class MemoryCryptoStore {
  constructor() {
    (0, _defineProperty2.default)(this, "outgoingRoomKeyRequests", []);
    (0, _defineProperty2.default)(this, "account", null);
    (0, _defineProperty2.default)(this, "crossSigningKeys", null);
    (0, _defineProperty2.default)(this, "privateKeys", {});
    (0, _defineProperty2.default)(this, "sessions", {});
    (0, _defineProperty2.default)(this, "sessionProblems", {});
    (0, _defineProperty2.default)(this, "notifiedErrorDevices", {});
    (0, _defineProperty2.default)(this, "inboundGroupSessions", {});
    (0, _defineProperty2.default)(this, "inboundGroupSessionsWithheld", {});
    (0, _defineProperty2.default)(this, "deviceData", null);
    (0, _defineProperty2.default)(this, "rooms", {});
    (0, _defineProperty2.default)(this, "sessionsNeedingBackup", {});
    (0, _defineProperty2.default)(this, "sharedHistoryInboundGroupSessions", {});
  }

  /**
   * Ensure the database exists and is up-to-date.
   *
   * This must be called before the store can be used.
   *
   * @return {Promise} resolves to the store.
   */
  async startup() {
    // No startup work to do for the memory store.
    return this;
  }
  /**
   * Delete all data from this store.
   *
   * @returns {Promise} Promise which resolves when the store has been cleared.
   */


  deleteAllData() {
    return Promise.resolve();
  }
  /**
   * Look for an existing outgoing room key request, and if none is found,
   * add a new one
   *
   * @param {module:crypto/store/base~OutgoingRoomKeyRequest} request
   *
   * @returns {Promise} resolves to
   *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}: either the
   *    same instance as passed in, or the existing one.
   */


  getOrAddOutgoingRoomKeyRequest(request) {
    const requestBody = request.requestBody;
    return utils.promiseTry(() => {
      // first see if we already have an entry for this request.
      const existing = this._getOutgoingRoomKeyRequest(requestBody);

      if (existing) {
        // this entry matches the request - return it.
        _logger.logger.log(`already have key request outstanding for ` + `${requestBody.room_id} / ${requestBody.session_id}: ` + `not sending another`);

        return existing;
      } // we got to the end of the list without finding a match
      // - add the new request.


      _logger.logger.log(`enqueueing key request for ${requestBody.room_id} / ` + requestBody.session_id);

      this.outgoingRoomKeyRequests.push(request);
      return request;
    });
  }
  /**
   * Look for an existing room key request
   *
   * @param {module:crypto~RoomKeyRequestBody} requestBody
   *    existing request to look for
   *
   * @return {Promise} resolves to the matching
   *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
   *    not found
   */


  getOutgoingRoomKeyRequest(requestBody) {
    return Promise.resolve(this._getOutgoingRoomKeyRequest(requestBody));
  }
  /**
   * Looks for existing room key request, and returns the result synchronously.
   *
   * @internal
   *
   * @param {module:crypto~RoomKeyRequestBody} requestBody
   *    existing request to look for
   *
   * @return {module:crypto/store/base~OutgoingRoomKeyRequest?}
   *    the matching request, or null if not found
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention


  _getOutgoingRoomKeyRequest(requestBody) {
    for (const existing of this.outgoingRoomKeyRequests) {
      if (utils.deepCompare(existing.requestBody, requestBody)) {
        return existing;
      }
    }

    return null;
  }
  /**
   * Look for room key requests by state
   *
   * @param {Array<Number>} wantedStates list of acceptable states
   *
   * @return {Promise} resolves to the a
   *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}, or null if
   *    there are no pending requests in those states
   */


  getOutgoingRoomKeyRequestByState(wantedStates) {
    for (const req of this.outgoingRoomKeyRequests) {
      for (const state of wantedStates) {
        if (req.state === state) {
          return Promise.resolve(req);
        }
      }
    }

    return Promise.resolve(null);
  }
  /**
   *
   * @param {Number} wantedState
   * @return {Promise<Array<*>>} All OutgoingRoomKeyRequests in state
   */


  getAllOutgoingRoomKeyRequestsByState(wantedState) {
    return Promise.resolve(this.outgoingRoomKeyRequests.filter(r => r.state == wantedState));
  }

  getOutgoingRoomKeyRequestsByTarget(userId, deviceId, wantedStates) {
    const results = [];

    for (const req of this.outgoingRoomKeyRequests) {
      for (const state of wantedStates) {
        if (req.state === state && req.recipients.includes({
          userId,
          deviceId
        })) {
          results.push(req);
        }
      }
    }

    return Promise.resolve(results);
  }
  /**
   * Look for an existing room key request by id and state, and update it if
   * found
   *
   * @param {string} requestId      ID of request to update
   * @param {number} expectedState  state we expect to find the request in
   * @param {Object} updates        name/value map of updates to apply
   *
   * @returns {Promise} resolves to
   *    {@link module:crypto/store/base~OutgoingRoomKeyRequest}
   *    updated request, or null if no matching row was found
   */


  updateOutgoingRoomKeyRequest(requestId, expectedState, updates) {
    for (const req of this.outgoingRoomKeyRequests) {
      if (req.requestId !== requestId) {
        continue;
      }

      if (req.state !== expectedState) {
        _logger.logger.warn(`Cannot update room key request from ${expectedState} ` + `as it was already updated to ${req.state}`);

        return Promise.resolve(null);
      }

      Object.assign(req, updates);
      return Promise.resolve(req);
    }

    return Promise.resolve(null);
  }
  /**
   * Look for an existing room key request by id and state, and delete it if
   * found
   *
   * @param {string} requestId      ID of request to update
   * @param {number} expectedState  state we expect to find the request in
   *
   * @returns {Promise} resolves once the operation is completed
   */


  deleteOutgoingRoomKeyRequest(requestId, expectedState) {
    for (let i = 0; i < this.outgoingRoomKeyRequests.length; i++) {
      const req = this.outgoingRoomKeyRequests[i];

      if (req.requestId !== requestId) {
        continue;
      }

      if (req.state != expectedState) {
        _logger.logger.warn(`Cannot delete room key request in state ${req.state} ` + `(expected ${expectedState})`);

        return Promise.resolve(null);
      }

      this.outgoingRoomKeyRequests.splice(i, 1);
      return Promise.resolve(req);
    }

    return Promise.resolve(null);
  } // Olm Account


  getAccount(txn, func) {
    func(this.account);
  }

  storeAccount(txn, accountPickle) {
    this.account = accountPickle;
  }

  getCrossSigningKeys(txn, func) {
    func(this.crossSigningKeys);
  }

  getSecretStorePrivateKey(txn, func, type) {
    const result = this.privateKeys[type];
    func(result || null);
  }

  storeCrossSigningKeys(txn, keys) {
    this.crossSigningKeys = keys;
  }

  storeSecretStorePrivateKey(txn, type, key) {
    this.privateKeys[type] = key;
  } // Olm Sessions


  countEndToEndSessions(txn, func) {
    func(Object.keys(this.sessions).length);
  }

  getEndToEndSession(deviceKey, sessionId, txn, func) {
    const deviceSessions = this.sessions[deviceKey] || {};
    func(deviceSessions[sessionId] || null);
  }

  getEndToEndSessions(deviceKey, txn, func) {
    func(this.sessions[deviceKey] || {});
  }

  getAllEndToEndSessions(txn, func) {
    Object.entries(this.sessions).forEach(([deviceKey, deviceSessions]) => {
      Object.entries(deviceSessions).forEach(([sessionId, session]) => {
        func(_objectSpread(_objectSpread({}, session), {}, {
          deviceKey,
          sessionId
        }));
      });
    });
  }

  storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn) {
    let deviceSessions = this.sessions[deviceKey];

    if (deviceSessions === undefined) {
      deviceSessions = {};
      this.sessions[deviceKey] = deviceSessions;
    }

    deviceSessions[sessionId] = sessionInfo;
  }

  async storeEndToEndSessionProblem(deviceKey, type, fixed) {
    const problems = this.sessionProblems[deviceKey] = this.sessionProblems[deviceKey] || [];
    problems.push({
      type,
      fixed,
      time: Date.now()
    });
    problems.sort((a, b) => {
      return a.time - b.time;
    });
  }

  async getEndToEndSessionProblem(deviceKey, timestamp) {
    const problems = this.sessionProblems[deviceKey] || [];

    if (!problems.length) {
      return null;
    }

    const lastProblem = problems[problems.length - 1];

    for (const problem of problems) {
      if (problem.time > timestamp) {
        return Object.assign({}, problem, {
          fixed: lastProblem.fixed
        });
      }
    }

    if (lastProblem.fixed) {
      return null;
    } else {
      return lastProblem;
    }
  }

  async filterOutNotifiedErrorDevices(devices) {
    const notifiedErrorDevices = this.notifiedErrorDevices;
    const ret = [];

    for (const device of devices) {
      const {
        userId,
        deviceInfo
      } = device;

      if (userId in notifiedErrorDevices) {
        if (!(deviceInfo.deviceId in notifiedErrorDevices[userId])) {
          ret.push(device);
          notifiedErrorDevices[userId][deviceInfo.deviceId] = true;
        }
      } else {
        ret.push(device);
        notifiedErrorDevices[userId] = {
          [deviceInfo.deviceId]: true
        };
      }
    }

    return ret;
  } // Inbound Group Sessions


  getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
    const k = senderCurve25519Key + '/' + sessionId;
    func(this.inboundGroupSessions[k] || null, this.inboundGroupSessionsWithheld[k] || null);
  }

  getAllEndToEndInboundGroupSessions(txn, func) {
    for (const key of Object.keys(this.inboundGroupSessions)) {
      // we can't use split, as the components we are trying to split out
      // might themselves contain '/' characters. We rely on the
      // senderKey being a (32-byte) curve25519 key, base64-encoded
      // (hence 43 characters long).
      func({
        senderKey: key.substr(0, 43),
        sessionId: key.substr(44),
        sessionData: this.inboundGroupSessions[key]
      });
    }

    func(null);
  }

  addEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
    const k = senderCurve25519Key + '/' + sessionId;

    if (this.inboundGroupSessions[k] === undefined) {
      this.inboundGroupSessions[k] = sessionData;
    }
  }

  storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
    this.inboundGroupSessions[senderCurve25519Key + '/' + sessionId] = sessionData;
  }

  storeEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId, sessionData, txn) {
    const k = senderCurve25519Key + '/' + sessionId;
    this.inboundGroupSessionsWithheld[k] = sessionData;
  } // Device Data


  getEndToEndDeviceData(txn, func) {
    func(this.deviceData);
  }

  storeEndToEndDeviceData(deviceData, txn) {
    this.deviceData = deviceData;
  } // E2E rooms


  storeEndToEndRoom(roomId, roomInfo, txn) {
    this.rooms[roomId] = roomInfo;
  }

  getEndToEndRooms(txn, func) {
    func(this.rooms);
  }

  getSessionsNeedingBackup(limit) {
    const sessions = [];

    for (const session in this.sessionsNeedingBackup) {
      if (this.inboundGroupSessions[session]) {
        sessions.push({
          senderKey: session.substr(0, 43),
          sessionId: session.substr(44),
          sessionData: this.inboundGroupSessions[session]
        });

        if (limit && session.length >= limit) {
          break;
        }
      }
    }

    return Promise.resolve(sessions);
  }

  countSessionsNeedingBackup() {
    return Promise.resolve(Object.keys(this.sessionsNeedingBackup).length);
  }

  unmarkSessionsNeedingBackup(sessions) {
    for (const session of sessions) {
      const sessionKey = session.senderKey + '/' + session.sessionId;
      delete this.sessionsNeedingBackup[sessionKey];
    }

    return Promise.resolve();
  }

  markSessionsNeedingBackup(sessions) {
    for (const session of sessions) {
      const sessionKey = session.senderKey + '/' + session.sessionId;
      this.sessionsNeedingBackup[sessionKey] = true;
    }

    return Promise.resolve();
  }

  addSharedHistoryInboundGroupSession(roomId, senderKey, sessionId) {
    const sessions = this.sharedHistoryInboundGroupSessions[roomId] || [];
    sessions.push([senderKey, sessionId]);
    this.sharedHistoryInboundGroupSessions[roomId] = sessions;
  }

  getSharedHistoryInboundGroupSessions(roomId) {
    return Promise.resolve(this.sharedHistoryInboundGroupSessions[roomId] || []);
  } // Session key backups


  doTxn(mode, stores, func) {
    return Promise.resolve(func(null));
  }

}

exports.MemoryCryptoStore = MemoryCryptoStore;