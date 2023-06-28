import { sharePendingResults } from "../../src/share-pending-results";
import { controllablePromiseFactory } from "../test-utils/test-utils";

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
        const promiseFactory = controllablePromiseFactory((userId: string, includeAvatar: boolean) =>
            [userId, includeAvatar].join(","),
        );

        const getProfile = sharePendingResults(
            async (userId: string, includeAvatar: boolean) => {
                return promiseFactory.makePromise(userId, includeAvatar);
            },
            (...args) => args.join(","),
        );

        // assuming the "get profile" async call takes some time
        const profilePromise = getProfile("foo", true);

        // check that the promise utility is working as expected
        expect(promiseFactory).toHaveLength(1);

        // Same args return the same promise
        expect(getProfile("foo", true)).toBe(profilePromise);
        expect(promiseFactory).toHaveLength(1);

        // Different args return different promises
        expect(profilePromise).not.toBe(getProfile("foo", false));
        expect(promiseFactory).toHaveLength(2);

        // After completion, a new call will return a new promise
        promiseFactory.getControls("foo", true)!.resolve(undefined);
        await profilePromise;
        expect(getProfile("foo", true)).not.toBe(profilePromise);
    });

    it("returns a new promise on failure", async () => {
        const promiseFactory = controllablePromiseFactory((userId: string, includeAvatar: boolean) =>
            [userId, includeAvatar].join(","),
        );
        const getProfile = sharePendingResults(
            async (userId: string, includeAvatar: boolean) => {
                return promiseFactory.makePromise(userId, includeAvatar);
            },
            (...args) => args.join(","),
        );

        // assuming the "get profile" async call takes some time
        const profilePromise = getProfile("foo", true);

        // After failure, a new call will return a new promise
        promiseFactory.getControls("foo", true)!.reject("my favorite error");
        await expect(profilePromise).rejects.toBe("my favorite error");
        expect(getProfile("foo", true)).not.toBe(profilePromise);
    });
});
