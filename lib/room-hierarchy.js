"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RoomHierarchy = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _event = require("./@types/event");

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
 * @module room-hierarchy
 */
class RoomHierarchy {
  // Map from room id to list of servers which are listed as a via somewhere in the loaded hierarchy
  // Map from room id to list of rooms which claim this room as their child
  // Map from room id to object

  /**
   * Construct a new RoomHierarchy
   *
   * A RoomHierarchy instance allows you to easily make use of the /hierarchy API and paginate it.
   *
   * @param {Room} root the root of this hierarchy
   * @param {number} pageSize the maximum number of rooms to return per page, can be overridden per load request.
   * @param {number} maxDepth the maximum depth to traverse the hierarchy to
   * @param {boolean} suggestedOnly whether to only return rooms with suggested=true.
   * @constructor
   */
  constructor(root, pageSize, maxDepth, suggestedOnly = false) {
    this.root = root;
    this.pageSize = pageSize;
    this.maxDepth = maxDepth;
    this.suggestedOnly = suggestedOnly;
    (0, _defineProperty2.default)(this, "viaMap", new Map());
    (0, _defineProperty2.default)(this, "backRefs", new Map());
    (0, _defineProperty2.default)(this, "roomMap", new Map());
    (0, _defineProperty2.default)(this, "loadRequest", void 0);
    (0, _defineProperty2.default)(this, "nextBatch", void 0);
    (0, _defineProperty2.default)(this, "_rooms", void 0);
    (0, _defineProperty2.default)(this, "serverSupportError", void 0);
  }

  get noSupport() {
    return !!this.serverSupportError;
  }

  get canLoadMore() {
    return !!this.serverSupportError || !!this.nextBatch || !this._rooms;
  }

  get loading() {
    return !!this.loadRequest;
  }

  get rooms() {
    return this._rooms;
  }

  async load(pageSize = this.pageSize) {
    if (this.loadRequest) return this.loadRequest.then(r => r.rooms);
    this.loadRequest = this.root.client.getRoomHierarchy(this.root.roomId, pageSize, this.maxDepth, this.suggestedOnly, this.nextBatch);
    let rooms;

    try {
      ({
        rooms,
        next_batch: this.nextBatch
      } = await this.loadRequest);
    } catch (e) {
      if (e.errcode === "M_UNRECOGNIZED") {
        this.serverSupportError = e;
      } else {
        throw e;
      }

      return [];
    } finally {
      this.loadRequest = null;
    }

    if (this._rooms) {
      this._rooms = this._rooms.concat(rooms);
    } else {
      this._rooms = rooms;
    }

    rooms.forEach(room => {
      this.roomMap.set(room.room_id, room);
      room.children_state.forEach(ev => {
        if (ev.type !== _event.EventType.SpaceChild) return;
        const childRoomId = ev.state_key; // track backrefs for quicker hierarchy navigation

        if (!this.backRefs.has(childRoomId)) {
          this.backRefs.set(childRoomId, []);
        }

        this.backRefs.get(childRoomId).push(ev.room_id); // fill viaMap

        if (Array.isArray(ev.content.via)) {
          if (!this.viaMap.has(childRoomId)) {
            this.viaMap.set(childRoomId, new Set());
          }

          const vias = this.viaMap.get(childRoomId);
          ev.content.via.forEach(via => vias.add(via));
        }
      });
    });
    return rooms;
  }

  getRelation(parentId, childId) {
    var _this$roomMap$get;

    return (_this$roomMap$get = this.roomMap.get(parentId)) === null || _this$roomMap$get === void 0 ? void 0 : _this$roomMap$get.children_state.find(e => e.state_key === childId);
  }

  isSuggested(parentId, childId) {
    var _this$getRelation;

    return (_this$getRelation = this.getRelation(parentId, childId)) === null || _this$getRelation === void 0 ? void 0 : _this$getRelation.content.suggested;
  } // locally remove a relation as a form of local echo


  removeRelation(parentId, childId) {
    const backRefs = this.backRefs.get(childId);

    if ((backRefs === null || backRefs === void 0 ? void 0 : backRefs.length) === 1) {
      this.backRefs.delete(childId);
    } else if (backRefs !== null && backRefs !== void 0 && backRefs.length) {
      this.backRefs.set(childId, backRefs.filter(ref => ref !== parentId));
    }

    const room = this.roomMap.get(parentId);

    if (room) {
      room.children_state = room.children_state.filter(ev => ev.state_key !== childId);
    }
  }

}

exports.RoomHierarchy = RoomHierarchy;