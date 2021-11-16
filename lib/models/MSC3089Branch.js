"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.MSC3089Branch = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _event = require("../@types/event");

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) { symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); } keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { (0, _defineProperty2.default)(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

/**
 * Represents a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089) branch - a reference
 * to a file (leaf) in the tree. Note that this is UNSTABLE and subject to breaking changes
 * without notice.
 */
class MSC3089Branch {
  constructor(client, indexEvent, directory) {// Nothing to do

    this.client = client;
    this.indexEvent = indexEvent;
    this.directory = directory;
  }
  /**
   * The file ID.
   */


  get id() {
    return this.indexEvent.getStateKey();
  }
  /**
   * Whether this branch is active/valid.
   */


  get isActive() {
    return this.indexEvent.getContent()["active"] === true;
  }
  /**
   * Version for the file, one-indexed.
   */


  get version() {
    var _this$indexEvent$getC;

    return (_this$indexEvent$getC = this.indexEvent.getContent()["version"]) !== null && _this$indexEvent$getC !== void 0 ? _this$indexEvent$getC : 1;
  }

  get roomId() {
    return this.indexEvent.getRoomId();
  }
  /**
   * Deletes the file from the tree, including all prior edits/versions.
   * @returns {Promise<void>} Resolves when complete.
   */


  async delete() {
    await this.client.sendStateEvent(this.roomId, _event.UNSTABLE_MSC3089_BRANCH.name, {}, this.id);
    await this.client.redactEvent(this.roomId, this.id);
    const nextVersion = (await this.getVersionHistory())[1]; // [0] will be us

    if (nextVersion) await nextVersion.delete(); // implicit recursion
  }
  /**
   * Gets the name for this file.
   * @returns {string} The name, or "Unnamed File" if unknown.
   */


  getName() {
    return this.indexEvent.getContent()['name'] || "Unnamed File";
  }
  /**
   * Sets the name for this file.
   * @param {string} name The new name for this file.
   * @returns {Promise<void>} Resolves when complete.
   */


  async setName(name) {
    await this.client.sendStateEvent(this.roomId, _event.UNSTABLE_MSC3089_BRANCH.name, _objectSpread(_objectSpread({}, this.indexEvent.getContent()), {}, {
      name: name
    }), this.id);
  }
  /**
   * Gets whether or not a file is locked.
   * @returns {boolean} True if locked, false otherwise.
   */


  isLocked() {
    return this.indexEvent.getContent()['locked'] || false;
  }
  /**
   * Sets a file as locked or unlocked.
   * @param {boolean} locked True to lock the file, false otherwise.
   * @returns {Promise<void>} Resolves when complete.
   */


  async setLocked(locked) {
    await this.client.sendStateEvent(this.roomId, _event.UNSTABLE_MSC3089_BRANCH.name, _objectSpread(_objectSpread({}, this.indexEvent.getContent()), {}, {
      locked: locked
    }), this.id);
  }
  /**
   * Gets information about the file needed to download it.
   * @returns {Promise<{info: IEncryptedFile, httpUrl: string}>} Information about the file.
   */


  async getFileInfo() {
    const event = await this.getFileEvent();
    const file = event.getOriginalContent()['file'];
    const httpUrl = this.client.mxcUrlToHttp(file['url']);
    return {
      info: file,
      httpUrl: httpUrl
    };
  }
  /**
   * Gets the event the file points to.
   * @returns {Promise<MatrixEvent>} Resolves to the file's event.
   */


  async getFileEvent() {
    const room = this.client.getRoom(this.roomId);
    if (!room) throw new Error("Unknown room");
    const event = room.getUnfilteredTimelineSet().findEventById(this.id);
    if (!event) throw new Error("Failed to find event"); // Sometimes the event isn't decrypted for us, so do that. We specifically set `emit: true`
    // to ensure that the relations system in the sdk will function.

    await this.client.decryptEventIfNeeded(event, {
      emit: true,
      isRetry: true
    });
    return event;
  }
  /**
   * Creates a new version of this file.
   * @param {string} name The name of the file.
   * @param {ArrayBuffer} encryptedContents The encrypted contents.
   * @param {Partial<IEncryptedFile>} info The encrypted file information.
   * @param {IContent} additionalContent Optional event content fields to include in the message.
   * @returns {Promise<void>} Resolves when uploaded.
   */


  async createNewVersion(name, encryptedContents, info, additionalContent) {
    const fileEventResponse = await this.directory.createFile(name, encryptedContents, info, _objectSpread(_objectSpread({}, additionalContent !== null && additionalContent !== void 0 ? additionalContent : {}), {}, {
      "m.new_content": true,
      "m.relates_to": {
        "rel_type": _event.RelationType.Replace,
        "event_id": this.id
      }
    })); // Update the version of the new event

    await this.client.sendStateEvent(this.roomId, _event.UNSTABLE_MSC3089_BRANCH.name, {
      active: true,
      name: name,
      version: this.version + 1
    }, fileEventResponse['event_id']); // Deprecate ourselves

    await this.client.sendStateEvent(this.roomId, _event.UNSTABLE_MSC3089_BRANCH.name, _objectSpread(_objectSpread({}, this.indexEvent.getContent()), {}, {
      active: false
    }), this.id);
  }
  /**
   * Gets the file's version history, starting at this file.
   * @returns {Promise<MSC3089Branch[]>} Resolves to the file's version history, with the
   * first element being the current version and the last element being the first version.
   */


  async getVersionHistory() {
    const fileHistory = [];
    fileHistory.push(this); // start with ourselves

    const room = this.client.getRoom(this.roomId);
    if (!room) throw new Error("Invalid or unknown room"); // Clone the timeline to reverse it, getting most-recent-first ordering, hopefully
    // shortening the awful loop below. Without the clone, we can unintentionally mutate
    // the timeline.

    const timelineEvents = [...room.getLiveTimeline().getEvents()].reverse(); // XXX: This is a very inefficient search, but it's the best we can do with the
    // relations structure we have in the SDK. As of writing, it is not worth the
    // investment in improving the structure.

    let childEvent;
    let parentEvent = await this.getFileEvent();

    do {
      childEvent = timelineEvents.find(e => e.replacingEventId() === parentEvent.getId());

      if (childEvent) {
        const branch = this.directory.getFile(childEvent.getId());

        if (branch) {
          fileHistory.push(branch);
          parentEvent = childEvent;
        } else {
          break; // prevent infinite loop
        }
      }
    } while (childEvent);

    return fileHistory;
  }

}

exports.MSC3089Branch = MSC3089Branch;