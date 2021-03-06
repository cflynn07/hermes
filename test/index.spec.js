/**
 * @module test/index.spec
 */
'use strict';

var Code = require('code');
var Lab = require('lab');
var rewire = require('rewire');
var sinon = require('sinon');
var defaults = require('101/defaults');

var Hermes = rewire('../index');
var Events = require('../lib/event-jobs');

var connectionOpts = require('./fixtures/connection-opts');
var mockChannel = require('./fixtures/mock-channel');
var mockConnection = require('./fixtures/create-mock-connection');

var lab = exports.lab = Lab.script();

var afterEach = lab.afterEach;
var beforeEach = lab.beforeEach;
var describe = lab.describe;
var expect = Code.expect;
var it = lab.it;

describe('hermes', function () {
  var HermesClass = Hermes.__get__('Hermes');

  it('should initiate a connection to a rabbitmq server on instantiate', function (done) {
    var hermesAmqplib = Hermes.__get__('amqplib');
    sinon.stub(hermesAmqplib, 'connect', function (url) {
      expect(url).to.be.a.string();
      expect(url).to.equal('amqp://tom:harry@bobsburgers.net:1111?heartbeat=0');
      hermesAmqplib.connect.restore();
      done();
    });
    var hermes = Hermes.hermesSingletonFactory(connectionOpts.standard);
    hermes.connect();
  });

  it('should correctly construct connection url string without a specified port', function (done) {
    var hermesAmqplib = Hermes.__get__('amqplib');
    sinon.stub(hermesAmqplib, 'connect', function (url) {
      expect(url).to.be.a.string();
      expect(url).to.equal('amqp://tom:harry@bobsburgers.net?heartbeat=0');
      hermesAmqplib.connect.restore();
      done();
    });
    var hermes = new HermesClass(connectionOpts.noSpecPort);
    hermes.connect();
  });

  it('should set the hearbeat based on passed socket options', function(done) {
    var hermesAmqplib = Hermes.__get__('amqplib');
    sinon.stub(hermesAmqplib, 'connect', function (url) {
      expect(url).to.be.a.string();
      expect(url).to.equal('amqp://tom:harry@bobsburgers.net:1111?heartbeat=5555');
      hermesAmqplib.connect.restore();
      done();
    });
    var hermes = new Hermes(connectionOpts.standard, { heartbeat: 5555 });
    hermes.connect();
  });

  describe('pre-connect and post-connect functionality', function () {
    var TEST_QUEUE = 'test-queue';
    var connection;
    var channel;
    var connectFinish;
    var hermes;
    var hermesAmqplib;

    beforeEach(function (done) {
      hermesAmqplib = Hermes.__get__('amqplib');
      // connectFinish allow testing pre-post connected states
      sinon.stub(hermesAmqplib, 'connect', function (url, socketOpts, cb) {
        connectFinish = function () {
          connection = mockConnection();
          connection.createChannel = function (cb) {
            channel = mockChannel();
            cb(null, channel);
          };
          cb(null, connection);
        };
      });

      var opts = { queues: [{name: TEST_QUEUE}], prefetch: 10 };
      defaults(opts, connectionOpts.standard);
      hermes = new HermesClass(opts);
      hermes.connect();
      sinon.stub(Events.prototype, 'assertAndBindQueues');
      sinon.stub(Events.prototype, 'assertExchanges');
      done();
    });

    afterEach(function (done) {
      hermesAmqplib.connect.restore();
      Events.prototype.assertAndBindQueues.restore();
      Events.prototype.assertExchanges.restore();
      done();
    });

    it('should automatically queue subscribe invocations until connected to RabbitMQ server', function (done) {
      Events.prototype.assertAndBindQueues.yields();
      Events.prototype.assertExchanges.yields();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      var subscribeCB = function (data, done) {};
      hermes.subscribe(TEST_QUEUE, subscribeCB);
      expect(hermes._subscribeQueue).to.have.length(1);
      // simulate connection complete
      connectFinish();
      // all queued subscribe jobs are complete
      expect(hermes._subscribeQueue).to.have.length(0);
      done();
    });

    it('should automatically queue publish invocations until connected to RabbitMQ server', function (done) {
      Events.prototype.assertAndBindQueues.yields();
      Events.prototype.assertExchanges.yields();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      var testData = {foo: 'bar'};
      hermes.publish(TEST_QUEUE, testData);
      expect(hermes._publishQueue).to.have.length(1);
      // simulate connection complete
      connectFinish();
      // all queued subscribe jobs are complete
      expect(hermes._publishQueue).to.have.length(0);
      done();
    });

    it('should set the prefetch option when passed', function (done) {
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      connectFinish();
      // connected...
      sinon.assert.calledOnce(channel.prefetch);
      sinon.assert.calledWithExactly(
        channel.prefetch,
        10
      );
      done();
    });

    it('should not queue publish invocations if already connected to RabbitMQ server', function (done) {
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      connectFinish();
      // connected...
      var testData = {foo: 'bar'};
      expect(hermes._publishQueue).to.have.length(0);
      hermes.publish(TEST_QUEUE, testData);
      expect(hermes._publishQueue).to.have.length(0);
      expect(channel.sendToQueue.callCount).to.equal(1);
      expect(channel.sendToQueue.args[0][0]).to.equal(TEST_QUEUE);
      expect(channel.sendToQueue.args[0][1].toString())
        .to.equal(new Buffer(JSON.stringify(testData)).toString());
      done();
    });

    it('should not queue subscribe invocations if already connected to RabbitMQ server', function (done) {
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      connectFinish();
      // connected...
      var subscribeCB = function (data, done) {};
      hermes.subscribe(TEST_QUEUE, subscribeCB);
      expect(hermes._subscribeQueue).to.have.length(0);
      expect(channel.consume.callCount).to.equal(1);
      expect(channel.consume.args[0][0]).to.equal(TEST_QUEUE);
      done();
    });

    it('should remove workers from subscribe queue on unsubscribe if not yet connected (all workers in queue)', function (done) {
      var callback = sinon.spy();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      var worker = function (data, done) {};
      hermes.subscribe(TEST_QUEUE, worker);
      expect(hermes._subscribeQueue).to.have.length(1);
      // only has consumerTag if registered w/ rabbitmq
      expect(Object.keys(hermes._consumerTags)).to.have.length(0);
      hermes.unsubscribe(TEST_QUEUE, null, callback);
      expect(hermes._subscribeQueue).to.have.length(0);
      expect(Object.keys(hermes._consumerTags)).to.have.length(0);
      expect(callback.callCount).to.equal(1);
      done();
    });

    it('should remove workers from subscribe queue on unsubscribe if not yet connected (specific workers in queue)', function (done) {
      var callback = sinon.spy();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      var worker = function (data, done) {};
      var worker2 = function (data, done) {};
      hermes.subscribe(TEST_QUEUE, worker);
      hermes.subscribe(TEST_QUEUE, worker2);
      expect(hermes._subscribeQueue).to.have.length(2);
      // only has consumerTag if registered w/ rabbitmq
      expect(Object.keys(hermes._consumerTags)).to.have.length(0);
      hermes.unsubscribe(TEST_QUEUE, worker, callback);
      expect(hermes._subscribeQueue).to.have.length(1);
      expect(Object.keys(hermes._consumerTags)).to.have.length(0);
      expect(callback.callCount).to.equal(1);
      done();
    });

    it('should unsubscribe workers from rabbitmq (all workers in queue)', function (done) {
      Events.prototype.assertAndBindQueues.yields();
      Events.prototype.assertExchanges.yields();
      var callback = sinon.spy();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      var worker = function (data, done) {};
      var worker2 = function (data, done) {};
      hermes.subscribe(TEST_QUEUE, worker);
      hermes.subscribe(TEST_QUEUE, worker2);
      expect(hermes._subscribeQueue).to.have.length(2);
      connectFinish();
      // connected...
      expect(hermes._subscribeQueue).to.have.length(0);
      expect(Object.keys(hermes._consumerTags)).to.have.length(2);
      var consumerTag = Object.keys(hermes._consumerTags)[0];
      var consumerTag2 = Object.keys(hermes._consumerTags)[1];
      hermes.unsubscribe(TEST_QUEUE, null, callback);
      expect(Object.keys(hermes._consumerTags)).to.have.length(0);
      expect(channel.cancel.callCount).to.equal(2);
      expect(channel.cancel.args[0][0]).to.equal(consumerTag);
      expect(channel.cancel.args[1][0]).to.equal(consumerTag2);
      expect(callback.callCount).to.equal(1);
      done();
    });

    it('should unsubscribe workers from rabbitmq (specific workers in queue)', function (done) {
      Events.prototype.assertAndBindQueues.yields();
      Events.prototype.assertExchanges.yields();
      var callback = sinon.spy();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      var worker = function (data, done) {};
      var worker2 = function (data, done) {};
      hermes.subscribe(TEST_QUEUE, worker);
      hermes.subscribe(TEST_QUEUE, worker2);
      expect(hermes._subscribeQueue).to.have.length(2);
      connectFinish();
      // connected...
      expect(hermes._subscribeQueue).to.have.length(0);
      expect(Object.keys(hermes._consumerTags)).to.have.length(2);
      var consumerTag = Object.keys(hermes._consumerTags)[1];
      hermes.unsubscribe(TEST_QUEUE, worker, callback);
      expect(Object.keys(hermes._consumerTags)).to.have.length(1);
      expect(channel.cancel.callCount).to.equal(1);
      expect(channel.cancel.args[0][0]).to.equal(consumerTag);
      expect(callback.callCount).to.equal(1);
      done();
    });

    it('should emit channel error to hermes', function (done) {
      var callback = sinon.spy();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      connectFinish();
      // connected...
      hermes.on('error', function (err) {
        expect(err.message).to.equal('Some channel error');
        expect(err.reason).to.equal('channel error');
        done();
      });
      channel.emit('error', new Error('Some channel error'));
    });

    it('should emit connection error to hermes', function (done) {
      var callback = sinon.spy();
      expect(hermesAmqplib.connect.callCount).to.equal(1);
      // not yet connected...
      connectFinish();
      // connected...
      hermes.on('error', function (err) {
        expect(err.message).to.equal('Some connection error');
        expect(err.reason).to.equal('connection error');
        done();
      });
      connection.emit('error', new Error('Some connection error'));
    });

    describe('#persistent option', function () {
      it('should send messages with true persistent opt', function (done) {
        connectFinish();
        channel.origSendToQueue = channel.sendToQueue;
        channel.sendToQueue = sinon.spy(function (queueName, data, opts) {
          expect(opts.persistent).to.equal(true);
          channel.sendToQueue = channel.origSendToQueue;
          delete channel.origSendToQueue;
          done();
        });
        hermes.publish(TEST_QUEUE, {foo: 'bar'});
      });
    });

    describe('#getQueues', function () {
      it('should return a copy of the queues which which hermes was created', function (done) {
        var hermes = new Hermes(connectionOpts.standard);
        var queues = hermes.getQueues();
        // (a) should be a copy
        expect(queues).to.not.equal(hermes._opts.queues);
        // (b) should contain only the queues we specified
        expect(queues).to.only.contain(connectionOpts.standard.queues.map(Hermes._getQueueName));
        done();
      });
    });

    describe('#_subscribeCallback', function () {
      it('should emit an error if channel is null', function (done) {
        var hermes = new Hermes(connectionOpts.standard);
        hermes.on('error', function (err) {
          expect(err).to.exist();
          expect(err.message).to.equal('Cannot ack. Channel does not exist');
          done();
        });
        hermes._subscribeCallback(function (message, subscribeCb) {
          expect(message.name).to.equal('job1');
          subscribeCb();
        })({content: JSON.stringify({name: 'job1'})});
      });
      it('should call ack and callback', function (done) {
        var msg = {
          content: JSON.stringify({name: 'job1'})
        };
        sinon.spy(JSON, 'parse');
        var hermes = new Hermes(connectionOpts.standard);
        hermes._channel = {
          ack: function (message) {
            expect(message).to.equal(msg);
            expect(JSON.parse.callCount).to.equal(1);
            JSON.parse.restore();
            done();
          }
        };
        hermes.on('error', function (err) {
          done(err);
        });
        hermes._subscribeCallback(function (message, subscribeCb) {
          expect(message.name).to.equal('job1');
          subscribeCb();
        })(msg);
      });
    });
  });
});
