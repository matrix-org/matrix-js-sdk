"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.SPEAKING_THRESHOLD = exports.CallFeedEvent = exports.CallFeed = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _events = _interopRequireDefault(require("events"));

/*
Copyright 2021 Šimon Brandner <simon.bra.ag@gmail.com>

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
const POLLING_INTERVAL = 200; // ms

const SPEAKING_THRESHOLD = -60; // dB

exports.SPEAKING_THRESHOLD = SPEAKING_THRESHOLD;
const SPEAKING_SAMPLE_COUNT = 8; // samples

let CallFeedEvent;
exports.CallFeedEvent = CallFeedEvent;

(function (CallFeedEvent) {
  CallFeedEvent["NewStream"] = "new_stream";
  CallFeedEvent["MuteStateChanged"] = "mute_state_changed";
  CallFeedEvent["VolumeChanged"] = "volume_changed";
  CallFeedEvent["Speaking"] = "speaking";
})(CallFeedEvent || (exports.CallFeedEvent = CallFeedEvent = {}));

class CallFeed extends _events.default {
  constructor(opts) {
    super();
    (0, _defineProperty2.default)(this, "stream", void 0);
    (0, _defineProperty2.default)(this, "userId", void 0);
    (0, _defineProperty2.default)(this, "purpose", void 0);
    (0, _defineProperty2.default)(this, "speakingVolumeSamples", void 0);
    (0, _defineProperty2.default)(this, "client", void 0);
    (0, _defineProperty2.default)(this, "roomId", void 0);
    (0, _defineProperty2.default)(this, "audioMuted", void 0);
    (0, _defineProperty2.default)(this, "videoMuted", void 0);
    (0, _defineProperty2.default)(this, "measuringVolumeActivity", false);
    (0, _defineProperty2.default)(this, "audioContext", void 0);
    (0, _defineProperty2.default)(this, "analyser", void 0);
    (0, _defineProperty2.default)(this, "frequencyBinCount", void 0);
    (0, _defineProperty2.default)(this, "speakingThreshold", SPEAKING_THRESHOLD);
    (0, _defineProperty2.default)(this, "speaking", false);
    (0, _defineProperty2.default)(this, "volumeLooperTimeout", void 0);
    (0, _defineProperty2.default)(this, "onAddTrack", () => {
      this.emit(CallFeedEvent.NewStream, this.stream);
    });
    (0, _defineProperty2.default)(this, "volumeLooper", () => {
      if (!this.analyser) return;
      if (!this.measuringVolumeActivity) return;
      this.analyser.getFloatFrequencyData(this.frequencyBinCount);
      let maxVolume = -Infinity;

      for (let i = 0; i < this.frequencyBinCount.length; i++) {
        if (this.frequencyBinCount[i] > maxVolume) {
          maxVolume = this.frequencyBinCount[i];
        }
      }

      this.speakingVolumeSamples.shift();
      this.speakingVolumeSamples.push(maxVolume);
      this.emit(CallFeedEvent.VolumeChanged, maxVolume);
      let newSpeaking = false;

      for (let i = 0; i < this.speakingVolumeSamples.length; i++) {
        const volume = this.speakingVolumeSamples[i];

        if (volume > this.speakingThreshold) {
          newSpeaking = true;
          break;
        }
      }

      if (this.speaking !== newSpeaking) {
        this.speaking = newSpeaking;
        this.emit(CallFeedEvent.Speaking, this.speaking);
      }

      this.volumeLooperTimeout = setTimeout(this.volumeLooper, POLLING_INTERVAL);
    });
    this.client = opts.client;
    this.roomId = opts.roomId;
    this.userId = opts.userId;
    this.purpose = opts.purpose;
    this.audioMuted = opts.audioMuted;
    this.videoMuted = opts.videoMuted;
    this.speakingVolumeSamples = new Array(SPEAKING_SAMPLE_COUNT).fill(-Infinity);
    this.updateStream(null, opts.stream);

    if (this.hasAudioTrack) {
      this.initVolumeMeasuring();
    }
  }

  get hasAudioTrack() {
    return this.stream.getAudioTracks().length > 0;
  }

  updateStream(oldStream, newStream) {
    if (newStream === oldStream) return;

    if (oldStream) {
      oldStream.removeEventListener("addtrack", this.onAddTrack);
      this.measureVolumeActivity(false);
    }

    if (newStream) {
      this.stream = newStream;
      newStream.addEventListener("addtrack", this.onAddTrack);

      if (this.hasAudioTrack) {
        this.initVolumeMeasuring();
      } else {
        this.measureVolumeActivity(false);
      }
    }

    this.emit(CallFeedEvent.NewStream, this.stream);
  }

  initVolumeMeasuring() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!this.hasAudioTrack || !AudioContext) return;
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.1;
    const mediaStreamAudioSourceNode = this.audioContext.createMediaStreamSource(this.stream);
    mediaStreamAudioSourceNode.connect(this.analyser);
    this.frequencyBinCount = new Float32Array(this.analyser.frequencyBinCount);
  }

  /**
   * Returns callRoom member
   * @returns member of the callRoom
   */
  getMember() {
    const callRoom = this.client.getRoom(this.roomId);
    return callRoom.getMember(this.userId);
  }
  /**
   * Returns true if CallFeed is local, otherwise returns false
   * @returns {boolean} is local?
   */


  isLocal() {
    return this.userId === this.client.getUserId();
  }
  /**
   * Returns true if audio is muted or if there are no audio
   * tracks, otherwise returns false
   * @returns {boolean} is audio muted?
   */


  isAudioMuted() {
    return this.stream.getAudioTracks().length === 0 || this.audioMuted;
  }
  /**
   * Returns true video is muted or if there are no video
   * tracks, otherwise returns false
   * @returns {boolean} is video muted?
   */


  isVideoMuted() {
    // We assume only one video track
    return this.stream.getVideoTracks().length === 0 || this.videoMuted;
  }

  isSpeaking() {
    return this.speaking;
  }
  /**
   * Replaces the current MediaStream with a new one.
   * This method should be only used by MatrixCall.
   * @param newStream new stream with which to replace the current one
   */


  setNewStream(newStream) {
    this.updateStream(this.stream, newStream);
  }
  /**
   * Set feed's internal audio mute state
   * @param muted is the feed's audio muted?
   */


  setAudioMuted(muted) {
    this.audioMuted = muted;
    this.speakingVolumeSamples.fill(-Infinity);
    this.emit(CallFeedEvent.MuteStateChanged, this.audioMuted, this.videoMuted);
  }
  /**
   * Set feed's internal video mute state
   * @param muted is the feed's video muted?
   */


  setVideoMuted(muted) {
    this.videoMuted = muted;
    this.emit(CallFeedEvent.MuteStateChanged, this.audioMuted, this.videoMuted);
  }
  /**
   * Starts emitting volume_changed events where the emitter value is in decibels
   * @param enabled emit volume changes
   */


  measureVolumeActivity(enabled) {
    if (enabled) {
      if (!this.audioContext || !this.analyser || !this.frequencyBinCount || !this.hasAudioTrack) return;
      this.measuringVolumeActivity = true;
      this.volumeLooper();
    } else {
      this.measuringVolumeActivity = false;
      this.speakingVolumeSamples.fill(-Infinity);
      this.emit(CallFeedEvent.VolumeChanged, -Infinity);
    }
  }

  setSpeakingThreshold(threshold) {
    this.speakingThreshold = threshold;
  }

  dispose() {
    clearTimeout(this.volumeLooperTimeout);
  }

}

exports.CallFeed = CallFeed;