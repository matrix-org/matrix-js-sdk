// can't just do InvalidStoreError extends Error
// because of http://babeljs.io/docs/usage/caveats/#classes
function InvalidStoreError(reason, value) {
    const message = `Store is invalid because ${reason}, ` +
        `please stopthe client, delete all data and start the client again`;
    const instance = Reflect.construct(Error, [message]);
    Reflect.setPrototypeOf(instance, Reflect.getPrototypeOf(this));
    instance.reason = reason;
    instance.value = value;
    return instance;
}

InvalidStoreError.TOGGLED_LAZY_LOADING = "TOGGLED_LAZY_LOADING";

InvalidStoreError.prototype = Object.create(Error.prototype, {
  constructor: {
    value: Error,
    enumerable: false,
    writable: true,
    configurable: true,
  },
});
Reflect.setPrototypeOf(InvalidStoreError, Error);

module.exports.InvalidStoreError = InvalidStoreError;
