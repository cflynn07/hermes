/**
 * @module test/fixtures/connection-opts
 */

module.exports = {
  standard: {
    name: 'nemo',
    hostname: 'bobsburgers.net',
    port: '1111',
    username: 'tom',
    password: 'harry',
    queues: [{ name: 'a' }, { name: 'b' }]
  },
  noSpecPort: {
    name: 'nemo',
    hostname: 'bobsburgers.net',
    port: null,
    username: 'tom',
    password: 'harry',
    queues: [{ name: 'a' }, { name: 'b' }]
  }
};
