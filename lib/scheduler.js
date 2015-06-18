"use strict";
/**
 * This is an internal module which manages queuing, scheduling and retrying
 * of requests.
 * @module scheduler
 */

/**
 * Construct a scheduler for Matrix.
 * @constructor
 * @param {module:scheduler~retryAlgorithm} retryAlgorithm Optional. The retry
 * algorithm to use.
 * @param {module:scheduler~queueAlgorithm} queueAlgorithm Optional. The queuing
 * algorithm to use.
 * @prop {module:scheduler~retryAlgorithm} retryAlgorithm The retry algorithm to
 * apply when determining when to try to send an event again. Defaults to
 * {@link module:scheduler~MatrixScheduler.RETRY_BACKOFF}.
 * @prop {module:scheduler~queueAlgorithm} queueAlgorithm The queuing algorithm
 * to apply when determining which events should be sent before the given event.
 * Defaults to {@link module:scheduler~MatrixScheduler.QUEUE_MESSAGES}.
 */
function MatrixScheduler(retryAlgorithm, queueAlgorithm) {
    this.retryAlgorithm = retryAlgorithm || MatrixScheduler.RETRY_BACKOFF;
    this.queueAlgorithm = queueAlgorithm || MatrixScheduler.QUEUE_MESSAGES;
}


/**
 * Retries events up to 4 times using exponential backoff. This produces wait
 * times of 2, 4, 8, and 16 seconds (30s total) after which we give up.
 * @param {MatrixEvent} event
 * @param {Number} attempts
 * @return {Number}
 */
MatrixScheduler.RETRY_BACKOFF = function(event, attempts) {
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
 */
MatrixScheduler.QUEUE_MESSAGES = function(event) {
    if (event.getType() === "m.room.message") {
        // put these events in the 'message' queue.
        return "message";
    }
    // allow all other events continue concurrently.
    return null;
};

/**
 * The retry algorithm to apply when retrying events.
 * @callback retryAlgorithm
 * @param {MatrixEvent} event The event being retried.
 * @param {Number} attempts The number of failed attempts. This will always be
 * >= 1.
 * @return {Number} The number of milliseconds to wait before trying again. If
 * this is 0, the request will be immediately retried. If this is negative, the
 * event will be marked as {@link module:models/event.EventStatus.NOT_SENT}.
 */

 /**
 * The queuing algorithm to apply to events. All queues created are serviced in
 * a FIFO manner. To send the event ASAP, return <code>null</code> which will
 * not put this event in a queue.
 * @callback queueAlgorithm
 * @param {MatrixEvent} event The event to be sent.
 * @return {string} The name of the queue to put the event into. If a queue with
 * this name does not exist, it will be created. If this is <code>null</code>,
 * the event is not put into a queue and will be sent concurrently.
 */

/**
 * The MatrixScheduler class.
 */
module.exports = MatrixScheduler;
