"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ToDeviceRequests = exports.ToDeviceChannel = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _randomstring = require("../../../randomstring");

var _logger = require("../../../logger");

var _VerificationRequest = require("./VerificationRequest");

var _Error = require("../Error");

var _event = require("../../../models/event");

/*
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

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
 * A key verification channel that sends verification events over to_device messages.
 * Generates its own transaction ids.
 */
class ToDeviceChannel {
  // userId and devices of user we're about to verify
  constructor(client, userId, devices, transactionId = null, deviceId = null) {
    this.client = client;
    this.userId = userId;
    this.devices = devices;
    this.transactionId = transactionId;
    this.deviceId = deviceId;
    (0, _defineProperty2.default)(this, "request", void 0);
  }

  isToDevices(devices) {
    if (devices.length === this.devices.length) {
      for (const device of devices) {
        if (!this.devices.includes(device)) {
          return false;
        }
      }

      return true;
    } else {
      return false;
    }
  }

  static getEventType(event) {
    return event.getType();
  }
  /**
   * Extract the transaction id used by a given key verification event, if any
   * @param {MatrixEvent} event the event
   * @returns {string} the transaction id
   */


  static getTransactionId(event) {
    const content = event.getContent();
    return content && content.transaction_id;
  }
  /**
   * Checks whether the given event type should be allowed to initiate a new VerificationRequest over this channel
   * @param {string} type the event type to check
   * @returns {boolean} boolean flag
   */


  static canCreateRequest(type) {
    return type === _VerificationRequest.REQUEST_TYPE || type === _VerificationRequest.START_TYPE;
  }

  canCreateRequest(type) {
    return ToDeviceChannel.canCreateRequest(type);
  }
  /**
   * Checks whether this event is a well-formed key verification event.
   * This only does checks that don't rely on the current state of a potentially already channel
   * so we can prevent channels being created by invalid events.
   * `handleEvent` can do more checks and choose to ignore invalid events.
   * @param {MatrixEvent} event the event to validate
   * @param {MatrixClient} client the client to get the current user and device id from
   * @returns {boolean} whether the event is valid and should be passed to handleEvent
   */


  static validateEvent(event, client) {
    if (event.isCancelled()) {
      _logger.logger.warn("Ignoring flagged verification request from " + event.getSender());

      return false;
    }

    const content = event.getContent();

    if (!content) {
      _logger.logger.warn("ToDeviceChannel.validateEvent: invalid: no content");

      return false;
    }

    if (!content.transaction_id) {
      _logger.logger.warn("ToDeviceChannel.validateEvent: invalid: no transaction_id");

      return false;
    }

    const type = event.getType();

    if (type === _VerificationRequest.REQUEST_TYPE) {
      if (!Number.isFinite(content.timestamp)) {
        _logger.logger.warn("ToDeviceChannel.validateEvent: invalid: no timestamp");

        return false;
      }

      if (event.getSender() === client.getUserId() && content.from_device == client.getDeviceId()) {
        // ignore requests from ourselves, because it doesn't make sense for a
        // device to verify itself
        _logger.logger.warn("ToDeviceChannel.validateEvent: invalid: from own device");

        return false;
      }
    }

    return _VerificationRequest.VerificationRequest.validateEvent(type, event, client);
  }
  /**
   * @param {MatrixEvent} event the event to get the timestamp of
   * @return {number} the timestamp when the event was sent
   */


  getTimestamp(event) {
    const content = event.getContent();
    return content && content.timestamp;
  }
  /**
   * Changes the state of the channel, request, and verifier in response to a key verification event.
   * @param {MatrixEvent} event to handle
   * @param {VerificationRequest} request the request to forward handling to
   * @param {boolean} isLiveEvent whether this is an even received through sync or not
   * @returns {Promise} a promise that resolves when any requests as an answer to the passed-in event are sent.
   */


  async handleEvent(event, request, isLiveEvent = false) {
    const type = event.getType();
    const content = event.getContent();

    if (type === _VerificationRequest.REQUEST_TYPE || type === _VerificationRequest.READY_TYPE || type === _VerificationRequest.START_TYPE) {
      if (!this.transactionId) {
        this.transactionId = content.transaction_id;
      }

      const deviceId = content.from_device; // adopt deviceId if not set before and valid

      if (!this.deviceId && this.devices.includes(deviceId)) {
        this.deviceId = deviceId;
      } // if no device id or different from adopted one, cancel with sender


      if (!this.deviceId || this.deviceId !== deviceId) {
        // also check that message came from the device we sent the request to earlier on
        // and do send a cancel message to that device
        // (but don't cancel the request for the device we should be talking to)
        const cancelContent = this.completeContent(_VerificationRequest.CANCEL_TYPE, (0, _Error.errorFromEvent)((0, _Error.newUnexpectedMessageError)()));
        return this.sendToDevices(_VerificationRequest.CANCEL_TYPE, cancelContent, [deviceId]);
      }
    }

    const wasStarted = request.phase === _VerificationRequest.PHASE_STARTED || request.phase === _VerificationRequest.PHASE_READY;
    await request.handleEvent(event.getType(), event, isLiveEvent, false, false);
    const isStarted = request.phase === _VerificationRequest.PHASE_STARTED || request.phase === _VerificationRequest.PHASE_READY;
    const isAcceptingEvent = type === _VerificationRequest.START_TYPE || type === _VerificationRequest.READY_TYPE; // the request has picked a ready or start event, tell the other devices about it

    if (isAcceptingEvent && !wasStarted && isStarted && this.deviceId) {
      const nonChosenDevices = this.devices.filter(d => d !== this.deviceId && d !== this.client.getDeviceId());

      if (nonChosenDevices.length) {
        const message = this.completeContent(_VerificationRequest.CANCEL_TYPE, {
          code: "m.accepted",
          reason: "Verification request accepted by another device"
        });
        await this.sendToDevices(_VerificationRequest.CANCEL_TYPE, message, nonChosenDevices);
      }
    }
  }
  /**
   * See {InRoomChannel.completedContentFromEvent} why this is needed.
   * @param {MatrixEvent} event the received event
   * @returns {Object} the content object
   */


  completedContentFromEvent(event) {
    return event.getContent();
  }
  /**
   * Add all the fields to content needed for sending it over this channel.
   * This is public so verification methods (SAS uses this) can get the exact
   * content that will be sent independent of the used channel,
   * as they need to calculate the hash of it.
   * @param {string} type the event type
   * @param {object} content the (incomplete) content
   * @returns {object} the complete content, as it will be sent.
   */


  completeContent(type, content) {
    // make a copy
    content = Object.assign({}, content);

    if (this.transactionId) {
      content.transaction_id = this.transactionId;
    }

    if (type === _VerificationRequest.REQUEST_TYPE || type === _VerificationRequest.READY_TYPE || type === _VerificationRequest.START_TYPE) {
      content.from_device = this.client.getDeviceId();
    }

    if (type === _VerificationRequest.REQUEST_TYPE) {
      content.timestamp = Date.now();
    }

    return content;
  }
  /**
   * Send an event over the channel with the content not having gone through `completeContent`.
   * @param {string} type the event type
   * @param {object} uncompletedContent the (incomplete) content
   * @returns {Promise} the promise of the request
   */


  send(type, uncompletedContent = {}) {
    // create transaction id when sending request
    if ((type === _VerificationRequest.REQUEST_TYPE || type === _VerificationRequest.START_TYPE) && !this.transactionId) {
      this.transactionId = ToDeviceChannel.makeTransactionId();
    }

    const content = this.completeContent(type, uncompletedContent);
    return this.sendCompleted(type, content);
  }
  /**
   * Send an event over the channel with the content having gone through `completeContent` already.
   * @param {string} type the event type
   * @param {object} content
   * @returns {Promise} the promise of the request
   */


  async sendCompleted(type, content) {
    let result;

    if (type === _VerificationRequest.REQUEST_TYPE || type === _VerificationRequest.CANCEL_TYPE && !this.deviceId) {
      result = await this.sendToDevices(type, content, this.devices);
    } else {
      result = await this.sendToDevices(type, content, [this.deviceId]);
    } // the VerificationRequest state machine requires remote echos of the event
    // the client sends itself, so we fake this for to_device messages


    const remoteEchoEvent = new _event.MatrixEvent({
      sender: this.client.getUserId(),
      content,
      type
    });
    await this.request.handleEvent(type, remoteEchoEvent,
    /*isLiveEvent=*/
    true,
    /*isRemoteEcho=*/
    true,
    /*isSentByUs=*/
    true);
    return result;
  }

  async sendToDevices(type, content, devices) {
    if (devices.length) {
      const msgMap = {};

      for (const deviceId of devices) {
        msgMap[deviceId] = content;
      }

      await this.client.sendToDevice(type, {
        [this.userId]: msgMap
      });
    }
  }
  /**
   * Allow Crypto module to create and know the transaction id before the .start event gets sent.
   * @returns {string} the transaction id
   */


  static makeTransactionId() {
    return (0, _randomstring.randomString)(32);
  }

}

exports.ToDeviceChannel = ToDeviceChannel;

class ToDeviceRequests {
  constructor() {
    (0, _defineProperty2.default)(this, "requestsByUserId", new Map());
  }

  getRequest(event) {
    return this.getRequestBySenderAndTxnId(event.getSender(), ToDeviceChannel.getTransactionId(event));
  }

  getRequestByChannel(channel) {
    return this.getRequestBySenderAndTxnId(channel.userId, channel.transactionId);
  }

  getRequestBySenderAndTxnId(sender, txnId) {
    const requestsByTxnId = this.requestsByUserId.get(sender);

    if (requestsByTxnId) {
      return requestsByTxnId.get(txnId);
    }
  }

  setRequest(event, request) {
    this.setRequestBySenderAndTxnId(event.getSender(), ToDeviceChannel.getTransactionId(event), request);
  }

  setRequestByChannel(channel, request) {
    this.setRequestBySenderAndTxnId(channel.userId, channel.transactionId, request);
  }

  setRequestBySenderAndTxnId(sender, txnId, request) {
    let requestsByTxnId = this.requestsByUserId.get(sender);

    if (!requestsByTxnId) {
      requestsByTxnId = new Map();
      this.requestsByUserId.set(sender, requestsByTxnId);
    }

    requestsByTxnId.set(txnId, request);
  }

  removeRequest(event) {
    const userId = event.getSender();
    const requestsByTxnId = this.requestsByUserId.get(userId);

    if (requestsByTxnId) {
      requestsByTxnId.delete(ToDeviceChannel.getTransactionId(event));

      if (requestsByTxnId.size === 0) {
        this.requestsByUserId.delete(userId);
      }
    }
  }

  findRequestInProgress(userId, devices) {
    const requestsByTxnId = this.requestsByUserId.get(userId);

    if (requestsByTxnId) {
      for (const request of requestsByTxnId.values()) {
        if (request.pending && request.channel.isToDevices(devices)) {
          return request;
        }
      }
    }
  }

  getRequestsInProgress(userId) {
    const requestsByTxnId = this.requestsByUserId.get(userId);

    if (requestsByTxnId) {
      return Array.from(requestsByTxnId.values()).filter(r => r.pending);
    }

    return [];
  }

}

exports.ToDeviceRequests = ToDeviceRequests;