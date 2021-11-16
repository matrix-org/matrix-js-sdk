"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CallEventHandler = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _logger = require("../logger");

var _call = require("./call");

var _event = require("../@types/event");

/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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
// Don't ring unless we'd be ringing for at least 3 seconds: the user needs some
// time to press the 'accept' button
const RING_GRACE_PERIOD = 3000;

class CallEventHandler {
  constructor(client) {
    (0, _defineProperty2.default)(this, "client", void 0);
    (0, _defineProperty2.default)(this, "calls", void 0);
    (0, _defineProperty2.default)(this, "callEventBuffer", void 0);
    (0, _defineProperty2.default)(this, "candidateEventsByCall", void 0);
    (0, _defineProperty2.default)(this, "evaluateEventBuffer", async () => {
      if (this.client.getSyncState() === "SYNCING") {
        await Promise.all(this.callEventBuffer.map(event => {
          this.client.decryptEventIfNeeded(event);
        }));
        const ignoreCallIds = new Set(); // inspect the buffer and mark all calls which have been answered
        // or hung up before passing them to the call event handler.

        for (const ev of this.callEventBuffer) {
          if (ev.getType() === _event.EventType.CallAnswer || ev.getType() === _event.EventType.CallHangup) {
            ignoreCallIds.add(ev.getContent().call_id);
          }
        } // now loop through the buffer chronologically and inject them


        for (const e of this.callEventBuffer) {
          if (e.getType() === _event.EventType.CallInvite && ignoreCallIds.has(e.getContent().call_id)) {
            // This call has previously been answered or hung up: ignore it
            continue;
          }

          try {
            await this.handleCallEvent(e);
          } catch (e) {
            _logger.logger.error("Caught exception handling call event", e);
          }
        }

        this.callEventBuffer = [];
      }
    });
    (0, _defineProperty2.default)(this, "onRoomTimeline", event => {
      this.client.decryptEventIfNeeded(event); // any call events or ones that might be once they're decrypted

      if (this.eventIsACall(event) || event.isBeingDecrypted()) {
        // queue up for processing once all events from this sync have been
        // processed (see above).
        this.callEventBuffer.push(event);
      }

      if (event.isBeingDecrypted() || event.isDecryptionFailure()) {
        // add an event listener for once the event is decrypted.
        event.once("Event.decrypted", async () => {
          if (!this.eventIsACall(event)) return;

          if (this.callEventBuffer.includes(event)) {
            // we were waiting for that event to decrypt, so recheck the buffer
            this.evaluateEventBuffer();
          } else {
            // This one wasn't buffered so just run the event handler for it
            // straight away
            try {
              await this.handleCallEvent(event);
            } catch (e) {
              _logger.logger.error("Caught exception handling call event", e);
            }
          }
        });
      }
    });
    this.client = client;
    this.calls = new Map(); // The sync code always emits one event at a time, so it will patiently
    // wait for us to finish processing a call invite before delivering the
    // next event, even if that next event is a hangup. We therefore accumulate
    // all our call events and then process them on the 'sync' event, ie.
    // each time a sync has completed. This way, we can avoid emitting incoming
    // call events if we get both the invite and answer/hangup in the same sync.
    // This happens quite often, eg. replaying sync from storage, catchup sync
    // after loading and after we've been offline for a bit.

    this.callEventBuffer = [];
    this.candidateEventsByCall = new Map();
  }

  start() {
    this.client.on("sync", this.evaluateEventBuffer);
    this.client.on("Room.timeline", this.onRoomTimeline);
  }

  stop() {
    this.client.removeListener("sync", this.evaluateEventBuffer);
    this.client.removeListener("Room.timeline", this.onRoomTimeline);
  }

  eventIsACall(event) {
    const type = event.getType();
    /**
     * Unstable prefixes:
     *   - org.matrix.call. : MSC3086 https://github.com/matrix-org/matrix-doc/pull/3086
     */

    return type.startsWith("m.call.") || type.startsWith("org.matrix.call.");
  }

  async handleCallEvent(event) {
    const content = event.getContent();
    const type = event.getType();
    const weSentTheEvent = event.getSender() === this.client.credentials.userId;
    let call = content.call_id ? this.calls.get(content.call_id) : undefined; //console.info("RECV %s content=%s", type, JSON.stringify(content));

    if (type === _event.EventType.CallInvite) {
      // ignore invites you send
      if (weSentTheEvent) return; // expired call

      if (event.getLocalAge() > content.lifetime - RING_GRACE_PERIOD) return; // stale/old invite event

      if (call && call.state === _call.CallState.Ended) return;

      if (call) {
        _logger.logger.log(`WARN: Already have a MatrixCall with id ${content.call_id} but got an ` + `invite. Clobbering.`);
      }

      const timeUntilTurnCresExpire = this.client.getTurnServersExpiry() - Date.now();

      _logger.logger.info("Current turn creds expire in " + timeUntilTurnCresExpire + " ms");

      call = (0, _call.createNewMatrixCall)(this.client, event.getRoomId(), {
        forceTURN: this.client.forceTURN
      });

      if (!call) {
        _logger.logger.log("Incoming call ID " + content.call_id + " but this client " + "doesn't support WebRTC"); // don't hang up the call: there could be other clients
        // connected that do support WebRTC and declining the
        // the call on their behalf would be really annoying.


        return;
      }

      call.callId = content.call_id;
      await call.initWithInvite(event);
      this.calls.set(call.callId, call); // if we stashed candidate events for that call ID, play them back now

      if (this.candidateEventsByCall.get(call.callId)) {
        for (const ev of this.candidateEventsByCall.get(call.callId)) {
          call.onRemoteIceCandidatesReceived(ev);
        }
      } // Were we trying to call that user (room)?


      let existingCall;

      for (const thisCall of this.calls.values()) {
        const isCalling = [_call.CallState.WaitLocalMedia, _call.CallState.CreateOffer, _call.CallState.InviteSent].includes(thisCall.state);

        if (call.roomId === thisCall.roomId && thisCall.direction === _call.CallDirection.Outbound && isCalling) {
          existingCall = thisCall;
          break;
        }
      }

      if (existingCall) {
        // If we've only got to wait_local_media or create_offer and
        // we've got an invite, pick the incoming call because we know
        // we haven't sent our invite yet otherwise, pick whichever
        // call has the lowest call ID (by string comparison)
        if (existingCall.state === _call.CallState.WaitLocalMedia || existingCall.state === _call.CallState.CreateOffer || existingCall.callId > call.callId) {
          _logger.logger.log("Glare detected: answering incoming call " + call.callId + " and canceling outgoing call " + existingCall.callId);

          existingCall.replacedBy(call);
          call.answer();
        } else {
          _logger.logger.log("Glare detected: rejecting incoming call " + call.callId + " and keeping outgoing call " + existingCall.callId);

          call.hangup(_call.CallErrorCode.Replaced, true);
        }
      } else {
        this.client.emit("Call.incoming", call);
      }

      return;
    } else if (type === _event.EventType.CallCandidates) {
      if (weSentTheEvent) return;

      if (!call) {
        // store the candidates; we may get a call eventually.
        if (!this.candidateEventsByCall.has(content.call_id)) {
          this.candidateEventsByCall.set(content.call_id, []);
        }

        this.candidateEventsByCall.get(content.call_id).push(event);
      } else {
        call.onRemoteIceCandidatesReceived(event);
      }

      return;
    } else if ([_event.EventType.CallHangup, _event.EventType.CallReject].includes(type)) {
      // Note that we also observe our own hangups here so we can see
      // if we've already rejected a call that would otherwise be valid
      if (!call) {
        // if not live, store the fact that the call has ended because
        // we're probably getting events backwards so
        // the hangup will come before the invite
        call = (0, _call.createNewMatrixCall)(this.client, event.getRoomId());

        if (call) {
          call.callId = content.call_id;
          call.initWithHangup(event);
          this.calls.set(content.call_id, call);
        }
      } else {
        if (call.state !== _call.CallState.Ended) {
          if (type === _event.EventType.CallHangup) {
            call.onHangupReceived(content);
          } else {
            call.onRejectReceived(content);
          }

          this.calls.delete(content.call_id);
        }
      }

      return;
    } // The following events need a call and a peer connection


    if (!call || !call.hasPeerConnection) {
      _logger.logger.warn("Discarding an event, we don't have a call/peerConn", type);

      return;
    } // Ignore remote echo


    if (event.getContent().party_id === call.ourPartyId) return;

    switch (type) {
      case _event.EventType.CallAnswer:
        if (weSentTheEvent) {
          if (call.state === _call.CallState.Ringing) {
            call.onAnsweredElsewhere(content);
          }
        } else {
          call.onAnswerReceived(event);
        }

        break;

      case _event.EventType.CallSelectAnswer:
        call.onSelectAnswerReceived(event);
        break;

      case _event.EventType.CallNegotiate:
        call.onNegotiateReceived(event);
        break;

      case _event.EventType.CallAssertedIdentity:
      case _event.EventType.CallAssertedIdentityPrefix:
        call.onAssertedIdentityReceived(event);
        break;

      case _event.EventType.CallSDPStreamMetadataChanged:
      case _event.EventType.CallSDPStreamMetadataChangedPrefix:
        call.onSDPStreamMetadataChangedReceived(event);
        break;
    }
  }

}

exports.CallEventHandler = CallEventHandler;