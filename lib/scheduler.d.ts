import { MatrixEvent } from "./models/event";
import { MatrixError } from "./http-api";
import { ISendEventResponse } from "./@types/requests";
declare type ProcessFunction<T> = (event: MatrixEvent) => Promise<T>;
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
export declare class MatrixScheduler<T = ISendEventResponse> {
    readonly retryAlgorithm: typeof MatrixScheduler.RETRY_BACKOFF_RATELIMIT;
    readonly queueAlgorithm: typeof MatrixScheduler.QUEUE_MESSAGES;
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
    static RETRY_BACKOFF_RATELIMIT(event: MatrixEvent, attempts: number, err: MatrixError): number;
    /**
     * Queues <code>m.room.message</code> events and lets other events continue
     * concurrently.
     * @param {MatrixEvent} event
     * @return {string}
     * @see module:scheduler~queueAlgorithm
     */
    static QUEUE_MESSAGES(event: MatrixEvent): string;
    private readonly queues;
    private activeQueues;
    private procFn;
    constructor(retryAlgorithm?: typeof MatrixScheduler.RETRY_BACKOFF_RATELIMIT, queueAlgorithm?: typeof MatrixScheduler.QUEUE_MESSAGES);
    /**
     * Retrieve a queue based on an event. The event provided does not need to be in
     * the queue.
     * @param {MatrixEvent} event An event to get the queue for.
     * @return {?Array<MatrixEvent>} A shallow copy of events in the queue or null.
     * Modifying this array will not modify the list itself. Modifying events in
     * this array <i>will</i> modify the underlying event in the queue.
     * @see MatrixScheduler.removeEventFromQueue To remove an event from the queue.
     */
    getQueueForEvent(event: MatrixEvent): MatrixEvent[];
    /**
     * Remove this event from the queue. The event is equal to another event if they
     * have the same ID returned from event.getId().
     * @param {MatrixEvent} event The event to remove.
     * @return {boolean} True if this event was removed.
     */
    removeEventFromQueue(event: MatrixEvent): boolean;
    /**
     * Set the process function. Required for events in the queue to be processed.
     * If set after events have been added to the queue, this will immediately start
     * processing them.
     * @param {module:scheduler~processFn} fn The function that can process events
     * in the queue.
     */
    setProcessFunction(fn: ProcessFunction<T>): void;
    /**
     * Queue an event if it is required and start processing queues.
     * @param {MatrixEvent} event The event that may be queued.
     * @return {?Promise} A promise if the event was queued, which will be
     * resolved or rejected in due time, else null.
     */
    queueEvent(event: MatrixEvent): Promise<T> | null;
    private startProcessingQueues;
    private processQueue;
    private peekNextEvent;
    private removeNextEvent;
}
export {};
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
//# sourceMappingURL=scheduler.d.ts.map