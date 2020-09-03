/*
Copyright 2016 OpenMarket Ltd
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

/* A re-implementation of the javascript callback functions (setTimeout,
 * clearTimeout; setInterval and clearInterval are not yet implemented) which
 * try to improve handling of large clock jumps (as seen when
 * suspending/resuming the system).
 *
 * In particular, if a timeout would have fired while the system was suspended,
 * it will instead fire as soon as possible after resume.
 */

import {logger} from './logger';

// we schedule a callback at least this often, to check if we've missed out on
// some wall-clock time due to being suspended.
const TIMER_CHECK_PERIOD_MS = 1000;

// counter, for making up ids to return from setTimeout
let _count = 0;

// the key for our callback with the real global.setTimeout
let _realCallbackKey;

// a sorted list of the callbacks to be run.
// each is an object with keys [runAt, func, params, key].
const _callbackList = [];

// var debuglog = logger.log.bind(logger);
const debuglog = function() {};

/**
 * Replace the function used by this module to get the current time.
 *
 * Intended for use by the unit tests.
 *
 * @param {function} [f] function which should return a millisecond counter
 *
 * @internal
 */
export function setNow(f) {
    _now = f || Date.now;
}
let _now = Date.now;

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
export function setTimeout(func, delayMs) {
    delayMs = delayMs || 0;
    if (delayMs < 0) {
        delayMs = 0;
    }

    const params = Array.prototype.slice.call(arguments, 2);
    const runAt = _now() + delayMs;
    const key = _count++;
    debuglog("setTimeout: scheduling cb", key, "at", runAt,
             "(delay", delayMs, ")");
    const data = {
        runAt: runAt,
        func: func,
        params: params,
        key: key,
    };

    // figure out where it goes in the list
    const idx = binarySearch(
        _callbackList, function(el) {
            return el.runAt - runAt;
        },
    );

    _callbackList.splice(idx, 0, data);
    _scheduleRealCallback();

    return key;
}

/**
 * reimplementation of window.clearTimeout, which mirrors setTimeout
 *
 * @param {Number} key   result from an earlier setTimeout call
 */
export function clearTimeout(key) {
    if (_callbackList.length === 0) {
        return;
    }

    // remove the element from the list
    let i;
    for (i = 0; i < _callbackList.length; i++) {
        const cb = _callbackList[i];
        if (cb.key == key) {
            _callbackList.splice(i, 1);
            break;
        }
    }

    // iff it was the first one in the list, reschedule our callback.
    if (i === 0) {
        _scheduleRealCallback();
    }
}

// use the real global.setTimeout to schedule a callback to _runCallbacks.
function _scheduleRealCallback() {
    if (_realCallbackKey) {
        global.clearTimeout(_realCallbackKey);
    }

    const first = _callbackList[0];

    if (!first) {
        debuglog("_scheduleRealCallback: no more callbacks, not rescheduling");
        return;
    }

    const now = _now();
    const delayMs = Math.min(first.runAt - now, TIMER_CHECK_PERIOD_MS);

    debuglog("_scheduleRealCallback: now:", now, "delay:", delayMs);
    _realCallbackKey = global.setTimeout(_runCallbacks, delayMs);
}

function _runCallbacks() {
    let cb;
    const now = _now();
    debuglog("_runCallbacks: now:", now);

    // get the list of things to call
    const callbacksToRun = [];
    while (true) {
        const first = _callbackList[0];
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

    for (let i = 0; i < callbacksToRun.length; i++) {
        cb = callbacksToRun[i];
        try {
            cb.func.apply(global, cb.params);
        } catch (e) {
            logger.error("Uncaught exception in callback function",
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
    let min = 0;
    let max = array.length;

    while (min < max) {
        const mid = (min + max) >> 1;
        const res = func(array[mid]);
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
