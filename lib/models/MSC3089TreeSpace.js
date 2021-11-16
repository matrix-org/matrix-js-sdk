"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.TreePermissions = exports.MSC3089TreeSpace = exports.DEFAULT_TREE_POWER_LEVELS_TEMPLATE = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _event = require("../@types/event");

var _logger = require("../logger");

var _utils = require("../utils");

var _MSC3089Branch = require("./MSC3089Branch");

var _pRetry = _interopRequireDefault(require("p-retry"));

var _megolm = require("../crypto/algorithms/megolm");

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) { symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); } keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { (0, _defineProperty2.default)(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

/**
 * The recommended defaults for a tree space's power levels. Note that this
 * is UNSTABLE and subject to breaking changes without notice.
 */
const DEFAULT_TREE_POWER_LEVELS_TEMPLATE = {
  // Owner
  invite: 100,
  kick: 100,
  ban: 100,
  // Editor
  redact: 50,
  state_default: 50,
  events_default: 50,
  // Viewer
  users_default: 0,
  // Mixed
  events: {
    [_event.EventType.RoomPowerLevels]: 100,
    [_event.EventType.RoomHistoryVisibility]: 100,
    [_event.EventType.RoomTombstone]: 100,
    [_event.EventType.RoomEncryption]: 100,
    [_event.EventType.RoomName]: 50,
    [_event.EventType.RoomMessage]: 50,
    [_event.EventType.RoomMessageEncrypted]: 50,
    [_event.EventType.Sticker]: 50
  },
  users: {} // defined by calling code

};
/**
 * Ease-of-use representation for power levels represented as simple roles.
 * Note that this is UNSTABLE and subject to breaking changes without notice.
 */

exports.DEFAULT_TREE_POWER_LEVELS_TEMPLATE = DEFAULT_TREE_POWER_LEVELS_TEMPLATE;
let TreePermissions;
/**
 * Represents a [MSC3089](https://github.com/matrix-org/matrix-doc/pull/3089)
 * file tree Space. Note that this is UNSTABLE and subject to breaking changes
 * without notice.
 */

exports.TreePermissions = TreePermissions;

(function (TreePermissions) {
  TreePermissions["Viewer"] = "viewer";
  TreePermissions["Editor"] = "editor";
  TreePermissions["Owner"] = "owner";
})(TreePermissions || (exports.TreePermissions = TreePermissions = {}));

class MSC3089TreeSpace {
  constructor(client, roomId) {
    this.client = client;
    this.roomId = roomId;
    (0, _defineProperty2.default)(this, "room", void 0);
    this.room = this.client.getRoom(this.roomId);
    if (!this.room) throw new Error("Unknown room");
  }
  /**
   * Syntactic sugar for room ID of the Space.
   */


  get id() {
    return this.roomId;
  }
  /**
   * Whether or not this is a top level space.
   */


  get isTopLevel() {
    // XXX: This is absolutely not how you find out if the space is top level
    // but is safe for a managed usecase like we offer in the SDK.
    const parentEvents = this.room.currentState.getStateEvents(_event.EventType.SpaceParent);
    if (!(parentEvents !== null && parentEvents !== void 0 && parentEvents.length)) return true;
    return parentEvents.every(e => {
      var _e$getContent;

      return !((_e$getContent = e.getContent()) !== null && _e$getContent !== void 0 && _e$getContent['via']);
    });
  }
  /**
   * Sets the name of the tree space.
   * @param {string} name The new name for the space.
   * @returns {Promise<void>} Resolves when complete.
   */


  async setName(name) {
    await this.client.sendStateEvent(this.roomId, _event.EventType.RoomName, {
      name
    }, "");
  }
  /**
   * Invites a user to the tree space. They will be given the default Viewer
   * permission level unless specified elsewhere.
   * @param {string} userId The user ID to invite.
   * @param {boolean} andSubspaces True (default) to invite the user to all
   * directories/subspaces too, recursively.
   * @param {boolean} shareHistoryKeys True (default) to share encryption keys
   * with the invited user. This will allow them to decrypt the events (files)
   * in the tree. Keys will not be shared if the room is lacking appropriate
   * history visibility (by default, history visibility is "shared" in trees,
   * which is an appropriate visibility for these purposes).
   * @returns {Promise<void>} Resolves when complete.
   */


  async invite(userId, andSubspaces = true, shareHistoryKeys = true) {
    const promises = [this.retryInvite(userId)];

    if (andSubspaces) {
      promises.push(...this.getDirectories().map(d => d.invite(userId, andSubspaces, shareHistoryKeys)));
    }

    return Promise.all(promises).then(() => {
      // Note: key sharing is default on because for file trees it is relatively important that the invite
      // target can actually decrypt the files. The implied use case is that by inviting a user to the tree
      // it means the sender would like the receiver to view/download the files contained within, much like
      // sharing a folder in other circles.
      if (shareHistoryKeys && (0, _megolm.isRoomSharedHistory)(this.room)) {
        // noinspection JSIgnoredPromiseFromCall - we aren't concerned as much if this fails.
        this.client.sendSharedHistoryKeys(this.roomId, [userId]);
      }
    });
  }

  retryInvite(userId) {
    return (0, _utils.simpleRetryOperation)(async () => {
      await this.client.invite(this.roomId, userId).catch(e => {
        // We don't want to retry permission errors forever...
        if ((e === null || e === void 0 ? void 0 : e.errcode) === "M_FORBIDDEN") {
          throw new _pRetry.default.AbortError(e);
        }

        throw e;
      });
    });
  }
  /**
   * Sets the permissions of a user to the given role. Note that if setting a user
   * to Owner then they will NOT be able to be demoted. If the user does not have
   * permission to change the power level of the target, an error will be thrown.
   * @param {string} userId The user ID to change the role of.
   * @param {TreePermissions} role The role to assign.
   * @returns {Promise<void>} Resolves when complete.
   */


  async setPermissions(userId, role) {
    var _pls$events;

    const currentPls = this.room.currentState.getStateEvents(_event.EventType.RoomPowerLevels, "");
    if (Array.isArray(currentPls)) throw new Error("Unexpected return type for power levels");
    const pls = currentPls.getContent() || {};
    const viewLevel = pls['users_default'] || 0;
    const editLevel = pls['events_default'] || 50;
    const adminLevel = ((_pls$events = pls['events']) === null || _pls$events === void 0 ? void 0 : _pls$events[_event.EventType.RoomPowerLevels]) || 100;
    const users = pls['users'] || {};

    switch (role) {
      case TreePermissions.Viewer:
        users[userId] = viewLevel;
        break;

      case TreePermissions.Editor:
        users[userId] = editLevel;
        break;

      case TreePermissions.Owner:
        users[userId] = adminLevel;
        break;

      default:
        throw new Error("Invalid role: " + role);
    }

    pls['users'] = users;
    await this.client.sendStateEvent(this.roomId, _event.EventType.RoomPowerLevels, pls, "");
  }
  /**
   * Gets the current permissions of a user. Note that any users missing explicit permissions (or not
   * in the space) will be considered Viewers. Appropriate membership checks need to be performed
   * elsewhere.
   * @param {string} userId The user ID to check permissions of.
   * @returns {TreePermissions} The permissions for the user, defaulting to Viewer.
   */


  getPermissions(userId) {
    var _pls$events2, _pls$users;

    const currentPls = this.room.currentState.getStateEvents(_event.EventType.RoomPowerLevels, "");
    if (Array.isArray(currentPls)) throw new Error("Unexpected return type for power levels");
    const pls = currentPls.getContent() || {};
    const viewLevel = pls['users_default'] || 0;
    const editLevel = pls['events_default'] || 50;
    const adminLevel = ((_pls$events2 = pls['events']) === null || _pls$events2 === void 0 ? void 0 : _pls$events2[_event.EventType.RoomPowerLevels]) || 100;
    const userLevel = ((_pls$users = pls['users']) === null || _pls$users === void 0 ? void 0 : _pls$users[userId]) || viewLevel;
    if (userLevel >= adminLevel) return TreePermissions.Owner;
    if (userLevel >= editLevel) return TreePermissions.Editor;
    return TreePermissions.Viewer;
  }
  /**
   * Creates a directory under this tree space, represented as another tree space.
   * @param {string} name The name for the directory.
   * @returns {Promise<MSC3089TreeSpace>} Resolves to the created directory.
   */


  async createDirectory(name) {
    const directory = await this.client.unstableCreateFileTree(name);
    await this.client.sendStateEvent(this.roomId, _event.EventType.SpaceChild, {
      via: [this.client.getDomain()]
    }, directory.roomId);
    await this.client.sendStateEvent(directory.roomId, _event.EventType.SpaceParent, {
      via: [this.client.getDomain()]
    }, this.roomId);
    return directory;
  }
  /**
   * Gets a list of all known immediate subdirectories to this tree space.
   * @returns {MSC3089TreeSpace[]} The tree spaces (directories). May be empty, but not null.
   */


  getDirectories() {
    const trees = [];
    const children = this.room.currentState.getStateEvents(_event.EventType.SpaceChild);

    for (const child of children) {
      try {
        const tree = this.client.unstableGetFileTreeSpace(child.getStateKey());
        if (tree) trees.push(tree);
      } catch (e) {
        _logger.logger.warn("Unable to create tree space instance for listing. Are we joined?", e);
      }
    }

    return trees;
  }
  /**
   * Gets a subdirectory of a given ID under this tree space. Note that this will not recurse
   * into children and instead only look one level deep.
   * @param {string} roomId The room ID (directory ID) to find.
   * @returns {MSC3089TreeSpace} The directory, or falsy if not found.
   */


  getDirectory(roomId) {
    return this.getDirectories().find(r => r.roomId === roomId);
  }
  /**
   * Deletes the tree, kicking all members and deleting **all subdirectories**.
   * @returns {Promise<void>} Resolves when complete.
   */


  async delete() {
    const subdirectories = this.getDirectories();

    for (const dir of subdirectories) {
      await dir.delete();
    }

    const kickMemberships = ["invite", "knock", "join"];
    const members = this.room.currentState.getStateEvents(_event.EventType.RoomMember);

    for (const member of members) {
      const isNotUs = member.getStateKey() !== this.client.getUserId();

      if (isNotUs && kickMemberships.includes(member.getContent()['membership'])) {
        await this.client.kick(this.roomId, member.getStateKey(), "Room deleted");
      }
    }

    await this.client.leave(this.roomId);
  }

  getOrderedChildren(children) {
    const ordered = children.map(c => ({
      roomId: c.getStateKey(),
      order: c.getContent()['order']
    }));
    ordered.sort((a, b) => {
      if (a.order && !b.order) {
        return -1;
      } else if (!a.order && b.order) {
        return 1;
      } else if (!a.order && !b.order) {
        var _roomA$currentState$g, _roomA$currentState$g2, _roomB$currentState$g, _roomB$currentState$g2;

        const roomA = this.client.getRoom(a.roomId);
        const roomB = this.client.getRoom(b.roomId);

        if (!roomA || !roomB) {
          // just don't bother trying to do more partial sorting
          return (0, _utils.lexicographicCompare)(a.roomId, b.roomId);
        }

        const createTsA = (_roomA$currentState$g = (_roomA$currentState$g2 = roomA.currentState.getStateEvents(_event.EventType.RoomCreate, "")) === null || _roomA$currentState$g2 === void 0 ? void 0 : _roomA$currentState$g2.getTs()) !== null && _roomA$currentState$g !== void 0 ? _roomA$currentState$g : 0;
        const createTsB = (_roomB$currentState$g = (_roomB$currentState$g2 = roomB.currentState.getStateEvents(_event.EventType.RoomCreate, "")) === null || _roomB$currentState$g2 === void 0 ? void 0 : _roomB$currentState$g2.getTs()) !== null && _roomB$currentState$g !== void 0 ? _roomB$currentState$g : 0;

        if (createTsA === createTsB) {
          return (0, _utils.lexicographicCompare)(a.roomId, b.roomId);
        }

        return createTsA - createTsB;
      } else {
        // both not-null orders
        return (0, _utils.lexicographicCompare)(a.order, b.order);
      }
    });
    return ordered;
  }

  getParentRoom() {
    const parents = this.room.currentState.getStateEvents(_event.EventType.SpaceParent);
    const parent = parents[0]; // XXX: Wild assumption

    if (!parent) throw new Error("Expected to have a parent in a non-top level space"); // XXX: We are assuming the parent is a valid tree space.
    // We probably don't need to validate the parent room state for this usecase though.

    const parentRoom = this.client.getRoom(parent.getStateKey());
    if (!parentRoom) throw new Error("Unable to locate room for parent");
    return parentRoom;
  }
  /**
   * Gets the current order index for this directory. Note that if this is the top level space
   * then -1 will be returned.
   * @returns {number} The order index of this space.
   */


  getOrder() {
    if (this.isTopLevel) return -1;
    const parentRoom = this.getParentRoom();
    const children = parentRoom.currentState.getStateEvents(_event.EventType.SpaceChild);
    const ordered = this.getOrderedChildren(children);
    return ordered.findIndex(c => c.roomId === this.roomId);
  }
  /**
   * Sets the order index for this directory within its parent. Note that if this is a top level
   * space then an error will be thrown. -1 can be used to move the child to the start, and numbers
   * larger than the number of children can be used to move the child to the end.
   * @param {number} index The new order index for this space.
   * @returns {Promise<void>} Resolves when complete.
   * @throws Throws if this is a top level space.
   */


  async setOrder(index) {
    var _currentChild$getCont2;

    if (this.isTopLevel) throw new Error("Cannot set order of top level spaces currently");
    const parentRoom = this.getParentRoom();
    const children = parentRoom.currentState.getStateEvents(_event.EventType.SpaceChild);
    const ordered = this.getOrderedChildren(children);
    index = Math.max(Math.min(index, ordered.length - 1), 0);
    const currentIndex = this.getOrder();
    const movingUp = currentIndex < index;

    if (movingUp && index === ordered.length - 1) {
      index--;
    } else if (!movingUp && index === 0) {
      index++;
    }

    const prev = ordered[movingUp ? index : index - 1];
    const next = ordered[movingUp ? index + 1 : index];
    let newOrder = _utils.DEFAULT_ALPHABET[0];
    let ensureBeforeIsSane = false;

    if (!prev) {
      // Move to front
      if (next !== null && next !== void 0 && next.order) {
        newOrder = (0, _utils.prevString)(next.order);
      }
    } else if (index === ordered.length - 1) {
      // Move to back
      if (next !== null && next !== void 0 && next.order) {
        newOrder = (0, _utils.nextString)(next.order);
      }
    } else {
      // Move somewhere in the middle
      const startOrder = prev === null || prev === void 0 ? void 0 : prev.order;
      const endOrder = next === null || next === void 0 ? void 0 : next.order;

      if (startOrder && endOrder) {
        if (startOrder === endOrder) {
          // Error case: just move +1 to break out of awful math
          newOrder = (0, _utils.nextString)(startOrder);
        } else {
          newOrder = (0, _utils.averageBetweenStrings)(startOrder, endOrder);
        }
      } else {
        if (startOrder) {
          // We're at the end (endOrder is null, so no explicit order)
          newOrder = (0, _utils.nextString)(startOrder);
        } else if (endOrder) {
          // We're at the start (startOrder is null, so nothing before us)
          newOrder = (0, _utils.prevString)(endOrder);
        } else {
          // Both points are unknown. We're likely in a range where all the children
          // don't have particular order values, so we may need to update them too.
          // The other possibility is there's only us as a child, but we should have
          // shown up in the other states.
          ensureBeforeIsSane = true;
        }
      }
    }

    if (ensureBeforeIsSane) {
      // We were asked by the order algorithm to prepare the moving space for a landing
      // in the undefined order part of the order array, which means we need to update the
      // spaces that come before it with a stable order value.
      let lastOrder;

      for (let i = 0; i <= index; i++) {
        const target = ordered[i];

        if (i === 0) {
          lastOrder = target.order;
        }

        if (!target.order) {
          var _currentChild$getCont;

          // XXX: We should be creating gaps to avoid conflicts
          lastOrder = lastOrder ? (0, _utils.nextString)(lastOrder) : _utils.DEFAULT_ALPHABET[0];
          const currentChild = parentRoom.currentState.getStateEvents(_event.EventType.SpaceChild, target.roomId);
          const content = (_currentChild$getCont = currentChild === null || currentChild === void 0 ? void 0 : currentChild.getContent()) !== null && _currentChild$getCont !== void 0 ? _currentChild$getCont : {
            via: [this.client.getDomain()]
          };
          await this.client.sendStateEvent(parentRoom.roomId, _event.EventType.SpaceChild, _objectSpread(_objectSpread({}, content), {}, {
            order: lastOrder
          }), target.roomId);
        } else {
          lastOrder = target.order;
        }
      }

      newOrder = (0, _utils.nextString)(lastOrder);
    } // TODO: Deal with order conflicts by reordering
    // Now we can finally update our own order state


    const currentChild = parentRoom.currentState.getStateEvents(_event.EventType.SpaceChild, this.roomId);
    const content = (_currentChild$getCont2 = currentChild === null || currentChild === void 0 ? void 0 : currentChild.getContent()) !== null && _currentChild$getCont2 !== void 0 ? _currentChild$getCont2 : {
      via: [this.client.getDomain()]
    };
    await this.client.sendStateEvent(parentRoom.roomId, _event.EventType.SpaceChild, _objectSpread(_objectSpread({}, content), {}, {
      // TODO: Safely constrain to 50 character limit required by spaces.
      order: newOrder
    }), this.roomId);
  }
  /**
   * Creates (uploads) a new file to this tree. The file must have already been encrypted for the room.
   * @param {string} name The name of the file.
   * @param {ArrayBuffer} encryptedContents The encrypted contents.
   * @param {Partial<IEncryptedFile>} info The encrypted file information.
   * @param {IContent} additionalContent Optional event content fields to include in the message.
   * @returns {Promise<ISendEventResponse>} Resolves to the file event's sent response.
   */


  async createFile(name, encryptedContents, info, additionalContent) {
    var _additionalContent;

    const mxc = await this.client.uploadContent(new Blob([encryptedContents]), {
      includeFilename: false,
      onlyContentUri: true
    });
    info.url = mxc;
    const fileContent = {
      msgtype: _event.MsgType.File,
      body: name,
      url: mxc,
      file: info
    };
    additionalContent = (_additionalContent = additionalContent) !== null && _additionalContent !== void 0 ? _additionalContent : {};

    if (additionalContent["m.new_content"]) {
      // We do the right thing according to the spec, but due to how relations are
      // handled we also end up duplicating this information to the regular `content`
      // as well.
      additionalContent["m.new_content"] = fileContent;
    }

    const res = await this.client.sendMessage(this.roomId, _objectSpread(_objectSpread(_objectSpread({}, additionalContent), fileContent), {}, {
      [_event.UNSTABLE_MSC3089_LEAF.name]: {}
    }));
    await this.client.sendStateEvent(this.roomId, _event.UNSTABLE_MSC3089_BRANCH.name, {
      active: true,
      name: name
    }, res['event_id']);
    return res;
  }
  /**
   * Retrieves a file from the tree.
   * @param {string} fileEventId The event ID of the file.
   * @returns {MSC3089Branch} The file, or falsy if not found.
   */


  getFile(fileEventId) {
    const branch = this.room.currentState.getStateEvents(_event.UNSTABLE_MSC3089_BRANCH.name, fileEventId);
    return branch ? new _MSC3089Branch.MSC3089Branch(this.client, branch, this) : null;
  }
  /**
   * Gets an array of all known files for the tree.
   * @returns {MSC3089Branch[]} The known files. May be empty, but not null.
   */


  listFiles() {
    return this.listAllFiles().filter(b => b.isActive);
  }
  /**
   * Gets an array of all known files for the tree, including inactive/invalid ones.
   * @returns {MSC3089Branch[]} The known files. May be empty, but not null.
   */


  listAllFiles() {
    var _this$room$currentSta;

    const branches = (_this$room$currentSta = this.room.currentState.getStateEvents(_event.UNSTABLE_MSC3089_BRANCH.name)) !== null && _this$room$currentSta !== void 0 ? _this$room$currentSta : [];
    return branches.map(e => new _MSC3089Branch.MSC3089Branch(this.client, e, this));
  }

}

exports.MSC3089TreeSpace = MSC3089TreeSpace;