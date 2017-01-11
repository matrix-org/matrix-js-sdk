/*
Copyright 2016 OpenMarket Ltd

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

/* A re-implementation of the javascript callback functions (setTimeout,
 * clearTimeout; setInterval and clearInterval are not yet implemented) which
 * try to improve handling of large clock jumps (as seen when
 * suspending/resuming the system).
 *
 * In particular, if a timeout would have fired while the system was suspended,
 * it will instead fire as soon as possible after resume.
 */

"use strict";

// we schedule a callback at least this often, to check if we've missed out on
// some wall-clock time due to being suspended.
var TIMER_CHECK_PERIOD_MS = 1000;

// counter, for making up ids to return from setTimeout
var _count = 0;

// the key for our callback with the real global.setTimeout
var _realCallbackKey;

// a sorted list of the callbacks to be run.
// each is an object with keys [runAt, func, params, key].
var _callbackList = [];

// var debuglog = console.log.bind(console);
var debuglog = function() {};

/**
 * Replace the function used by this module to get the current time.
 *
 * Intended for use by the unit tests.
 *
 * @param {function} f function which should return a millisecond counter
 *
 * @internal
 */
module.exports.setNow = function(f) {
    _now = f || Date.now;
};
var _now = Date.now;

/**
 * reimplementation of window.setTimeout, which will call the callback if
 * the wallclock time goes past the deadline.
 *
 * @param {function} func   callback to be called after a delay
 * @param {Number} delayMs  number of milliseconds to delay by
 *
 * @return {Number} an identifier for this callback, which may be passed into
 *                   clearTimeout later.
 */
module.exports.setTimeout = function(func, delayMs) {
    delayMs = delayMs || 0;
    if (delayMs < 0) {
        delayMs = 0;
    }

    var params = Array.prototype.slice.call(arguments, 2);
    var runAt = _now() + delayMs;
    var key = _count++;
    debuglog("setTimeout: scheduling cb", key, "at", runAt,
             "(delay", delayMs, ")");
    var data = {
        runAt: runAt,
        func: func,
        params: params,
        key: key,
    };

    // figure out where it goes in the list
    var idx = binarySearch(
        _callbackList, function(el) {
            return el.runAt - runAt;
        }
    );

    _callbackList.splice(idx, 0, data);
    _scheduleRealCallback();

    return key;
};

/**
 * reimplementation of window.clearTimeout, which mirrors setTimeout
 *
 * @param {Number} key   result from an earlier setTimeout call
 */
module.exports.clearTimeout = function(key) {
    if (_callbackList.length === 0) {
        return;
    }

    // remove the element from the list
    var i;
    for (i = 0; i < _callbackList.length; i++) {
        var cb = _callbackList[i];
        if (cb.key == key) {
            _callbackList.splice(i, 1);
            break;
        }
    }

    // iff it was the first one in the list, reschedule our callback.
    if (i === 0) {
        _scheduleRealCallback();
    }
};

// use the real global.setTimeout to schedule a callback to _runCallbacks.
function _scheduleRealCallback() {
    if (_realCallbackKey) {
        global.clearTimeout(_realCallbackKey);
    }

    var first = _callbackList[0];

    if (!first) {
        debuglog("_scheduleRealCallback: no more callbacks, not rescheduling");
        return;
    }

    var now = _now();
    var delayMs = Math.min(first.runAt - now, TIMER_CHECK_PERIOD_MS);

    debuglog("_scheduleRealCallback: now:", now, "delay:", delayMs);
    _realCallbackKey = global.setTimeout(_runCallbacks, delayMs);
}

function _runCallbacks() {
    var cb;
    var now = _now();
    debuglog("_runCallbacks: now:", now);

    // get the list of things to call
    var callbacksToRun = [];
    while (true) {
        var first = _callbackList[0];
        if (!first || first.runAt > now) {
            break;
        }
        cb = _callbackList.shift();
        debuglog("_runCallbacks: popping", cb.key);
        callbacksToRun.push(cb);
    }

    // reschedule the real callback before running our functions, to
    // keep the codepaths the same whether or not our functions
    // register their own setTimeouts.
    _scheduleRealCallback();

    for (var i = 0; i < callbacksToRun.length; i++) {
        cb = callbacksToRun[i];
        try {
            cb.func.apply(null, cb.params);
        } catch (e) {
            console.error("Uncaught exception in callback function",
                          e.stack || e);
        }
    }
}


/* search in a sorted array.
 *
 * returns the index of the last element for which func returns
 * greater than zero, or array.length if no such element exists.
 */
function binarySearch(array, func) {
    // min is inclusive, max exclusive.
    var min = 0,
        max = array.length;

    while (min < max) {
        var mid = (min + max) >> 1;
        var res = func(array[mid]);
        if (res > 0) {
            // the element at 'mid' is too big; set it as the new max.
            max = mid;
        } else {
            // the element at 'mid' is too small. 'min' is inclusive, so +1.
            min = mid + 1;
        }
    }
    // presumably, min==max now.
    return min;
}
