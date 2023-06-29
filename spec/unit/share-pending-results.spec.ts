import { sharePendingResults } from "../../src/share-pending-results";
import { defer, IDeferred } from "../../src/utils";

describe("sharePendingResults", () => {
    it("returns the same promise for the same arguments while pending", () => {
        const getProfile = sharePendingResults(
            async (_userId: string, _includeAvatar: boolean) => {
                return new Promise<void>(() => {
                    // just let these hang
                });
            },
            (...args) => args.join(","),
        );

        // assuming the "get profile" async call takes some time
        const profilePromise = getProfile("foo", true);

        // Same args return the same promise
        expect(profilePromise).toBe(getProfile("foo", true));

        // Different args return different promises
        expect(profilePromise).not.toBe(getProfile("foo", false));
    });

    it("returns a new promise on success", async () => {
        const cachedDeferreds: Record<string, IDeferred<any>> = {};
        const keyFromArgs = (...args: any[]) => args.join(",");

        const getProfile = sharePendingResults(
            async (userId: string, includeAvatar: boolean) => {
                const deferred = defer();
                cachedDeferreds[keyFromArgs(userId, includeAvatar)] = deferred;
                return deferred.promise;
            },
            (...args) => args.join(","),
        );

        // assuming the "get profile" async call takes some time
        const profilePromise = getProfile("foo", true);

        // check that tracking the deferred promises is working as expected
        expect(Object.keys(cachedDeferreds)).toHaveLength(1);

        // Same args return the same promise
        expect(getProfile("foo", true)).toBe(profilePromise);
        expect(Object.keys(cachedDeferreds)).toHaveLength(1);

        // Different args return different promises
        expect(profilePromise).not.toBe(getProfile("foo", false));
        expect(Object.keys(cachedDeferreds)).toHaveLength(2);

        // After completion, a new call will return a new promise
        cachedDeferreds[keyFromArgs("foo", true)].resolve(undefined);
        await profilePromise;
        expect(getProfile("foo", true)).not.toBe(profilePromise);
    });

    it("returns a new promise on failure", async () => {
        const cachedDeferreds: Record<string, IDeferred<any>> = {};
        const keyFromArgs = (...args: any[]) => args.join(",");

        const getProfile = sharePendingResults(
            async (userId: string, includeAvatar: boolean) => {
                const deferred = defer();
                cachedDeferreds[keyFromArgs(userId, includeAvatar)] = deferred;
                return deferred.promise;
            },
            (...args) => args.join(","),
        );

        // assuming the "get profile" async call takes some time
        const profilePromise = getProfile("foo", true);

        // After failure, a new call will return a new promise
        cachedDeferreds[keyFromArgs("foo", true)]!.reject("my favorite error");
        await expect(profilePromise).rejects.toBe("my favorite error");
        expect(getProfile("foo", true)).not.toBe(profilePromise);
    });
});
