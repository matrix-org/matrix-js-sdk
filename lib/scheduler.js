"use strict";
/**
 * This is an internal module which manages queuing, scheduling and retrying
 * of requests.
 * @module scheduler
 */
var utils = require("./utils");
var q = require("q");

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
function MatrixScheduler(retryAlgorithm, queueAlgorithm) {
    this.retryAlgorithm = retryAlgorithm || MatrixScheduler.RETRY_BACKOFF_RATELIMIT;
    this.queueAlgorithm = queueAlgorithm || MatrixScheduler.QUEUE_MESSAGES;
    this._queues = {
        // queueName: [{
        //  event: MatrixEvent,  // event to send
        //  defer: Deferred,  // defer to resolve/reject at the END of the retries
        //  txnId: String  // desired transaction ID
        // }, ...]
    };
    this._procFn = null;
}

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
 * @param {String} txnId Optional. The txnId to set when sending.
 * @return {?Promise} A promise if the event was queued, which will be
 * resolved or rejected in due time, else null.
 */
MatrixScheduler.prototype.queueEvent = function(event, txnId) {
    var queueName = this.queueAlgorithm(event);
    if (!queueName) {
        return null;
    }
    // add the event to the queue and make a deferred for it.
    if (!this._queues[queueName]) {
        this._queues[queueName] = [];
    }
    var defer = q.defer();
    this._queues[queueName].push({
        event: event,
        defer: defer,
        txnId: txnId
    });
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
    if (err.name === "M_LIMIT_EXCEEDED") {
        var waitTime = err.data.retry_after_ms;
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
    if (event.getType() === "m.room.message") {
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
    var obj = _removeNextEvent(scheduler, "");
    return obj;
}

function _removeNextEvent(scheduler, queueName) {
    var queue = scheduler._queues[queueName];
    if (!utils.isArray(queue)) {
        return null;
    }
    return queue.shift();
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
 * The queuing algorithm to apply to events. All queues created are serviced in
 * a FIFO manner. To send the event ASAP, return <code>null</code> which will
 * not put this event in a queue. Events that fail to send that form part of
 * a queue will be removed from the queue and the next event in the queue will
 * be sent.
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
 * @param {string} txnId The desired transaction ID for this event.
 * @return {Promise} Resolved/rejected depending on the outcome of the request.
 */

/**
 * The MatrixScheduler class.
 */
module.exports = MatrixScheduler;
