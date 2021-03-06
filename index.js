/**
 * RabbitMQ job subscribe & publish functions for Runnable
 * @module ./index
 */
'use strict';

require('loadenv')();

var EventEmitter = require('events').EventEmitter;
var amqplib = require('amqplib/callback_api');
var async = require('async');
var debug = require('debug')('hermes:index');
var defaults = require('101/defaults');
var isFunction = require('101/is-function');
var isString = require('101/is-string');
var noop = require('101/noop');
var querystring = require('querystring');
var util = require('util');
var uuid = require('node-uuid');

var assertOpts = require('./lib/assert-opts');
var EventJobs = require('./lib/event-jobs');

var hermes;

/**
 * Hermes - Runnable job queue API
 * @class
 * @throws
 * @param {Object} opts
 * @param {Object} socketOpts (optional)
 * @return this
 */
function Hermes (opts, socketOpts) {
  // mutates opts
  assertOpts(opts);
  if (!socketOpts) { socketOpts = {}; }
  defaults(socketOpts, {
    heartbeat: 0
  });
  var _this = this;
  this._channel = null;
  this._connection = null;
  this._consumerTags = {};
  this._opts = opts;
  this._opts.queues = Hermes._normalizeQueues(this._opts.queues)
  this._opts.publishedEvents = Hermes._normalizeQueues(this._opts.publishedEvents)
  this._opts.subscribedEvents = Hermes._normalizeQueues(this._opts.subscribedEvents)
  this._publishQueue = [];
  this._socketOpts = socketOpts;
  this._subscribeQueue = [];

  this._eventJobs = new EventJobs({
    publishedEvents: this._opts.publishedEvents,
    subscribedEvents: this._opts.subscribedEvents,
    name: this._opts.name
  });

  this.on('ready', function () {
    debug('hermes ready');
    var args;
    while(args = _this._publishQueue.pop()) {
      publish.apply(_this, args);
    }
    while(args = _this._subscribeQueue.pop()) {
      subscribe.apply(_this, args);
    }
  });
  this.on('publish', function (queueName, data) {
    debug('hermes publish event', queueName, data);
    if (_this._channel) {
      publish(queueName, data);
    }
    else {
      _this._publishQueue.push(Array.prototype.slice.call(arguments));
    }
  });
  this.on('subscribe', function (queueName, cb) {
    debug('hermes subscribe event', queueName);
    if (_this._channel) {
      subscribe(queueName, cb);
    }
    else {
      _this._subscribeQueue.push(Array.prototype.slice.call(arguments));
    }
  });
  this.on('unsubscribe', function (queueName, handler, cb) {
    debug('hermes unsubscribe event', queueName);
    if (_this._channel) {
      unsubscribe(queueName, handler, cb);
    }
    else {
      _this._subscribeQueue.forEach(function (args) {
        /* args: [queueName, cb] */
        if (handler) {
          if (args[0] === queueName && args[1] === handler) {
            _this._subscribeQueue.splice(_this._subscribeQueue.indexOf(args), 1);
          }
        }
        else if (args[0] === queueName) {
          _this._subscribeQueue.splice(_this._subscribeQueue.indexOf(args), 1);
        }
      });
      cb();
    }
  });
  /**
   * @param {String} queueName
   * @param {Object} data
   * @return null
   */
  function publish (queueName, data) {
    debug('channel.sendToQueue', queueName, data);

    if (_this._eventJobs.isPublishEvent(queueName)) {
      return _this._eventJobs.publish(queueName, data);
    }

    _this._channel.sendToQueue(
      queueName, data, { persistent: _this._opts.persistent });
  }
  /**
   * @param {String} queueName
   * @param {Function} cb
   * @return null
   */
  function subscribe (queueName, cb) {
    debug('channel.consume', queueName);
    var consumerTag = [
      uuid.v4(),
      queueName,
      cb.name
    ].join('-');
    _this._consumerTags[consumerTag] = Array.prototype.slice.call(arguments);

    if (_this._eventJobs.isSubscribeEvent(queueName)) {
      return _this._eventJobs.subscribe(queueName,  _this._subscribeCallback(cb));
    }

    _this._channel.consume(queueName, _this._subscribeCallback(cb), {
      consumerTag: consumerTag
    });
  }
  /**
   * @param {String} queueName
   * @param {Function|null} handler
   * @param {Function} cb
   * @return null
   */
  function unsubscribe (queueName, handler, cb) {
    debug('channel.cancel', queueName);
    var cancelTags = [];
    var tagVal;
    Object.keys(_this._consumerTags).forEach(function (consumerTag) {
      tagVal = _this._consumerTags[consumerTag];
      if (handler) {
        if (tagVal[0] === queueName && tagVal[1] === handler) {
          cancelTags.push(consumerTag);
        }
      }
      else if (tagVal[0] === queueName) {
        cancelTags.push(consumerTag);
      }
    });
    async.eachSeries(cancelTags, _this._channel.cancel.bind(_this._channel), function () {
      cancelTags.forEach(function (cancelTag) {
        delete _this._consumerTags[cancelTag];
      });
      if (isFunction(cb)) {
        cb.apply(_this, arguments);
      }
    });
  }
  return this;
}

util.inherits(Hermes, EventEmitter);

/**
 * Factory method of accessing the module level hermes singelton.
 * @param {object} opts Options for the hermes client.
 * @param {object} socketOpts Options for the underlying amqp socket.
 */
Hermes.hermesSingletonFactory = function (opts, socketOpts) {
  debug('hermesSingletonFactory', opts, socketOpts);
  hermes = (hermes) ? hermes : new Hermes(opts, socketOpts);
  return hermes;
};

/**
 * Hermes amqp interface module.
 * @module hermes
 */
module.exports = Hermes;

/**
 * Returns all the queue names with which Hermes was created.
 * @return {Array<String>} Queue names
 */
Hermes.prototype.getQueues = function () {
  var queues = this._opts.queues.slice().concat(
    this._opts.publishedEvents.slice(),
    this._opts.subscribedEvents.slice())
  return queues.map(Hermes._getQueueName);
};

/**
 * @throws
 * @param {String} queueName
 * @param {Object|String|Buffer} data
 * @return this
 */
Hermes.prototype.publish = function (queueName, data) {
  /*jshint maxcomplexity:7 */
  debug('hermes publish', queueName, data);
  if (!assertOpts.doesQueueExist(this._opts.queues, queueName) && !this._eventJobs.isPublishEvent(queueName)) {
    throw new Error('attempting to publish to invalid queue: '+queueName);
  }
  if (typeof data === 'string' || data instanceof String || data instanceof Buffer) {
    try {
      JSON.parse(data.toString());
    } catch (err) {
      throw new Error('data must be valid JSON');
    }
  }
  else {
    data = new Buffer(JSON.stringify(data));
  }
  this.emit('publish', queueName, data);
  return this;
};

/**
 * @throws
 * @param {String} queueName
 * @param {Function} cb
 * @return this
 */
Hermes.prototype.subscribe = function (queueName, handler) {
  debug('hermes subscribe', queueName);
  if (!assertOpts.doesQueueExist(this._opts.queues, queueName) && !this._eventJobs.isSubscribeEvent(queueName)) {
    throw new Error('attempting to subscribe to invalid queue: ' + queueName);
  }
  if (handler.length < 2) {
    throw new Error('queue listener callback must take a "done" callback function as a second'+
                    ' argument and invoke the function to send the ACK message to RabbitMQ'+
                    ' and remove the job from the queue.');
  }
  this.emit('subscribe', queueName, handler);
  return this;
};

/**
 * Unsubscribes all workers or individual worker from queue
 * @throws
 * @param {String} queueName
 * @param {Function|null} handler
 * @param {Function} cb (optional)
 * @return this
 */
Hermes.prototype.unsubscribe = function (queueName, handler, cb) {
  debug('hermes unsubscribe', queueName);
  if (!assertOpts.doesQueueExist(this._opts.queues, queueName) && !this._eventJobs.isSubscribeEvent(queueName)) {
    throw new Error('attempting to unsubscribe from invalid queue: ' + queueName);
  }
  this.emit('unsubscribe', queueName, handler, cb);
  return this;
};

/**
 * Connect
 * @param {Function} cb (optional)
 * @return this
 */
Hermes.prototype.connect = function (cb) {
  cb = cb || noop;
  var _this = this;
  var connectionUrl = [
    'amqp://', this._opts.username, ':', this._opts.password,
    '@', this._opts.hostname];
  if (this._opts.port) {
    // optional port
    connectionUrl.push(':');
    connectionUrl.push(this._opts.port);
  }
  connectionUrl = [
    connectionUrl.join(''),
    '?',
    querystring.stringify(this._socketOpts)
  ].join('');

  debug('connectionUrl', connectionUrl);
  debug('socketOpts', this._socketOpts);

  amqplib.connect(connectionUrl, this._socketOpts, function (err, conn) {
    if (err) { return cb(err); }
    debug('rabbitmq connected');
    _this._connection = conn;
    // we need listen to the `error` otherwise it would be thrown
    _this._connection.on('error', function (err) {
      err = err || new Error('Connection error');
      err.reason = 'connection error';
      debug('connection error', err)
      _this.emit('error', err);
    });

    _this._createChannel(cb);
  });
  return this;
};

/**
 * responsible for creating a channel
 * should also initialize all queue modules
 * @param  {Function} cb (err)
 */
Hermes.prototype._createChannel = function (cb) {
  var _this = this;

  _this._connection.createChannel(function (err, ch) {
    if (err) { return cb(err); }
    debug('rabbitmq channel created');
    /**
     * Durable queue: https://www.rabbitmq.com/tutorials/tutorial-two-python.html
     * (Message Durability)
     */
    _this._channel = ch;
    if (_this._opts.prefetch) {
      _this._channel.prefetch(_this._opts.prefetch);
    }

    _this._eventJobs.setChannel(ch);
    // we need listen to the `error` otherwise it would be thrown
    _this._channel.on('error', function (err) {
      err = err || new Error('Channel error');
      err.reason = 'channel error';
      debug('channel error', err)
      _this.emit('error', err);
    });

    _this._populateChannel(cb);
  });
};

/**
 * Normalizes input queue data. Input can be either string or queueDef object with `name` and/or `opts`
 * @param {String|Object} nameOrDef queueName or object with `name` and `opts`
 * @return {Object} normalized queueDef object with `name` and default `opts` (`durable==true` and potentially `expires`)
 */
Hermes._normalizeQueue = function (nameOrDef) {
  var opts = {
    durable: true
  }
  var queueDef
  if (isString(nameOrDef)) {
    if (process.env.HERMES_QUEUE_EXPIRES) {
      opts.expires = process.env.HERMES_QUEUE_EXPIRES;
    }
    queueDef = {
      name: nameOrDef,
      opts: opts
    }
  } else {
    queueDef = nameOrDef
    queueDef.opts = defaults(queueDef.opts, opts)
    if (!queueDef.opts.expires) {
      if (process.env.HERMES_QUEUE_EXPIRES) {
        queueDef.opts.expires = process.env.HERMES_QUEUE_EXPIRES;
      }
    }
  }
  return queueDef
}

Hermes._getQueueName = function (nameOrDef) {
  return isString(nameOrDef) ? nameOrDef : nameOrDef.name
}

/**
 * Normalizes all queues
 * @param {Array} array of mixed queueNames or queueDefs
 * @return {Array} array of normalized queues definitions
 */
Hermes._normalizeQueues = function (queues) {
  return queues.map(Hermes._normalizeQueue)
}


/**
 * Assert queue with provided name and potentially options
 * @param {Object} queueDef object with `name` and `opts`
 * @param {Function} cb (err)
 */
Hermes.prototype._assertQueue = function (queueDef, cb) {
  debug('assert queue', queueDef.name, queueDef.opts)
  this._channel.assertQueue(queueDef.name, queueDef.opts, function (err) {
    if (err) {
      debug('assert queue error', queueDef.name, queueDef.opts, err)
      return cb(err);
    }
    debug('assert queue success', queueDef.name, queueDef.opts)
    cb()
  })
}

/**
 * responsible for populating the channel with queues and exchanges
 * @param  {Function} cb (err)
 */
Hermes.prototype._populateChannel = function (cb) {
  var _this = this;

  async.forEach(_this._opts.queues, this._assertQueue.bind(this), function done (err) {
    if (err) { return cb(err); }

    _this._eventJobs.assertExchanges(function (err) {
      if (err) { return cb(err); }

      _this._eventJobs.assertAndBindQueues(function (err) {
        if (err) { return cb(err); }
        _this.emit('ready');
        cb();
      });
    });
  });
};

/**
 * Disconnect
 * @param {Function} cb
 * @return this
 */
Hermes.prototype.close = function (cb) {
  debug('hermes close');
  var _this = this;
  async.series([
    function (stepCb) {
      if (!_this._channel) {
        debug('hermes close !channel');
        return stepCb();
      }
      _this._channel.close(function (err) {
        debug('hermes channel close', arguments);
        if (!err) {
          delete _this._channel;
        }
        stepCb.apply(this, arguments);
      });
    },
    function (stepCb) {
      if (!_this._connection) {
        debug('hermes connection !connection');
        return stepCb();
      }
      _this._connection.close(function (err) {
        debug('hermes connection close', arguments);
        if (!err) {
          delete _this._channel;
          delete _this._connection;
        }
        stepCb.apply(this, arguments);
      });
    }
  ], cb);

  return this;
};

/**
 * @param {Function} cb
 * @return Function
 */
Hermes.prototype._subscribeCallback = function (cb) {
  var _this = this;
  debug('_subscribeCallback');
  return function (msg) {
    if (!msg) {
      debug('_subscribeCallback invalid message', msg);
      return;
    }
    cb(JSON.parse(msg.content.toString()), function done () {
      if (_this._channel) {
        debug('_subscribeCallback done');
        _this._channel.ack(msg);
      }
      else {
        debug('_subscribeCallback cannot ack. channel does not exist');
        _this.emit('error', new Error('Cannot ack. Channel does not exist'));
      }
    });
  };
};
