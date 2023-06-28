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
        promise.finally(() => ongoing.delete(key));
        ongoing.set(key, promise);
        return promise;
    };
}

export default sharePendingResults;
