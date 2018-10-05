// can't just do InvalidStoreError extends Error
// because of http://babeljs.io/docs/usage/caveats/#classes
function InvalidStoreError(reason, value) {
    const message = `Store is invalid because ${reason}, ` +
        `please delete all data and retry`;
    const instance = Reflect.construct(Error, [message]);
    Reflect.setPrototypeOf(instance, Reflect.getPrototypeOf(this));
    instance.reason = reason;
    instance.value = value;
    return instance;
}

InvalidStoreError.TOGGLED_LAZY_LOADING = "TOGGLED_LAZY_LOADING";
InvalidStoreError.NEEDS_DOWNGRADE = "NEEDS_DOWNGRADE";

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
