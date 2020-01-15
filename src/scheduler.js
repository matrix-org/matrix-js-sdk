/*
Copyright 2015, 2016 OpenMarket Ltd
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
 * This is an internal module which manages queuing, scheduling and retrying
 * of requests.
 * @module scheduler
 */
import * as utils from "./utils";
import {logger} from './logger';

const DEBUG = false;  // set true to enable console logging.

/**
 * Construct a scheduler for Matrix. Requires
 * {@link module:scheduler~MatrixScheduler#setProcessFunction} to be provided
 * with a way of processing events.
 * @constructor
 * @param {module:scheduler~retryAlgorithm} retryAlgorithm Optional. The retry
 * algorithm to apply when determining when to try to send an event again.
 * Defaults to {@link module:scheduler~MatrixScheduler.RETRY_BACKOFF_RATELIMIT}.
 * @param {module:scheduler~queueAlgorithm} queueAlgorithm Optional. The queuing
 * algorithm to apply when determining which events should be sent before the
 * given event. Defaults to {@link module:scheduler~MatrixScheduler.QUEUE_MESSAGES}.
 */
export function MatrixScheduler(retryAlgorithm, queueAlgorithm) {
    this.retryAlgorithm = retryAlgorithm || MatrixScheduler.RETRY_BACKOFF_RATELIMIT;
    this.queueAlgorithm = queueAlgorithm || MatrixScheduler.QUEUE_MESSAGES;
    this._queues = {
        // queueName: [{
        //  event: MatrixEvent,  // event to send
        //  defer: Deferred,  // defer to resolve/reject at the END of the retries
        //  attempts: Number  // number of times we've called processFn
        // }, ...]
    };
    this._activeQueues = [];
    this._procFn = null;
}

/**
 * Retrieve a queue based on an event. The event provided does not need to be in
 * the queue.
 * @param {MatrixEvent} event An event to get the queue for.
 * @return {?Array<MatrixEvent>} A shallow copy of events in the queue or null.
 * Modifying this array will not modify the list itself. Modifying events in
 * this array <i>will</i> modify the underlying event in the queue.
 * @see MatrixScheduler.removeEventFromQueue To remove an event from the queue.
 */
MatrixScheduler.prototype.getQueueForEvent = function(event) {
    const name = this.queueAlgorithm(event);
    if (!name || !this._queues[name]) {
        return null;
    }
    return utils.map(this._queues[name], function(obj) {
        return obj.event;
    });
};

/**
 * Remove this event from the queue. The event is equal to another event if they
 * have the same ID returned from event.getId().
 * @param {MatrixEvent} event The event to remove.
 * @return {boolean} True if this event was removed.
 */
MatrixScheduler.prototype.removeEventFromQueue = function(event) {
    const name = this.queueAlgorithm(event);
    if (!name || !this._queues[name]) {
        return false;
    }
    let removed = false;
    utils.removeElement(this._queues[name], function(element) {
        if (element.event.getId() === event.getId()) {
            // XXX we should probably reject the promise?
            // https://github.com/matrix-org/matrix-js-sdk/issues/496
            removed = true;
            return true;
        }
    });
    return removed;
};


/**
 * Set the process function. Required for events in the queue to be processed.
 * If set after events have been added to the queue, this will immediately start
 * processing them.
 * @param {module:scheduler~processFn} fn The function that can process events
 * in the queue.
 */
MatrixScheduler.prototype.setProcessFunction = function(fn) {
    this._procFn = fn;
    _startProcessingQueues(this);
};

/**
 * Queue an event if it is required and start processing queues.
 * @param {MatrixEvent} event The event that may be queued.
 * @return {?Promise} A promise if the event was queued, which will be
 * resolved or rejected in due time, else null.
 */
MatrixScheduler.prototype.queueEvent = function(event) {
    const queueName = this.queueAlgorithm(event);
    if (!queueName) {
        return null;
    }
    // add the event to the queue and make a deferred for it.
    if (!this._queues[queueName]) {
        this._queues[queueName] = [];
    }
    const defer = utils.defer();
    this._queues[queueName].push({
        event: event,
        defer: defer,
        attempts: 0,
    });
    debuglog(
        "Queue algorithm dumped event %s into queue '%s'",
        event.getId(), queueName,
    );
    _startProcessingQueues(this);
    return defer.promise;
};

/**
 * Retries events up to 4 times using exponential backoff. This produces wait
 * times of 2, 4, 8, and 16 seconds (30s total) after which we give up. If the
 * failure was due to a rate limited request, the time specified in the error is
 * waited before being retried.
 * @param {MatrixEvent} event
 * @param {Number} attempts
 * @param {MatrixError} err
 * @return {Number}
 * @see module:scheduler~retryAlgorithm
 */
MatrixScheduler.RETRY_BACKOFF_RATELIMIT = function(event, attempts, err) {
    if (err.httpStatus === 400 || err.httpStatus === 403 || err.httpStatus === 401) {
        // client error; no amount of retrying with save you now.
        return -1;
    }
    // we ship with browser-request which returns { cors: rejected } when trying
    // with no connection, so if we match that, give up since they have no conn.
    if (err.cors === "rejected") {
        return -1;
    }

    // if event that we are trying to send is too large in any way then retrying won't help
    if (err.name === "M_TOO_LARGE") {
        return -1;
    }

    if (err.name === "M_LIMIT_EXCEEDED") {
        const waitTime = err.data.retry_after_ms;
        if (waitTime) {
            return waitTime;
        }
    }
    if (attempts > 4) {
        return -1; // give up
    }
    return (1000 * Math.pow(2, attempts));
};

/**
 * Queues <code>m.room.message</code> events and lets other events continue
 * concurrently.
 * @param {MatrixEvent} event
 * @return {string}
 * @see module:scheduler~queueAlgorithm
 */
MatrixScheduler.QUEUE_MESSAGES = function(event) {
    // enqueue messages or events that associate with another event (redactions and relations)
    if (event.getType() === "m.room.message" || event.hasAssocation()) {
        // put these events in the 'message' queue.
        return "message";
    }
    // allow all other events continue concurrently.
    return null;
};

function _startProcessingQueues(scheduler) {
    if (!scheduler._procFn) {
        return;
    }
    // for each inactive queue with events in them
    utils.forEach(utils.filter(utils.keys(scheduler._queues), function(queueName) {
        return scheduler._activeQueues.indexOf(queueName) === -1 &&
                scheduler._queues[queueName].length > 0;
    }), function(queueName) {
        // mark the queue as active
        scheduler._activeQueues.push(queueName);
        // begin processing the head of the queue
        debuglog("Spinning up queue: '%s'", queueName);
        _processQueue(scheduler, queueName);
    });
}

function _processQueue(scheduler, queueName) {
    // get head of queue
    const obj = _peekNextEvent(scheduler, queueName);
    if (!obj) {
        // queue is empty. Mark as inactive and stop recursing.
        const index = scheduler._activeQueues.indexOf(queueName);
        if (index >= 0) {
            scheduler._activeQueues.splice(index, 1);
        }
        debuglog("Stopping queue '%s' as it is now empty", queueName);
        return;
    }
    debuglog(
        "Queue '%s' has %s pending events",
        queueName, scheduler._queues[queueName].length,
    );
    // fire the process function and if it resolves, resolve the deferred. Else
    // invoke the retry algorithm.

    // First wait for a resolved promise, so the resolve handlers for
    // the deferred of the previously sent event can run.
    // This way enqueued relations/redactions to enqueued events can receive
    // the remove id of their target before being sent.
    Promise.resolve().then(() => {
        return scheduler._procFn(obj.event);
    }).then(function(res) {
        // remove this from the queue
        _removeNextEvent(scheduler, queueName);
        debuglog("Queue '%s' sent event %s", queueName, obj.event.getId());
        obj.defer.resolve(res);
        // keep processing
        _processQueue(scheduler, queueName);
    }, function(err) {
        obj.attempts += 1;
        // ask the retry algorithm when/if we should try again
        const waitTimeMs = scheduler.retryAlgorithm(obj.event, obj.attempts, err);
        debuglog(
            "retry(%s) err=%s event_id=%s waitTime=%s",
            obj.attempts, err, obj.event.getId(), waitTimeMs,
        );
        if (waitTimeMs === -1) {  // give up (you quitter!)
            debuglog(
                "Queue '%s' giving up on event %s", queueName, obj.event.getId(),
            );
            // remove this from the queue
            _removeNextEvent(scheduler, queueName);
            obj.defer.reject(err);
            // process next event
            _processQueue(scheduler, queueName);
        } else {
            setTimeout(function() {
                _processQueue(scheduler, queueName);
            }, waitTimeMs);
        }
    });
}

function _peekNextEvent(scheduler, queueName) {
    const queue = scheduler._queues[queueName];
    if (!utils.isArray(queue)) {
        return null;
    }
    return queue[0];
}

function _removeNextEvent(scheduler, queueName) {
    const queue = scheduler._queues[queueName];
    if (!utils.isArray(queue)) {
        return null;
    }
    return queue.shift();
}

function debuglog() {
    if (DEBUG) {
        logger.log(...arguments);
    }
}

/**
 * The retry algorithm to apply when retrying events. To stop retrying, return
 * <code>-1</code>. If this event was part of a queue, it will be removed from
 * the queue.
 * @callback retryAlgorithm
 * @param {MatrixEvent} event The event being retried.
 * @param {Number} attempts The number of failed attempts. This will always be
 * >= 1.
 * @param {MatrixError} err The most recent error message received when trying
 * to send this event.
 * @return {Number} The number of milliseconds to wait before trying again. If
 * this is 0, the request will be immediately retried. If this is
 * <code>-1</code>, the event will be marked as
 * {@link module:models/event.EventStatus.NOT_SENT} and will not be retried.
 */

/**
 * The queuing algorithm to apply to events. This function must be idempotent as
 * it may be called multiple times with the same event. All queues created are
 * serviced in a FIFO manner. To send the event ASAP, return <code>null</code>
 * which will not put this event in a queue. Events that fail to send that form
 * part of a queue will be removed from the queue and the next event in the
 * queue will be sent.
 * @callback queueAlgorithm
 * @param {MatrixEvent} event The event to be sent.
 * @return {string} The name of the queue to put the event into. If a queue with
 * this name does not exist, it will be created. If this is <code>null</code>,
 * the event is not put into a queue and will be sent concurrently.
 */

 /**
 * The function to invoke to process (send) events in the queue.
 * @callback processFn
 * @param {MatrixEvent} event The event to send.
 * @return {Promise} Resolved/rejected depending on the outcome of the request.
 */

