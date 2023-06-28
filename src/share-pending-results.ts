/**
 * Wraps an async function to ensure that only one call with the same arguments is running at a time.
 *
 * @param performAsyncTask - The async function to wrap.
 * @param keyFromArgs - A function that returns a cache key derived from the
 * arguments to the async function.
 *
 * @example
 * ```ts
 * const getProfile = sharePendingResults(
 *   async (userId: string, includeAvatar: boolean) => { ... },
 *   (...args) => args.join(","),
 * );
 *
 * // Now `getProfile` will only run one request at a time for each combination
 * // of arguments.
 * ```
 */
export function sharePendingResults<Args extends any[], Output extends Promise<any>>(
    performAsyncTask: (...args: Args) => Output,
    keyFromArgs: (...args: Args) => string = (...args): string => args.join(","),
): (...args: Args) => Output {
    const ongoing: Map<string, Output> = new Map();
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
