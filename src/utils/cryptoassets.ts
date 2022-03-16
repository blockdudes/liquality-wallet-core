// Redefine the `cryptoassets` lib to pull from the getter - to include custom tokens
let store;

// Lazy load the store to prevent cyclic dependencies
function getStore() {
  if (store) return store;

  store = require('../store').store;
  return store;
}

const cryptoassets = new Proxy(
  {},
  {
    get(target, name, receiver) {
      return Reflect.get(
        { ...getStore().getters.cryptoassets },
        name,
        receiver
      );
    },
    ownKeys() {
      return Reflect.ownKeys(getStore().getters.cryptoassets);
    },
    getOwnPropertyDescriptor() {
      return {
        enumerable: true,
        configurable: true,
      };
    },
  }
);

export default cryptoassets;