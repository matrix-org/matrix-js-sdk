export class InvalidStoreError extends Error {
    static TOGGLED_LAZY_LOADING = "TOGGLED_LAZY_LOADING";

    constructor(reason, value) {
        super(reason);
        const message = `Store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`;
        const instance = Reflect.construct(Error, [message]);
        Reflect.setPrototypeOf(instance, Reflect.getPrototypeOf(this));
        instance.reason = reason;
        instance.value = value;
        return instance;
    }
}

export class InvalidCryptoStoreError extends Error {
    static TOO_NEW = "TOO_NEW";

    constructor(reason) {
        super(reason);
        const message = `Crypto store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`;
        const instance = Reflect.construct(Error, [message]);
        Reflect.setPrototypeOf(instance, Reflect.getPrototypeOf(this));
        instance.reason = reason;
        instance.name = 'InvalidCryptoStoreError';
        return instance;
    }
}
