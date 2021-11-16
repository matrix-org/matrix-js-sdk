"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.SDPStreamMetadataPurpose = exports.SDPStreamMetadataKey = void 0;
// allow non-camelcase as these are events type that go onto the wire

/* eslint-disable camelcase */
// TODO: Change to "sdp_stream_metadata" when MSC3077 is merged
const SDPStreamMetadataKey = "org.matrix.msc3077.sdp_stream_metadata";
exports.SDPStreamMetadataKey = SDPStreamMetadataKey;
let SDPStreamMetadataPurpose;
exports.SDPStreamMetadataPurpose = SDPStreamMetadataPurpose;

(function (SDPStreamMetadataPurpose) {
  SDPStreamMetadataPurpose["Usermedia"] = "m.usermedia";
  SDPStreamMetadataPurpose["Screenshare"] = "m.screenshare";
})(SDPStreamMetadataPurpose || (exports.SDPStreamMetadataPurpose = SDPStreamMetadataPurpose = {}));
/* eslint-enable camelcase */