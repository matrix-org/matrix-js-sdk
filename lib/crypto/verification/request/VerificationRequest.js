"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.VerificationRequest = exports.START_TYPE = exports.REQUEST_TYPE = exports.READY_TYPE = exports.Phase = exports.PHASE_UNSENT = exports.PHASE_STARTED = exports.PHASE_REQUESTED = exports.PHASE_READY = exports.PHASE_DONE = exports.PHASE_CANCELLED = exports.EVENT_PREFIX = exports.DONE_TYPE = exports.CANCEL_TYPE = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _logger = require("../../../logger");

var _events = require("events");

var _Error = require("../Error");

var _QRCode = require("../QRCode");

/*
Copyright 2018 - 2021 The Matrix.org Foundation C.I.C.

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
// How long after the event's timestamp that the request times out
const TIMEOUT_FROM_EVENT_TS = 10 * 60 * 1000; // 10 minutes
// How long after we receive the event that the request times out

const TIMEOUT_FROM_EVENT_RECEIPT = 2 * 60 * 1000; // 2 minutes
// to avoid almost expired verification notifications
// from showing a notification and almost immediately
// disappearing, also ignore verification requests that
// are this amount of time away from expiring.

const VERIFICATION_REQUEST_MARGIN = 3 * 1000; // 3 seconds

const EVENT_PREFIX = "m.key.verification.";
exports.EVENT_PREFIX = EVENT_PREFIX;
const REQUEST_TYPE = EVENT_PREFIX + "request";
exports.REQUEST_TYPE = REQUEST_TYPE;
const START_TYPE = EVENT_PREFIX + "start";
exports.START_TYPE = START_TYPE;
const CANCEL_TYPE = EVENT_PREFIX + "cancel";
exports.CANCEL_TYPE = CANCEL_TYPE;
const DONE_TYPE = EVENT_PREFIX + "done";
exports.DONE_TYPE = DONE_TYPE;
const READY_TYPE = EVENT_PREFIX + "ready";
exports.READY_TYPE = READY_TYPE;
let Phase; // Legacy export fields

exports.Phase = Phase;

(function (Phase) {
  Phase[Phase["Unsent"] = 1] = "Unsent";
  Phase[Phase["Requested"] = 2] = "Requested";
  Phase[Phase["Ready"] = 3] = "Ready";
  Phase[Phase["Started"] = 4] = "Started";
  Phase[Phase["Cancelled"] = 5] = "Cancelled";
  Phase[Phase["Done"] = 6] = "Done";
})(Phase || (exports.Phase = Phase = {}));

const PHASE_UNSENT = Phase.Unsent;
exports.PHASE_UNSENT = PHASE_UNSENT;
const PHASE_REQUESTED = Phase.Requested;
exports.PHASE_REQUESTED = PHASE_REQUESTED;
const PHASE_READY = Phase.Ready;
exports.PHASE_READY = PHASE_READY;
const PHASE_STARTED = Phase.Started;
exports.PHASE_STARTED = PHASE_STARTED;
const PHASE_CANCELLED = Phase.Cancelled;
exports.PHASE_CANCELLED = PHASE_CANCELLED;
const PHASE_DONE = Phase.Done;
exports.PHASE_DONE = PHASE_DONE;

/**
 * State machine for verification requests.
 * Things that differ based on what channel is used to
 * send and receive verification events are put in `InRoomChannel` or `ToDeviceChannel`.
 * @event "change" whenever the state of the request object has changed.
 */
class VerificationRequest extends _events.EventEmitter {
  // we keep a copy of the QR Code data (including other user master key) around
  // for QR reciprocate verification, to protect against
  // cross-signing identity reset between the .ready and .start event
  // and signing the wrong key after .start
  // The timestamp when we received the request event from the other side
  constructor(channel, verificationMethods, client) {
    super();
    this.channel = channel;
    this.verificationMethods = verificationMethods;
    this.client = client;
    (0, _defineProperty2.default)(this, "eventsByUs", new Map());
    (0, _defineProperty2.default)(this, "eventsByThem", new Map());
    (0, _defineProperty2.default)(this, "_observeOnly", false);
    (0, _defineProperty2.default)(this, "timeoutTimer", null);
    (0, _defineProperty2.default)(this, "_accepting", false);
    (0, _defineProperty2.default)(this, "_declining", false);
    (0, _defineProperty2.default)(this, "verifierHasFinished", false);
    (0, _defineProperty2.default)(this, "_cancelled", false);
    (0, _defineProperty2.default)(this, "_chosenMethod", null);
    (0, _defineProperty2.default)(this, "_qrCodeData", null);
    (0, _defineProperty2.default)(this, "requestReceivedAt", null);
    (0, _defineProperty2.default)(this, "commonMethods", []);
    (0, _defineProperty2.default)(this, "_phase", void 0);
    (0, _defineProperty2.default)(this, "_cancellingUserId", void 0);
    (0, _defineProperty2.default)(this, "_verifier", void 0);
    (0, _defineProperty2.default)(this, "cancelOnTimeout", () => {
      try {
        if (this.initiatedByMe) {
          this.cancel({
            reason: "Other party didn't accept in time",
            code: "m.timeout"
          });
        } else {
          this.cancel({
            reason: "User didn't accept in time",
            code: "m.timeout"
          });
        }
      } catch (err) {
        _logger.logger.error("Error while cancelling verification request", err);
      }
    });
    this.channel.request = this;
    this.setPhase(PHASE_UNSENT, false);
  }
  /**
   * Stateless validation logic not specific to the channel.
   * Invoked by the same static method in either channel.
   * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
   * @param {MatrixEvent} event the event to validate. Don't call getType() on it but use the `type` parameter instead.
   * @param {MatrixClient} client the client to get the current user and device id from
   * @returns {boolean} whether the event is valid and should be passed to handleEvent
   */


  static validateEvent(type, event, client) {
    const content = event.getContent();

    if (!type || !type.startsWith(EVENT_PREFIX)) {
      return false;
    } // from here on we're fairly sure that this is supposed to be
    // part of a verification request, so be noisy when rejecting something


    if (!content) {
      _logger.logger.log("VerificationRequest: validateEvent: no content");

      return false;
    }

    if (type === REQUEST_TYPE || type === READY_TYPE) {
      if (!Array.isArray(content.methods)) {
        _logger.logger.log("VerificationRequest: validateEvent: " + "fail because methods");

        return false;
      }
    }

    if (type === REQUEST_TYPE || type === READY_TYPE || type === START_TYPE) {
      if (typeof content.from_device !== "string" || content.from_device.length === 0) {
        _logger.logger.log("VerificationRequest: validateEvent: " + "fail because from_device");

        return false;
      }
    }

    return true;
  }

  get invalid() {
    return this.phase === PHASE_UNSENT;
  }
  /** returns whether the phase is PHASE_REQUESTED */


  get requested() {
    return this.phase === PHASE_REQUESTED;
  }
  /** returns whether the phase is PHASE_CANCELLED */


  get cancelled() {
    return this.phase === PHASE_CANCELLED;
  }
  /** returns whether the phase is PHASE_READY */


  get ready() {
    return this.phase === PHASE_READY;
  }
  /** returns whether the phase is PHASE_STARTED */


  get started() {
    return this.phase === PHASE_STARTED;
  }
  /** returns whether the phase is PHASE_DONE */


  get done() {
    return this.phase === PHASE_DONE;
  }
  /** once the phase is PHASE_STARTED (and !initiatedByMe) or PHASE_READY: common methods supported by both sides */


  get methods() {
    return this.commonMethods;
  }
  /** the method picked in the .start event */


  get chosenMethod() {
    return this._chosenMethod;
  }

  calculateEventTimeout(event) {
    let effectiveExpiresAt = this.channel.getTimestamp(event) + TIMEOUT_FROM_EVENT_TS;

    if (this.requestReceivedAt && !this.initiatedByMe && this.phase <= PHASE_REQUESTED) {
      const expiresAtByReceipt = this.requestReceivedAt + TIMEOUT_FROM_EVENT_RECEIPT;
      effectiveExpiresAt = Math.min(effectiveExpiresAt, expiresAtByReceipt);
    }

    return Math.max(0, effectiveExpiresAt - Date.now());
  }
  /** The current remaining amount of ms before the request should be automatically cancelled */


  get timeout() {
    const requestEvent = this.getEventByEither(REQUEST_TYPE);

    if (requestEvent) {
      return this.calculateEventTimeout(requestEvent);
    }

    return 0;
  }
  /**
   * The key verification request event.
   * @returns {MatrixEvent} The request event, or falsey if not found.
   */


  get requestEvent() {
    return this.getEventByEither(REQUEST_TYPE);
  }
  /** current phase of the request. Some properties might only be defined in a current phase. */


  get phase() {
    return this._phase;
  }
  /** The verifier to do the actual verification, once the method has been established. Only defined when the `phase` is PHASE_STARTED. */


  get verifier() {
    return this._verifier;
  }

  get canAccept() {
    return this.phase < PHASE_READY && !this._accepting && !this._declining;
  }

  get accepting() {
    return this._accepting;
  }

  get declining() {
    return this._declining;
  }
  /** whether this request has sent it's initial event and needs more events to complete */


  get pending() {
    return !this.observeOnly && this._phase !== PHASE_DONE && this._phase !== PHASE_CANCELLED;
  }
  /** Only set after a .ready if the other party can scan a QR code */


  get qrCodeData() {
    return this._qrCodeData;
  }
  /** Checks whether the other party supports a given verification method.
   *  This is useful when setting up the QR code UI, as it is somewhat asymmetrical:
   *  if the other party supports SCAN_QR, we should show a QR code in the UI, and vice versa.
   *  For methods that need to be supported by both ends, use the `methods` property.
   *  @param {string} method the method to check
   *  @param {boolean} force to check even if the phase is not ready or started yet, internal usage
   *  @return {boolean} whether or not the other party said the supported the method */


  otherPartySupportsMethod(method, force = false) {
    if (!force && !this.ready && !this.started) {
      return false;
    }

    const theirMethodEvent = this.eventsByThem.get(REQUEST_TYPE) || this.eventsByThem.get(READY_TYPE);

    if (!theirMethodEvent) {
      // if we started straight away with .start event,
      // we are assuming that the other side will support the
      // chosen method, so return true for that.
      if (this.started && this.initiatedByMe) {
        const myStartEvent = this.eventsByUs.get(START_TYPE);
        const content = myStartEvent && myStartEvent.getContent();
        const myStartMethod = content && content.method;
        return method == myStartMethod;
      }

      return false;
    }

    const content = theirMethodEvent.getContent();

    if (!content) {
      return false;
    }

    const {
      methods
    } = content;

    if (!Array.isArray(methods)) {
      return false;
    }

    return methods.includes(method);
  }
  /** Whether this request was initiated by the syncing user.
   * For InRoomChannel, this is who sent the .request event.
   * For ToDeviceChannel, this is who sent the .start event
   */


  get initiatedByMe() {
    // event created by us but no remote echo has been received yet
    const noEventsYet = this.eventsByUs.size + this.eventsByThem.size === 0;

    if (this._phase === PHASE_UNSENT && noEventsYet) {
      return true;
    }

    const hasMyRequest = this.eventsByUs.has(REQUEST_TYPE);
    const hasTheirRequest = this.eventsByThem.has(REQUEST_TYPE);

    if (hasMyRequest && !hasTheirRequest) {
      return true;
    }

    if (!hasMyRequest && hasTheirRequest) {
      return false;
    }

    const hasMyStart = this.eventsByUs.has(START_TYPE);
    const hasTheirStart = this.eventsByThem.has(START_TYPE);

    if (hasMyStart && !hasTheirStart) {
      return true;
    }

    return false;
  }
  /** The id of the user that initiated the request */


  get requestingUserId() {
    if (this.initiatedByMe) {
      return this.client.getUserId();
    } else {
      return this.otherUserId;
    }
  }
  /** The id of the user that (will) receive(d) the request */


  get receivingUserId() {
    if (this.initiatedByMe) {
      return this.otherUserId;
    } else {
      return this.client.getUserId();
    }
  }
  /** The user id of the other party in this request */


  get otherUserId() {
    return this.channel.userId;
  }

  get isSelfVerification() {
    return this.client.getUserId() === this.otherUserId;
  }
  /**
   * The id of the user that cancelled the request,
   * only defined when phase is PHASE_CANCELLED
   */


  get cancellingUserId() {
    const myCancel = this.eventsByUs.get(CANCEL_TYPE);
    const theirCancel = this.eventsByThem.get(CANCEL_TYPE);

    if (myCancel && (!theirCancel || myCancel.getId() < theirCancel.getId())) {
      return myCancel.getSender();
    }

    if (theirCancel) {
      return theirCancel.getSender();
    }

    return undefined;
  }
  /**
   * The cancellation code e.g m.user which is responsible for cancelling this verification
   */


  get cancellationCode() {
    const ev = this.getEventByEither(CANCEL_TYPE);
    return ev ? ev.getContent().code : null;
  }

  get observeOnly() {
    return this._observeOnly;
  }
  /**
   * Gets which device the verification should be started with
   * given the events sent so far in the verification. This is the
   * same algorithm used to determine which device to send the
   * verification to when no specific device is specified.
   * @returns {{userId: *, deviceId: *}} The device information
   */


  get targetDevice() {
    const theirFirstEvent = this.eventsByThem.get(REQUEST_TYPE) || this.eventsByThem.get(READY_TYPE) || this.eventsByThem.get(START_TYPE);
    const theirFirstContent = theirFirstEvent.getContent();
    const fromDevice = theirFirstContent.from_device;
    return {
      userId: this.otherUserId,
      deviceId: fromDevice
    };
  }
  /* Start the key verification, creating a verifier and sending a .start event.
   * If no previous events have been sent, pass in `targetDevice` to set who to direct this request to.
   * @param {string} method the name of the verification method to use.
   * @param {string?} targetDevice.userId the id of the user to direct this request to
   * @param {string?} targetDevice.deviceId the id of the device to direct this request to
   * @returns {VerifierBase} the verifier of the given method
   */


  beginKeyVerification(method, targetDevice = null) {
    // need to allow also when unsent in case of to_device
    if (!this.observeOnly && !this._verifier) {
      const validStartPhase = this.phase === PHASE_REQUESTED || this.phase === PHASE_READY || this.phase === PHASE_UNSENT && this.channel.canCreateRequest(START_TYPE);

      if (validStartPhase) {
        // when called on a request that was initiated with .request event
        // check the method is supported by both sides
        if (this.commonMethods.length && !this.commonMethods.includes(method)) {
          throw (0, _Error.newUnknownMethodError)();
        }

        this._verifier = this.createVerifier(method, null, targetDevice);

        if (!this._verifier) {
          throw (0, _Error.newUnknownMethodError)();
        }

        this._chosenMethod = method;
      }
    }

    return this._verifier;
  }
  /**
   * sends the initial .request event.
   * @returns {Promise} resolves when the event has been sent.
   */


  async sendRequest() {
    if (!this.observeOnly && this._phase === PHASE_UNSENT) {
      const methods = [...this.verificationMethods.keys()];
      await this.channel.send(REQUEST_TYPE, {
        methods
      });
    }
  }
  /**
   * Cancels the request, sending a cancellation to the other party
   * @param {string?} error.reason the error reason to send the cancellation with
   * @param {string?} error.code the error code to send the cancellation with
   * @returns {Promise} resolves when the event has been sent.
   */


  async cancel({
    reason = "User declined",
    code = "m.user"
  } = {}) {
    if (!this.observeOnly && this._phase !== PHASE_CANCELLED) {
      this._declining = true;
      this.emit("change");

      if (this._verifier) {
        return this._verifier.cancel((0, _Error.errorFactory)(code, reason)());
      } else {
        this._cancellingUserId = this.client.getUserId();
        await this.channel.send(CANCEL_TYPE, {
          code,
          reason
        });
      }
    }
  }
  /**
   * Accepts the request, sending a .ready event to the other party
   * @returns {Promise} resolves when the event has been sent.
   */


  async accept() {
    if (!this.observeOnly && this.phase === PHASE_REQUESTED && !this.initiatedByMe) {
      const methods = [...this.verificationMethods.keys()];
      this._accepting = true;
      this.emit("change");
      await this.channel.send(READY_TYPE, {
        methods
      });
    }
  }
  /**
   * Can be used to listen for state changes until the callback returns true.
   * @param {Function} fn callback to evaluate whether the request is in the desired state.
   *                      Takes the request as an argument.
   * @returns {Promise} that resolves once the callback returns true
   * @throws {Error} when the request is cancelled
   */


  waitFor(fn) {
    return new Promise((resolve, reject) => {
      const check = () => {
        let handled = false;

        if (fn(this)) {
          resolve(this);
          handled = true;
        } else if (this.cancelled) {
          reject(new Error("cancelled"));
          handled = true;
        }

        if (handled) {
          this.off("change", check);
        }

        return handled;
      };

      if (!check()) {
        this.on("change", check);
      }
    });
  }

  setPhase(phase, notify = true) {
    this._phase = phase;

    if (notify) {
      this.emit("change");
    }
  }

  getEventByEither(type) {
    return this.eventsByThem.get(type) || this.eventsByUs.get(type);
  }

  getEventBy(type, byThem = false) {
    if (byThem) {
      return this.eventsByThem.get(type);
    } else {
      return this.eventsByUs.get(type);
    }
  }

  calculatePhaseTransitions() {
    const transitions = [{
      phase: PHASE_UNSENT
    }];

    const phase = () => transitions[transitions.length - 1].phase; // always pass by .request first to be sure channel.userId has been set


    const hasRequestByThem = this.eventsByThem.has(REQUEST_TYPE);
    const requestEvent = this.getEventBy(REQUEST_TYPE, hasRequestByThem);

    if (requestEvent) {
      transitions.push({
        phase: PHASE_REQUESTED,
        event: requestEvent
      });
    }

    const readyEvent = requestEvent && this.getEventBy(READY_TYPE, !hasRequestByThem);

    if (readyEvent && phase() === PHASE_REQUESTED) {
      transitions.push({
        phase: PHASE_READY,
        event: readyEvent
      });
    }

    let startEvent;

    if (readyEvent || !requestEvent) {
      const theirStartEvent = this.eventsByThem.get(START_TYPE);
      const ourStartEvent = this.eventsByUs.get(START_TYPE); // any party can send .start after a .ready or unsent

      if (theirStartEvent && ourStartEvent) {
        startEvent = theirStartEvent.getSender() < ourStartEvent.getSender() ? theirStartEvent : ourStartEvent;
      } else {
        startEvent = theirStartEvent ? theirStartEvent : ourStartEvent;
      }
    } else {
      startEvent = this.getEventBy(START_TYPE, !hasRequestByThem);
    }

    if (startEvent) {
      const fromRequestPhase = phase() === PHASE_REQUESTED && requestEvent.getSender() !== startEvent.getSender();
      const fromUnsentPhase = phase() === PHASE_UNSENT && this.channel.canCreateRequest(START_TYPE);

      if (fromRequestPhase || phase() === PHASE_READY || fromUnsentPhase) {
        transitions.push({
          phase: PHASE_STARTED,
          event: startEvent
        });
      }
    }

    const ourDoneEvent = this.eventsByUs.get(DONE_TYPE);

    if (this.verifierHasFinished || ourDoneEvent && phase() === PHASE_STARTED) {
      transitions.push({
        phase: PHASE_DONE
      });
    }

    const cancelEvent = this.getEventByEither(CANCEL_TYPE);

    if ((this._cancelled || cancelEvent) && phase() !== PHASE_DONE) {
      transitions.push({
        phase: PHASE_CANCELLED,
        event: cancelEvent
      });
      return transitions;
    }

    return transitions;
  }

  transitionToPhase(transition) {
    const {
      phase,
      event
    } = transition; // get common methods

    if (phase === PHASE_REQUESTED || phase === PHASE_READY) {
      if (!this.wasSentByOwnDevice(event)) {
        const content = event.getContent();
        this.commonMethods = content.methods.filter(m => this.verificationMethods.has(m));
      }
    } // detect if we're not a party in the request, and we should just observe


    if (!this.observeOnly) {
      // if requested or accepted by one of my other devices
      if (phase === PHASE_REQUESTED || phase === PHASE_STARTED || phase === PHASE_READY) {
        if (this.channel.receiveStartFromOtherDevices && this.wasSentByOwnUser(event) && !this.wasSentByOwnDevice(event)) {
          this._observeOnly = true;
        }
      }
    } // create verifier


    if (phase === PHASE_STARTED) {
      const {
        method
      } = event.getContent();

      if (!this._verifier && !this.observeOnly) {
        this._verifier = this.createVerifier(method, event);

        if (!this._verifier) {
          this.cancel({
            code: "m.unknown_method",
            reason: `Unknown method: ${method}`
          });
        } else {
          this._chosenMethod = method;
        }
      }
    }
  }

  applyPhaseTransitions() {
    const transitions = this.calculatePhaseTransitions();
    const existingIdx = transitions.findIndex(t => t.phase === this.phase); // trim off phases we already went through, if any

    const newTransitions = transitions.slice(existingIdx + 1); // transition to all new phases

    for (const transition of newTransitions) {
      this.transitionToPhase(transition);
    }

    return newTransitions;
  }

  isWinningStartRace(newEvent) {
    if (newEvent.getType() !== START_TYPE) {
      return false;
    }

    const oldEvent = this._verifier.startEvent;
    let oldRaceIdentifier;

    if (this.isSelfVerification) {
      // if the verifier does not have a startEvent,
      // it is because it's still sending and we are on the initator side
      // we know we are sending a .start event because we already
      // have a verifier (checked in calling method)
      if (oldEvent) {
        const oldContent = oldEvent.getContent();
        oldRaceIdentifier = oldContent && oldContent.from_device;
      } else {
        oldRaceIdentifier = this.client.getDeviceId();
      }
    } else {
      if (oldEvent) {
        oldRaceIdentifier = oldEvent.getSender();
      } else {
        oldRaceIdentifier = this.client.getUserId();
      }
    }

    let newRaceIdentifier;

    if (this.isSelfVerification) {
      const newContent = newEvent.getContent();
      newRaceIdentifier = newContent && newContent.from_device;
    } else {
      newRaceIdentifier = newEvent.getSender();
    }

    return newRaceIdentifier < oldRaceIdentifier;
  }

  hasEventId(eventId) {
    for (const event of this.eventsByUs.values()) {
      if (event.getId() === eventId) {
        return true;
      }
    }

    for (const event of this.eventsByThem.values()) {
      if (event.getId() === eventId) {
        return true;
      }
    }

    return false;
  }
  /**
   * Changes the state of the request and verifier in response to a key verification event.
   * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
   * @param {MatrixEvent} event the event to handle. Don't call getType() on it but use the `type` parameter instead.
   * @param {boolean} isLiveEvent whether this is an even received through sync or not
   * @param {boolean} isRemoteEcho whether this is the remote echo of an event sent by the same device
   * @param {boolean} isSentByUs whether this event is sent by a party that can accept and/or observe the request like one of our peers.
   *   For InRoomChannel this means any device for the syncing user. For ToDeviceChannel, just the syncing device.
   * @returns {Promise} a promise that resolves when any requests as an answer to the passed-in event are sent.
   */


  async handleEvent(type, event, isLiveEvent, isRemoteEcho, isSentByUs) {
    // if reached phase cancelled or done, ignore anything else that comes
    if (this.done || this.cancelled) {
      return;
    }

    const wasObserveOnly = this._observeOnly;
    this.adjustObserveOnly(event, isLiveEvent);

    if (!this.observeOnly && !isRemoteEcho) {
      if (await this.cancelOnError(type, event)) {
        return;
      }
    } // This assumes verification won't need to send an event with
    // the same type for the same party twice.
    // This is true for QR and SAS verification, and was
    // added here to prevent verification getting cancelled
    // when the server duplicates an event (https://github.com/matrix-org/synapse/issues/3365)


    const isDuplicateEvent = isSentByUs ? this.eventsByUs.has(type) : this.eventsByThem.has(type);

    if (isDuplicateEvent) {
      return;
    }

    const oldPhase = this.phase;
    this.addEvent(type, event, isSentByUs); // this will create if needed the verifier so needs to happen before calling it

    const newTransitions = this.applyPhaseTransitions();

    try {
      // only pass events from the other side to the verifier,
      // no remote echos of our own events
      if (this._verifier && !this.observeOnly) {
        const newEventWinsRace = this.isWinningStartRace(event);

        if (this._verifier.canSwitchStartEvent(event) && newEventWinsRace) {
          this._verifier.switchStartEvent(event);
        } else if (!isRemoteEcho) {
          var _this$_verifier$event;

          if (type === CANCEL_TYPE || (_this$_verifier$event = this._verifier.events) !== null && _this$_verifier$event !== void 0 && _this$_verifier$event.includes(type)) {
            this._verifier.handleEvent(event);
          }
        }
      }

      if (newTransitions.length) {
        // create QRCodeData if the other side can scan
        // important this happens before emitting a phase change,
        // so listeners can rely on it being there already
        // We only do this for live events because it is important that
        // we sign the keys that were in the QR code, and not the keys
        // we happen to have at some later point in time.
        if (isLiveEvent && newTransitions.some(t => t.phase === PHASE_READY)) {
          const shouldGenerateQrCode = this.otherPartySupportsMethod(_QRCode.SCAN_QR_CODE_METHOD, true);

          if (shouldGenerateQrCode) {
            this._qrCodeData = await _QRCode.QRCodeData.create(this, this.client);
          }
        }

        const lastTransition = newTransitions[newTransitions.length - 1];
        const {
          phase
        } = lastTransition;
        this.setupTimeout(phase); // set phase as last thing as this emits the "change" event

        this.setPhase(phase);
      } else if (this._observeOnly !== wasObserveOnly) {
        this.emit("change");
      }
    } finally {
      // log events we processed so we can see from rageshakes what events were added to a request
      _logger.logger.log(`Verification request ${this.channel.transactionId}: ` + `${type} event with id:${event.getId()}, ` + `content:${JSON.stringify(event.getContent())} ` + `deviceId:${this.channel.deviceId}, ` + `sender:${event.getSender()}, isSentByUs:${isSentByUs}, ` + `isLiveEvent:${isLiveEvent}, isRemoteEcho:${isRemoteEcho}, ` + `phase:${oldPhase}=>${this.phase}, ` + `observeOnly:${wasObserveOnly}=>${this._observeOnly}`);
    }
  }

  setupTimeout(phase) {
    const shouldTimeout = !this.timeoutTimer && !this.observeOnly && phase === PHASE_REQUESTED;

    if (shouldTimeout) {
      this.timeoutTimer = setTimeout(this.cancelOnTimeout, this.timeout);
    }

    if (this.timeoutTimer) {
      const shouldClear = phase === PHASE_STARTED || phase === PHASE_READY || phase === PHASE_DONE || phase === PHASE_CANCELLED;

      if (shouldClear) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }
    }
  }

  async cancelOnError(type, event) {
    if (type === START_TYPE) {
      const method = event.getContent().method;

      if (!this.verificationMethods.has(method)) {
        await this.cancel((0, _Error.errorFromEvent)((0, _Error.newUnknownMethodError)()));
        return true;
      }
    }

    const isUnexpectedRequest = type === REQUEST_TYPE && this.phase !== PHASE_UNSENT;
    const isUnexpectedReady = type === READY_TYPE && this.phase !== PHASE_REQUESTED; // only if phase has passed from PHASE_UNSENT should we cancel, because events
    // are allowed to come in in any order (at least with InRoomChannel). So we only know
    // we're dealing with a valid request we should participate in once we've moved to PHASE_REQUESTED
    // before that, we could be looking at somebody elses verification request and we just
    // happen to be in the room

    if (this.phase !== PHASE_UNSENT && (isUnexpectedRequest || isUnexpectedReady)) {
      _logger.logger.warn(`Cancelling, unexpected ${type} verification ` + `event from ${event.getSender()}`);

      const reason = `Unexpected ${type} event in phase ${this.phase}`;
      await this.cancel((0, _Error.errorFromEvent)((0, _Error.newUnexpectedMessageError)({
        reason
      })));
      return true;
    }

    return false;
  }

  adjustObserveOnly(event, isLiveEvent = false) {
    // don't send out events for historical requests
    if (!isLiveEvent) {
      this._observeOnly = true;
    }

    if (this.calculateEventTimeout(event) < VERIFICATION_REQUEST_MARGIN) {
      this._observeOnly = true;
    }
  }

  addEvent(type, event, isSentByUs = false) {
    if (isSentByUs) {
      this.eventsByUs.set(type, event);
    } else {
      this.eventsByThem.set(type, event);
    } // once we know the userId of the other party (from the .request event)
    // see if any event by anyone else crept into this.eventsByThem


    if (type === REQUEST_TYPE) {
      for (const [type, event] of this.eventsByThem.entries()) {
        if (event.getSender() !== this.otherUserId) {
          this.eventsByThem.delete(type);
        }
      } // also remember when we received the request event


      this.requestReceivedAt = Date.now();
    }
  }

  createVerifier(method, startEvent = null, targetDevice = null) {
    if (!targetDevice) {
      targetDevice = this.targetDevice;
    }

    const {
      userId,
      deviceId
    } = targetDevice;
    const VerifierCtor = this.verificationMethods.get(method);

    if (!VerifierCtor) {
      _logger.logger.warn("could not find verifier constructor for method", method);

      return;
    }

    return new VerifierCtor(this.channel, this.client, userId, deviceId, startEvent, this);
  }

  wasSentByOwnUser(event) {
    return event.getSender() === this.client.getUserId();
  } // only for .request, .ready or .start


  wasSentByOwnDevice(event) {
    if (!this.wasSentByOwnUser(event)) {
      return false;
    }

    const content = event.getContent();

    if (!content || content.from_device !== this.client.getDeviceId()) {
      return false;
    }

    return true;
  }

  onVerifierCancelled() {
    this._cancelled = true; // move to cancelled phase

    const newTransitions = this.applyPhaseTransitions();

    if (newTransitions.length) {
      this.setPhase(newTransitions[newTransitions.length - 1].phase);
    }
  }

  onVerifierFinished() {
    this.channel.send("m.key.verification.done", {});
    this.verifierHasFinished = true; // move to .done phase

    const newTransitions = this.applyPhaseTransitions();

    if (newTransitions.length) {
      this.setPhase(newTransitions[newTransitions.length - 1].phase);
    }
  }

  getEventFromOtherParty(type) {
    return this.eventsByThem.get(type);
  }

}

exports.VerificationRequest = VerificationRequest;