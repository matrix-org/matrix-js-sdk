import DeviceList from '../../../lib/crypto/DeviceList';
import MockStorageApi from '../../MockStorageApi';
import WebStorageSessionStore from '../../../lib/store/session/webstorage';
import testUtils from '../../test-utils';
import utils from '../../../lib/utils';

import expect from 'expect';
import Promise from 'bluebird';

const signedDeviceList = {
    "failures": {},
    "device_keys": {
        "@test1:sw1v.org": {
            "HGKAWHRVJQ": {
                "signatures": {
                    "@test1:sw1v.org": {
                        "ed25519:HGKAWHRVJQ":
                            "8PB450fxKDn5s8IiRZ2N2t6MiueQYVRLHFEzqIi1eLdxx1w" +
                            "XEPC1/1Uz9T4gwnKlMVAKkhB5hXQA/3kjaeLABw",
                    },
                },
                "user_id": "@test1:sw1v.org",
                "keys": {
                    "ed25519:HGKAWHRVJQ":
                        "0gI/T6C+mn1pjtvnnW2yB2l1IIBb/5ULlBXi/LXFSEQ",
                    "curve25519:HGKAWHRVJQ":
                        "mbIZED1dBsgIgkgzxDpxKkJmsr4hiWlGzQTvUnQe3RY",
                },
                "algorithms": [
                    "m.olm.v1.curve25519-aes-sha2",
                    "m.megolm.v1.aes-sha2",
                ],
                "device_id": "HGKAWHRVJQ",
                "unsigned": {},
            },
        },
    },
};

describe('DeviceList', function() {
    let downloadSpy;
    let sessionStore;

    beforeEach(function() {
        testUtils.beforeEach(this); // eslint-disable-line no-invalid-this

        downloadSpy = expect.createSpy();
        const mockStorage = new MockStorageApi();
        sessionStore = new WebStorageSessionStore(mockStorage);
    });

    function createTestDeviceList() {
        const baseApis = {
            downloadKeysForUsers: downloadSpy,
        };
        const mockOlm = {
            verifySignature: function(key, message, signature) {},
        };
        return new DeviceList(baseApis, sessionStore, mockOlm);
    }

    it("should successfully download and store device keys", function() {
        const dl = createTestDeviceList();

        dl.startTrackingDeviceList('@test1:sw1v.org');

        const queryDefer1 = Promise.defer();
        downloadSpy.andReturn(queryDefer1.promise);

        const prom1 = dl.refreshOutdatedDeviceLists();
        expect(downloadSpy).toHaveBeenCalledWith(['@test1:sw1v.org'], {});
        queryDefer1.resolve(utils.deepCopy(signedDeviceList));

        return prom1.then(() => {
            const storedKeys = sessionStore.getEndToEndDevicesForUser('@test1:sw1v.org');
            expect(Object.keys(storedKeys)).toEqual(['HGKAWHRVJQ']);
        });
    });

    it("should have an outdated devicelist on an invalidation while an " +
       "update is in progress", function() {
        const dl = createTestDeviceList();

        dl.startTrackingDeviceList('@test1:sw1v.org');

        const queryDefer1 = Promise.defer();
        downloadSpy.andReturn(queryDefer1.promise);

        const prom1 = dl.refreshOutdatedDeviceLists();
        expect(downloadSpy).toHaveBeenCalledWith(['@test1:sw1v.org'], {});
        downloadSpy.reset();

        // outdated notif arrives while the request is in flight.
        const queryDefer2 = Promise.defer();
        downloadSpy.andReturn(queryDefer2.promise);

        dl.invalidateUserDeviceList('@test1:sw1v.org');
        dl.refreshOutdatedDeviceLists();

        // the first request completes
        queryDefer1.resolve({
            device_keys: {
                '@test1:sw1v.org': {},
            },
        });

        return prom1.then(() => {
            // uh-oh; user restarts before second request completes. The new instance
            // should know we never got a complete device list.
            console.log("Creating new devicelist to simulate app reload");
            downloadSpy.reset();
            const dl2 = createTestDeviceList();
            const queryDefer3 = Promise.defer();
            downloadSpy.andReturn(queryDefer3.promise);

            const prom3 = dl2.refreshOutdatedDeviceLists();
            expect(downloadSpy).toHaveBeenCalledWith(['@test1:sw1v.org'], {});

            queryDefer3.resolve(utils.deepCopy(signedDeviceList));

            // allow promise chain to complete
            return prom3;
        }).then(() => {
            const storedKeys = sessionStore.getEndToEndDevicesForUser('@test1:sw1v.org');
            expect(Object.keys(storedKeys)).toEqual(['HGKAWHRVJQ']);
        });
    });
});
