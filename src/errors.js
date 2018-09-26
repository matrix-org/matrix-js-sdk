// can't just do InvalidStoreError extends Error
// because of http://babeljs.io/docs/usage/caveats/#classes
function InvalidStoreError(reason) {
    const message = `Store is invalid because ${reason}, ` +
        `please delete all data and retry`;
    const instance = Reflect.construct(Error, [message]);
    Reflect.setPrototypeOf(instance, Reflect.getPrototypeOf(this));
    instance.reason = reason;
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
