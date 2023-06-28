/**
 * Wraps an async function to ensure that only one call with the same arguments is running at a time.
 *
 * @param performAsyncTask - The async function to wrap.
 * @param keyFromArgs - A function that returns a cache key derived from the
 * arguments to the async function. These keys can be any type, but note that
 * they are compared using `SameValueZero`: recommended to use string keys.
 *
 * @example
 * ```ts
 * const getProfile = sharePendingResults(
 *   async (userId: string, includeAvatar: boolean) => { ... },
 *   (...args) => args.join(","),
 * );
 *
 * // assuming the "get profile" async call takes some time
 * const profilePromise = getProfile("foo", true);
 *
 * // Same args return the same promise
 * assert(profilePromise === getProfile("foo", true));
 *
 * // Different args return different promises
 * assert(profilePromise !== getProfile("foo", false));
 *
 * // On any promise completion, a new call will return a new promise
 * assert(profilePromise !== getProfile("foo", false));
 * ```
 */
export function sharePendingResults<Args extends any[], Output extends Promise<any>, Key>(
    performAsyncTask: (...args: Args) => Output,
    keyFromArgs: (...args: Args) => Key,
): (...args: Args) => Output {
    const ongoing: Map<Key, Output> = new Map();
    return (...args: Args): Output => {
        const key = keyFromArgs(...args);
        const existing = ongoing.get(key);
        if (existing != null) {
            return existing;
        }

        const promise = performAsyncTask(...args);
        // You'd expect we'd be able to use `.finally()` here, but that causes
        // a `ERR_UNHANDLED_REJECTION` on rejection for some reason, even when
        // the error is handled.
        //
        // `.then()` works.
        promise.then(
            () => ongoing.delete(key),
            () => ongoing.delete(key),
        );
        ongoing.set(key, promise);

        return promise;
    };
}

export default sharePendingResults;
