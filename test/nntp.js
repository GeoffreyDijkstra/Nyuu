"use strict";

var assert = require("assert");
var async = require('async');
var NNTP = require('../lib/nntp');
var net = require('net');

// async.waterfall wrapper which checks if callbacks are called more than once
var waterfall = function(funcs, cb) {
	var called = Array(funcs.length);
	async.waterfall(funcs.map(function(f, idx) {
		return function() {
			var args = Array.prototype.slice.call(arguments);
			var cb = args.pop();
			args.push(function() {
				if(called[idx]) throw new Error('async callback called more than once');
				called[idx] = true;
				cb.apply(null, arguments);
			});
			f.apply(null, args);
		};
	}), cb);
};

// mimick Post object as far as the NNTP module requires it
function DummyPost(data) {
	this.data = new Buffer(data);
	this.randomizeMessageID = function() {
		return 'xxxx';
	};
}

var newFakeConn = function() {
	var fakeConn = new (require('stream').Writable)();
	fakeConn.destroy = function() {};
	fakeConn.resume = function() {};
	return fakeConn;
};

var tl = require('./_testlib');

var DEBUG = false;
var TEST_SSL = false;

// TODO: consider throwing errors on unexpected warnings
var nntpLastLog = {warn: null, info: null, debug: null};
NNTP.log = {
	error: function(msg) {
		if(DEBUG) console.log('[ERROR] ' + msg);
		nntpLastLog.error = msg;
	},
	warn: function(msg) {
		if(DEBUG) console.log('[WARN] ' + msg);
		nntpLastLog.warn = msg;
	},
	info: function(msg) {
		if(DEBUG) console.log('[INFO] ' + msg);
		nntpLastLog.info = msg;
	},
	debug: function(msg) {
		if(DEBUG) console.log('[DEBUG] ' + msg);
		nntpLastLog.debug = msg;
	}
};


// emulate a simple echo/expectation server
function TestServer(onConn) {
	this.data = new Buffer(0);
	
	var cOpts = {};
	if(TEST_SSL) {
		var readFile = function(f) {
			return require('fs').readFileSync(__dirname + require('path').sep + f)
		};
		cOpts = {
			key: readFile('_ssl.key'),
			cert: readFile('_ssl.crt'),
		};
	}
	
	this.server = require(TEST_SSL ? 'tls' : 'net').createServer(cOpts, function(c) {
		if(this._conn) throw new Error('Multiple connections received');
		this._conn = c;
		this.connectedTime = Date.now();
		c.on('data', this.onData.bind(this));
		c.on('error', function(err) {
			// we do expect errors - log them for now?
			console.log('Test-server error: ', err);
		});
		c.once('close', function() {
			this._conn = null;
		}.bind(this));
		c.setNoDelay(); // make tests a little faster
		onConn();
	}.bind(this));
}
TestServer.prototype = {
	_expect: null,
	_expectAction: null,
	_conn: null,
	_closed: false,
	
	onData: function(chunk) {
		if(!this._expect) throw new Error('Unexpected data received: ' + chunk.toString());
		
		if(DEBUG) console.log('<< ' + chunk.toString());
		
		// highly inefficient, but meh
		this.data = Buffer.concat([this.data, chunk]);
		
		if(this.data.length > this._expect.length)
			assert.equal(this.data.toString(), this._expect.toString());
		if(this.data.length == this._expect.length) {
			assert.equal(this.data.toString(), this._expect.toString());
			this._expect = null;
			this.data = new Buffer(0);
			if(typeof this._expectAction == 'function')
				this._expectAction.call(this);
			else if(this._expectAction)
				this.respond(this._expectAction);
		}
	},
	expect: function(data, response) {
		this._expect = new Buffer(data);
		this._expectAction = response;
	},
	respond: function(msg) {
		this._conn.write(msg);
		this._conn.write('\r\n');
		if(DEBUG) console.log('>> ' + msg.toString());
	},
	close: function(cb) {
		if(!this._closed)
			this.server.close(cb);
		else
			process.nextTick(cb);
		this._closed = true;
	},
	drop: function() {
		this._conn.destroy();
		this._conn = null;
	},
	listen: function(port, cb) {
		this._closed = false;
		this.server.listen(port, '127.0.0.1', function() {
			lastServerPort = this.server.address().port;
			cb();
		}.bind(this));
	}
};

var deepMerge = require('../lib/util').deepMerge;

var currentServer;
var lastServerPort = 1; // hopefully invalid port
var newNNTP = function(opts) {
	var o = { // connection settings
		connect: {
			host: '127.0.0.1',
			port: lastServerPort,
			highWaterMark: 0,
			rejectUnauthorized: false
		},
		secure: TEST_SSL,
		user: null,
		password: null,
		timeout: 75,
		connTimeout: 500, // timeout is higher than the reconnect delay - a test relies on it
		postTimeout: 150,
		reconnectDelay: 300,
		connectRetries: 1,
		requestRetries: 5,
		postRetries: 1,
		errorTeardown: false,
		closeTimeout: 10,
		keepAlive: false
	};
	deepMerge(o, opts);
	return new NNTP(o);
};
function killServer(cb) {
	cb = cb || function(){};
	if(!currentServer) return cb();
	try {
		currentServer.close(function() {
			currentServer = null;
			lastServerPort = 1;
			cb();
		});
		return;
	} catch(x) { cb(); } // failed to close, just continue...
}
function setupTest(o, cb) {
	nntpLastLog = {warn: null, info: null, debug: null};
	
	lastServerPort = 1;
	if(currentServer) { // previous test failed?
		killServer(setupTest.bind(null, o, cb));
		return;
	}
	
	if(!cb) {
		cb = o;
		o = null;
	}
	
	var server = new TestServer(function() {
		server.respond('200 host test server');
	});
	server.listen(0, function() {
		cb(null, server, newNNTP(o));
	});
	currentServer = server;
}

function setupAuth(client, server, cb) {
	client.opts.user = 'nyuu';
	client.opts.password = 'iamreallylucy';
	server.expect('AUTHINFO USER nyuu\r\n', function() {
		assert.equal(client.state, 'authenticating');
		this.respond('381 Give AUTHINFO PASS command');
		this.expect('AUTHINFO PASS iamreallylucy\r\n', function() {
			this.respond('281 User logged in');
			if(cb) cb();
		});
	});
}

var endClient = function(client, cb, ef) {
	var called = false;
	ef = ef || 'end';
	client[ef](function() {
		if(called) throw new Error('client.end callback called twice');
		called = true;
		assert.equal(client.state, 'inactive');
		if(cb) cb();
	});
};

function closeTest(client, server, cb) {
	if(client.state == 'disconnected' || client.state == 'inactive') {
		server.close(cb);
		killServer();
	} else {
		server.expect('QUIT\r\n', '205 Connection closing');
		endClient(client);
		assert.equal(client.state, 'closing');
		tl.defer(function() {
			assert.equal(client.state, 'inactive');
			server.close(cb);
			killServer();
		});
	}
	
}

describe('NNTP Client', function() {

it('should handle basic tasks', function(done) {
	
	var server, client;
	var date1set = false;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			// this tests a pipelined DATE request
			server.expect('DATE\r\nDATE\r\n', '111 20100204060810\r\n111 20110204060810');
			client.date(function(err, date) {
				assert(!err);
				assert.equal(date.toString(), (new Date('2010-02-04 06:08:10')).toString());
				date1set = true;
			});
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert(date1set);
			
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			server.expect('GROUP invalid-group\r\n', '411 No such newsgroup (Mailbox does not exist)');
			client.group('invalid-group', function(err) {
				assert.equal(err.code, 'invalid_group');
				assert.equal(client.currentGroup, 'some-group');
				cb();
			});
		},
		function(cb) {
			server.expect('STAT <valid-post>\r\n', '223 51 <valid-post> article retrieved - request text separately');
			client.stat('valid-post', cb);
		},
		function(a, cb) {
			assert.equal(a[0], 51);
			assert.equal(a[1], 'valid-post');
			
			server.expect('STAT <invalid-post>\r\n', '430 no such article found');
			client.stat('invalid-post', cb);
		},
		function(a, cb) {
			assert(!a);
			
			server.expect('STAT 3311\r\n', '223 3311 <a-random-post> article retrieved - request text separately');
			client.stat(3311, cb);
		},
		function(a, cb) {
			assert.equal(a[0], 3311);
			assert.equal(a[1], 'a-random-post');
			
			// test posting
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, '240 <new-article> Article received ok');
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			
			cb();
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should be able to pipeline a post after a stat', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var rc = 0;
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			
			assert.equal(client.state, 'connected');
			
			server.expect('STAT <valid-post>\r\nPOST\r\n', function() {
				this.expect(msg, '240 <new-article> Article received ok');
				this.respond('223 51 <valid-post> article retrieved - request text separately\r\n340  Send article');
			});
			// TODO: consider testing the post with a post-timeout-hack enabled
			client.stat('valid-post', function(err, a) {
				assert.equal(rc++, 0);
				assert.equal(a[0], 51);
				assert.equal(a[1], 'valid-post');
			});
			client.post(new DummyPost(msg), function(err, a) {
				assert.equal(rc++, 1);
				assert.equal(a, 'new-article');
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});


it('should auto-connect on request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			server.expect('DATE\r\n', '111 20110204060810');
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert.equal(client.state, 'connected');
			
			closeTest(client, server, cb);
		}
	], done);
});

it('should honour a request made before connected', function(done) {
	var server, client;
	var date1set = false;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			server.expect('DATE\r\nDATE\r\n', '111 20100204060810\r\n111 20110204060810');
			client.connect();
			client.date(function(err, date) {
				assert(!err);
				assert.equal(date.toString(), (new Date('2010-02-04 06:08:10')).toString());
				date1set = true;
			});
			client.date(cb);
		},
		function(date, cb) {
			assert(date1set);
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});

it('should authenticate', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});

it('should end when requested'); // also test .destroy() method
['end','close'].forEach(function(ef) {
	// also check that the 'end' event is received by the server, but not 'close'
	// also check for correct timings if the server actually ends the connection
	it('should destroy if '+ef+' timeout exceeded');
	
	// this isn't much of a test, since errors after end/close should largely be discarded
	// it's mostly to ensure that no exceptions get thrown
	it('should deal with socket errors after '+ef+' called', function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				if(ef == 'end')
					server.expect('QUIT\r\n', '205 Connection closing');
				client[ef](function() {
					assert.equal(client.state, 'inactive');
					cb();
				});
				client.socket.emit('error', new Error('test error'));
			},
			function(cb) {
				closeTest(client, server, cb);
			}
		], done);
	});
});

it('should call all end/close callbacks when closed');

it('should not connect if destroyed straight after', function(done) {
	var server, client;
	waterfall([
		killServer,
		function(cb) {
			var _server = new TestServer(function() {
				throw new Error('Client connected');
			});
			_server.listen(0, function() {
				cb(null, _server, newNNTP());
			});
			currentServer = _server;
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(function(err) {
				assert.equal(err.code, 'cancelled');
				cb();
			});
			client.destroy();
		},
		function(cb) {
			assert.equal(client.state, 'inactive');
			closeTest(client, server, cb);
		}
	], done);
});

['end','close','destroy'].forEach(function(ef) {
	it('should notify cancellation + kill reconnect if ' + ef + '() during connect retry wait', function(done) {
		waterfall([
			killServer,
			function(cb) {
				var client = newNNTP();
				client.connect(function(err) {
					assert.equal(err.code, 'cancelled');
					assert.equal(client.state, 'inactive');
					cb();
				});
				// this is triggered to run whilst the reconnect timeout is running
				setTimeout(function() {
					if(ef == 'destroy')
						client.destroy();
					else
						endClient(client, null, ef);
				}, 100);
			}
		], done);
	});
});

it('should notify cancellation if cancelled during authentication', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.opts.user = 'nyuu';
			client.opts.password = 'iamreallylucy';
			
			server.expect('AUTHINFO USER nyuu\r\n', function() {
				assert.equal(client.state, 'authenticating');
				client.destroy();
				assert.equal(client.state, 'inactive');
			});
			client.connect(function(err) {
				assert.equal(err.code, 'cancelled');
				cb();
			});
		},
		function(cb) {
			tl.defer(function() {
				server.close(cb);
				killServer();
				assert.equal(client.state, 'inactive');
			});
		}
	], done);
});

[
	{msg: 'half-open end request', resp: true, req: 'date', ef: 'end'}, // this test seems to fail with SSL enabled; maybe node has slightly different semantics with calling .end() and not receiving data afterwards
	{msg: 'half-open end request (error)', resp: false, req: 'date', ef: 'end'},
	{msg: 'half-open end pipelined request', resp: true, req: 'date2', ef: 'end'},
	{msg: 'half-open end pipelined request (error)', resp: false, req: 'date2', ef: 'end'},
	{msg: 'half-open close request', resp: true, req: 'date', ef: 'close'},
	{msg: 'half-open close request (error)', resp: false, req: 'date', ef: 'close'},
	{msg: 'half-open close pipelined request', resp: true, req: 'date2', ef: 'close'},
	{msg: 'half-open close pipelined request (error)', resp: false, req: 'date2', ef: 'close'},
	{msg: 'close request during post', resp: true, req: 'post', ef: 'close'},
	{msg: 'close request during post (error)', resp: false, req: 'post', ef: 'close'}
].forEach(function(test) {
	it('should handle ' + test.msg, function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				// request something and immediately end - response should still come back
				if(test.req == 'date' || test.req == 'date2') {
					server.expect('DATE\r\n' + (test.req == 'date2' ? 'DATE\r\n':'') + (test.ef == 'end' ? 'QUIT\r\n':''), function() {
						if(test.resp) {
							setImmediate(function() {
								server.respond('111 20110204060810' + (test.req == 'date2' ? '\r\n111 20110204060810':''));
								if(test.ef == 'end')
									server.respond('205 Connection closing');
							});
						} else {
							// do nothing so that client times out
							// TODO: check that client doesn't attempt to reconnect
						}
					});
					var called = 0;
					var respCb = function(err, date) {
						if(test.ef == 'close') {
							assert.equal(err.code, 'cancelled');
							assert(!date);
						} else if(test.resp) {
							assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
						} else {
							assert.equal(err.code, 'timeout');
							assert(!date);
							//assert.equal(client.state, 'disconnected');
						}
					};
					
					if(test.req == 'date2') {
						client.date(function(err, date) {
							assert.equal(called++, 0);
							respCb(err, date);
						});
					} else {
						called++;
					}
					client.date(function(err, date) {
						assert.equal(called++, 1);
						respCb(err, date);
						cb();
					});
				}
				if(test.req == 'post') {
					var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
					server.expect('POST\r\n' + (test.ef == 'end' ? 'QUIT\r\n':''), function() {
						if(test.resp) {
							this.respond('340  Send article');
							if(test.ef == 'end')
								server.respond('205 Connection closing');
						}
					});
					client.post(new DummyPost(msg), function(err, a) {
						if(test.ef == 'close') {
							assert.equal(err.code, 'cancelled');
							assert(!a);
						} else {
							// TODO: support this??
						}
						cb();
					});
				}
				endClient(client, null, test.ef);
				assert.equal(client.state, 'closing');
			},
			function(cb) {
				tl.defer(function() {
					server.close(cb);
					killServer();
					assert.equal(client.state, 'inactive');
				});
			}
		], done);
	});
});

[true, false].forEach(function(resp) {
	var ef = 'close';
	it('should handle close request during post upload' + (resp ? '':' (error)'), function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.connect(cb);
			},
			function(cb) {
				assert.equal(client.state, 'connected');
				
				var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
				server.expect('POST\r\n' + (ef == 'end' ? 'QUIT\r\n':''), function() {
					this.expect(msg, function() {
						if(resp) {
							this.respond('240 <new-article> Article received ok');
							if(ef == 'end')
								server.respond('205 Connection closing');
						}
					});
					this.respond('340  Send article');
					endClient(client, null, ef);
					assert.equal(client.state, 'closing');
				});
				client.post(new DummyPost(msg), function(err, a) {
					if(ef == 'close') {
						assert.equal(err.code, 'cancelled');
						assert(!a);
					} else {
						// TODO: support this??
					}
					cb();
				});
			},
			function(cb) {
				tl.defer(function() {
					server.close(cb);
					killServer();
					assert.equal(client.state, 'inactive');
				});
			}
		], done);
		
	});
});

[{resp: true, ef: 'end'}, {resp: false, ef: 'end'},
 {resp: true, ef: 'close'}, {resp: false, ef: 'close'}].forEach(function(t) {
	it(t.ef + ' request during auth' + (t.resp ? '':' (error)'), function(done) {
		var server, client;
		waterfall([
			setupTest,
			function(_server, _client, cb) {
				server = _server;
				client = _client;
				client.opts.user = 'nyuu';
				client.opts.password = 'iamreallylucy';
				
				server.expect('AUTHINFO USER nyuu\r\n', function() {
					assert.equal(client.state, 'authenticating');
					endClient(client, null, t.ef);
					assert.equal(client.state, 'closing');
					if(t.ef == 'end')
						server.expect('QUIT\r\n');
					if(t.resp) {
						server.respond('381 Give AUTHINFO PASS command');
					}
				});
				client.connect(function(err) {
					assert.equal(err.code, 'cancelled'); // we don't distinguish between a response being given or not for .end requests during connection setup
					cb();
				});
			},
			function(cb) {
				tl.defer(function() {
					server.close(cb);
					killServer();
					assert.equal(client.state, 'inactive');
				});
			}
		], done);
	});
});

it('should not honor half-open destroy request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\n', function() {
				setImmediate(function() {
					if(!server._conn) return;
					server._conn.once('error', function(){}); // suppress EPIPE error
					server.respond('111 20110204060810');
				});
			});
			client.date(tl.fn1(function(err) {
				assert.equal(err.code, 'cancelled');
			}));
			client.destroy();
			assert.equal(client.state, 'inactive');
			tl.defer(function() {
				server.close(cb);
				killServer();
			});
		}
	], done);
});

it('should handle connection drop just before request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.drop();
			server.expect('DATE\r\n', '111 20110204060810');
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			closeTest(client, server, cb);
		}
	], done);
});

it('should deal with error responses');
it('should deal with invalid responses'); // including onconnect

it('should attempt to reconnect if connection is lost (keepalive=1)', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {keepAlive: true}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.drop();
			setupAuth(client, server, function() {
				tl.defer(cb);
			});
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			closeTest(client, server, cb);
		}
	], done);
	
});
it('should attempt to rejoin a group if connection is lost (keepalive=1)', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {keepAlive: true}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			server.drop();
			setupAuth(client, server, function() {
				server.expect('GROUP some-group\r\n', function() {
					this.respond('211 2 1 2 some-group');
					tl.defer(cb);
				});
			});
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should attempt to reconnect if connection is lost after new request (keepalive=0)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.drop();
			tl.defer(function() {
				assert.equal(client.state, 'inactive');
				client.stat(1, cb);
				setupAuth(client, server, function() {
					server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
				});
			});
		},
		function(a, cb) {
			assert.equal(client.state, 'connected');
			assert.equal(a[0], 1);
			assert.equal(a[1], 'some-post');
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should attempt to rejoin a group if connection is lost after new request (keepalive=0)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			setupAuth(client, server);
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			server.drop();
			tl.defer(function() {
				assert.equal(client.state, 'inactive');
				client.stat(1, cb);
				setupAuth(client, server, function() {
					server.expect('GROUP some-group\r\n', function() {
						server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
						this.respond('211 2 1 2 some-group');
					});
				});
			});
		},
		function(a, cb) {
			assert.equal(client.state, 'connected');
			assert.equal(a[0], 1);
			assert.equal(a[1], 'some-post');
			
			closeTest(client, server, cb);
		}
	], done);
});


it('should clear receive buffer on connection dropout');
it('should disconnect if response received exceeds 4KB in size');

it('should resend request if connection lost before response received', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.group('some-group', cb);
		},
		function(cb) {
			assert.equal(client.currentGroup, 'some-group');
			
			// send req
			server.expect('DATE\r\n', function() {
				this.expect('GROUP some-group\r\n', function() {
					this.expect('DATE\r\n', '111 20110204060810');
					this.respond('211 2 1 2 some-group');
				});
				this.drop();
			});
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should reattempt to post if connection drops out', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					this.expect('POST\r\n', function() {
						this.expect(msg, '240 <new-article> Article received ok');
						this.respond('340  Send article');
					});
					// we'll hijack this test case to check that the input buffer gets cleared on reconnect, by sending some junk data
					this._conn.write('blah'); // should be ignored by client
					setTimeout(function() {
						server.drop();
					}, 30);
				});
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			
			closeTest(client, server, cb);
		}
	], done);
});

it('should reattempt to post if first time fails', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					this.expect('POST\r\n', function() {
						this.expect(msg, '240 <new-article> Article received ok');
						this.respond('340 Send article');
					});
					this.respond('441 posting failed');
				});
				this.respond('340 Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			
			closeTest(client, server, cb);
		}
	], done);
	
});

it('should resend request if connection lost and reconnect fails once', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.currentGroup = 'some-group';
			server.expect('GROUP some-group\r\n', '211 2 1 2 some-group');
			client.connect(cb);
		},
		function(cb) {
			// send req
			server.expect('DATE\r\n', function() {
				this.expect('GROUP some-group\r\n', function() {
					this.expect('GROUP some-group\r\n', function() {
						this.expect('DATE\r\n', '111 20110204060810');
						this.respond('211 2 1 2 some-group');
					});
					this.drop(); // drop a second time (this will be in the connect init sequence)
				});
				this.drop(); // drop first time
			});
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			
			closeTest(client, server, cb);
		}
	], done);
});


it('should retry on request timeout', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\n', function() {
				// never give a response...
				// give one on second try
				server.expect('DATE\r\n', '111 20110204060810');
			});
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			closeTest(client, server, cb);
		}
	], done);
	
});
it('should retry on request timeout (3x pipeline)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\nDATE\r\nDATE\r\n', function() {
				// respond to only one request, ignore other two, which should be tried again
				server.expect('DATE\r\nDATE\r\n', '111 20120204060810\r\n111 20130204060810');
				
				server.respond('111 20110204060810');
			});
			
			var called = 0;
			client.date(function(err, date) {
				assert.equal(called++, 0);
				assert(!err);
				assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			});
			client.date(function(err, date) {
				assert.equal(called++, 1);
				assert(!err);
				assert.equal(date.toString(), (new Date('2012-02-04 06:08:10')).toString());
			});
			client.date(function(err, date) {
				assert.equal(called++, 2);
				assert(!err);
				assert.equal(date.toString(), (new Date('2013-02-04 06:08:10')).toString());
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('should send timeout errors to pipelined requests', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {requestRetries: 0}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			server.expect('DATE\r\nDATE\r\n', function() {
				// don't respond -> timeout error
				// the second request will be resent though...
				server.expect('DATE\r\n', function() {
					server.drop();
				});
			});
			
			var called = 0;
			client.date(function(err, date) {
				assert.equal(called++, 0);
				assert.equal(err.code, 'timeout');
				assert(!date);
			});
			client.date(function(err, date) {
				assert.equal(called++, 1);
				assert.equal(err.code, 'connection_lost');
				assert(!date);
				cb();
			});
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});

it('check timeout timing of pipelined requests', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {requestRetries: 0, timeout: 200}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var t = Date.now();
			server.expect('DATE\r\nDATE\r\n', function() {
				// don't respond -> timeout error
				assert(Date.now()-t >= 100);
				server.expect('DATE\r\n'); // expected 2nd request
			});
			
			var called = 0;
			client.date(function(err, date) {
				assert.equal(called++, 0);
				assert(Date.now()-t >= 200); // timeout delay
				assert(Date.now()-t < 300); // but less than timeout + second request delay
				assert.equal(err.code, 'timeout');
				assert(!date);
			});
			setTimeout(function() {
				client.date(function(err, date) {
					assert.equal(called++, 1);
					assert(Date.now()-t >= 400); // the first timeout should trigger a reconnect, resetting the second timeout, so total time should be > 2*timeout
					assert.equal(err.code, 'timeout');
					assert(!date);
					cb();
				});
			}, 100);
		},
		function(cb) {
			var t = Date.now();
			server.expect('DATE\r\nDATE\r\n', function() {
				// respond to only one
				this.respond('111 20110204060810');
			});
			
			var called = 0;
			client.date(function(err, date) {
				assert.equal(called++, 0);
				assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			});
			setTimeout(function() {
				client.date(function(err, date) {
					assert.equal(called++, 1);
					assert(Date.now()-t >= 300); // timeout + second request delay
					assert(Date.now()-t < 400); // but less than 2*timeout
					assert.equal(err.code, 'timeout');
					assert(!date);
					cb();
				});
			}, 100);
		},
		function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});


it('should retry on posting timeout', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {postTimeout: 100000}), // test that we hit the request timeout, not the upload timeout
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					// never give a response...
					// give one on second try
					this.expect('POST\r\n', function() {
						this.expect(msg, '240 <new-article> Article received ok');
						this.respond('340  Send article');
					});
				});
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'new-article');
			closeTest(client, server, cb);
		}
	], done);
});

it('should report upload timeouts', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {
			postTimeout: 300,
			timeout: 100000, // test that we hit upload timeouts, not request timeouts
			requestRetries: 0,
			uploadChunkSize: 1048576 // this seems to increase the likelihood of upload stalls
		}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = ' ';
			// make a large enough message to exhaust Node's internal buffers (4MB doesn't seem to work on node v0.10, but 8MB seems fine) so that pausing actually works
			for(var i=0; i<24; i++)
				msg += msg;
			msg = 'My-Secret: not telling\r\n\r\n' + msg + '\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this._conn.pause(); // try to not accept any data
				this.respond('340  Send article');
				
				// don't respond and hope for an upload timeout
			});
			client.post(new DummyPost(msg), function(err, a) {
				assert.equal(err.code, 'timeout');
				process.nextTick(function() { // in current code, state is 'disconnected' now, and gets switched to 'inactive' a bit later
					assert.equal(client.state, 'inactive');
					cb();
				});
			});
		},
		function(cb) {
			server.drop(); // drop any client connection
			closeTest(client, server, cb);
		}
	], done);
});

it('should ignore posting timeout if requested', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {onPostTimeout: ['ignore']}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			server.expect('POST\r\n', function() {
				this.expect(msg, function() {
					// never give a response...
				});
				this.respond('340  Send article');
			});
			client.post(new DummyPost(msg), cb);
		},
		function(a, cb) {
			assert.equal(a, 'xxxx');
			closeTest(client, server, cb);
		}
	], done);
});

it('should return error if reconnect completely fails during a request', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.close(); // reject all future connect attempts
			currentServer = null;
			// send req
			server.expect('DATE\r\nDATE\r\n', function() {
				this.expect('DATE\r\nDATE\r\n', '111 20110204060810\r\n111 20120204060810');
				this.drop();
			});
			var called = 0;
			client.date(function(err, date) {
				assert.equal(called++, 0);
				assert(!date);
				assert.equal(err.code, 'connect_fail');
				assert.equal(client.state, 'inactive');
			});
			client.date(function(err, date) {
				assert.equal(called++, 1);
				assert(!date);
				assert.equal(err.code, 'connect_fail');
				assert.equal(client.state, 'inactive');
				cb();
			});
		}
	], done);
});

it('should work if requesting whilst disconnected without pending connect', function(done) {
	var server, client;
	waterfall([
		setupTest.bind(null, {connTimeout: 20, connectRetries: 1, reconnectDelay: 10}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.close(); // reject all future connect attempts
			server.drop();
			currentServer = null;
			
			// wait after all reconnect attempts have been tried
			setTimeout(function() {
				assert.equal(client.state, 'inactive');
				server.listen(lastServerPort, cb);
			}, 100);
		},
		function(cb) {
			server.expect('DATE\r\nDATE\r\n', '111 20110204060810\r\n111 20120204060810');
			var called = 0;
			client.date(function(err, date) {
				assert.equal(called++, 0);
				assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
				assert.equal(client.state, 'connected');
			});
			client.date(function(err, date) {
				assert.equal(called++, 1);
				assert.equal(date.toString(), (new Date('2012-02-04 06:08:10')).toString());
				assert.equal(client.state, 'connected');
				closeTest(client, server, cb);
			});
			assert.equal(client.state, 'connecting');
		}
	], done);
});

it('should deal with connection timeouts', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			// simulate a connection timeout by hijacking the connect method, so that it does nothing on the first call
			var net = require('net');
			var realConnect = net.connect;
			net.connect = function() {
				net.connect = realConnect;
				return newFakeConn();
			};
			
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should do nothing on an idle too long message');

it('should retry reconnecting if it only fails once', function(done) {
	var server, client;
	waterfall([
		killServer,
		function(cb) {
			// we don't start a server so that the connect fails, but start it up a while after so that the retry should succeed
			lastServerPort = 53151;
			var server, client = newNNTP();
			var emitted = false;
			var s = Date.now();
			client.connect(function(err) {
				var timeTaken = Date.now() - s;
				assert(timeTaken >= 300); // reconnect delay should be 300ms
				assert(timeTaken <= 800); // ...but less than 800ms (delay + timeout)
				assert(server);
				cb(err, server, client);
			});
			setTimeout(function() {
				server = new TestServer(function() {
					server.respond('200 host test server');
				});
				server.listen(lastServerPort, function() {});
				currentServer = server;
				
				if(!client.numErrors)
					client.socket.emit('error', 1); // workaround for systems that take a while to emit the connect fail error
			}, 150);
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			server.expect('DATE\r\n', '111 20110204060810');
			client.date(cb);
		},
		function(date, cb) {
			assert.equal(date.toString(), (new Date('2011-02-04 06:08:10')).toString());
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should retry reconnecting if init sequence fails', function(done) {
	var server, client;
	waterfall([
		killServer,
		function(cb) {
			var dropped = false;
			var s = Date.now();
			var server = new TestServer(function() {
				// first connection = drop, otherwise continue
				if(dropped) {
					var timeTaken = Date.now() - s;
					assert(timeTaken >= 300); // reconnect delay should be 300ms
					assert(timeTaken <= 800); // ...but less than 800ms (delay + timeout)
					server.respond('200 host test server');
				} else {
					server.drop();
					dropped = true;
				}
			});
			server.listen(0, function() {
				cb(null, server, newNNTP());
			});
			currentServer = server;
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should retry on timeout during init sequence', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			client.opts.user = 'nyuu';
			client.opts.password = 'iamreallylucy';
			server.expect('AUTHINFO USER nyuu\r\n', function() {
				assert.equal(client.state, 'authenticating');
				this.expect('AUTHINFO PASS iamreallylucy\r\n', function() {
					// do nothing to timeout
					this.expect('AUTHINFO USER nyuu\r\n', function() {
						this.expect('AUTHINFO PASS iamreallylucy\r\n', '281 User logged in');
						this.respond('381 Give AUTHINFO PASS command');
					});
				});
				this.respond('381 Give AUTHINFO PASS command');
			});
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});
it('should throw error on auth failure');
it('should throw error if selected group fails on connect');

it('test handling of connection failure if init sequence almost completes', function(done) {
	var server, client;
	waterfall([
		killServer,
		function(cb) {
			var dropped = false;
			var s = Date.now();
			var server = new TestServer(function() {
				// first connection = drop right after sending a response, otherwise continue
				if(dropped) {
					var timeTaken = Date.now() - s;
					assert(timeTaken >= 300); // reconnect delay should be 300ms
					assert(timeTaken <= 800); // ...but less than 800ms (delay + timeout)
					server.respond('200 host test server');
				} else {
					server.respond('200 host test server');
					server.drop();
					dropped = true;
				}
			});
			server.listen(0, function() {
				cb(null, server, newNNTP());
			});
			currentServer = server;
		},
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			
			client.connect(cb);
		},
		function(cb) {
			assert.equal(client.state, 'connected');
			closeTest(client, server, cb);
		}
	], done);
});

it('should retry on a single auth failure');

it('should warn on unexpected spurious data received');
it('should deal with unexpected 200 messages by reconnecting (keepalive=1)', function(done) {
	var server, client, ct;
	waterfall([
		setupTest.bind(null, {keepAlive: true}),
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			ct = server.connectedTime;
			server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
			tl.defer(function() {
				client.stat(1, cb);
			});
		},
		function(a, cb) {
			server.respond('200 Welcome');
			// client should now reconnect
			tl.defer(cb);
		}, function(cb) {
			assert.notEqual(server.connectedTime, ct);
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should deal with 200 responses by reconnecting', function(done) {
	var server, client, ct;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			ct = server.connectedTime;
			server.expect('STAT 1\r\n', function() {
				this.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
				this.respond('200 Welcome'); // client should drop now
			});
			tl.defer(function() {
				client.stat(1, cb);
			});
		},
		function(a, cb) {
			assert.equal(client.state, 'connected');
			assert.equal(a[0], 1);
			assert.notEqual(server.connectedTime, ct);
			
			closeTest(client, server, cb);
		}
	], done);
});
it('should deal with unexpected 200 messages by disconnecting (keepalive=0)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			server.expect('STAT 1\r\n', '223 1 <some-post> article retrieved');
			tl.defer(function() {
				client.stat(1, cb);
			});
		},
		function(a, cb) {
			server.respond('200 Welcome');
			// client should now disconnect
			tl.defer(cb);
		}, function(cb) {
			assert.equal(client.state, 'inactive');
			
			closeTest(client, server, cb);
		}
	], done);
});

it('should give up after max reconnect retries hit', function(done) {
	var server, client;
	var connectAttempts = 0;
	waterfall([
		killServer,
		function(cb) {
			server = new TestServer(function() {
				connectAttempts++;
				// don't respond, will timeout
			});
			server.listen(0, function() {
				client = newNNTP();
				cb(null);
			});
			currentServer = server;
		},
		function(cb) {
			client.connect(tl.fn1(function(err) {
				tl.defer(function() {
					assert.equal(err.code, 'connect_fail');
					assert.equal(connectAttempts, 2);
					closeTest(client, server, cb);
				});
			}));
		}
	], done);
});
it('should give up after max reconnect retries hit (lazy connect)', function(done) {
	var server, client;
	var connectAttempts = 0;
	waterfall([
		killServer,
		function(cb) {
			server = new TestServer(function() {
				connectAttempts++;
				// don't respond, will timeout
			});
			server.listen(0, function() {
				client = newNNTP();
				cb(null);
			});
			currentServer = server;
		},
		function(cb) {
			client.date(tl.fn1(function(err) {
				tl.defer(function() {
					assert.equal(err.code, 'connect_fail');
					assert.equal(connectAttempts, 2);
					closeTest(client, server, cb);
				});
			}));
		}
	], done);
});
// TODO: ^ also test that this reconnect counter is reset after a successful connect

it('should give up after max request retries hit', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var allDone = false;
			server.expect('STAT 1\r\n', function() {
				async.timesSeries(5, function(n, cb) {
					server.expect('STAT 1\r\n', cb);
					server.drop();
				}, function(err) {
					if(err) throw err;
					allDone = true;
				});
			});
			client.stat(1, function(err) {
				assert(allDone);
				assert.equal(err.code, 'timeout');
				cb();
			});
		}, function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});
it('should give up after max request retries hit (post timeout)', function(done) {
	var server, client;
	waterfall([
		setupTest,
		function(_server, _client, cb) {
			server = _server;
			client = _client;
			client.connect(cb);
		},
		function(cb) {
			var allDone = false;
			var msg = 'My-Secret: not telling\r\n\r\nNyuu breaks free again!\r\n.\r\n';
			async.timesSeries(6, function(n, cb) {
				server.expect('POST\r\n', function() {
					this.expect(msg, cb);
					this.respond('340  Send article');
				});
			}, function(err) {
				if(err) throw err;
				allDone = true;
			});
			client.post(new DummyPost(msg), function(err, messageId) {
				assert.equal(err.code, 'timeout');
				assert(messageId); // should still return the message-id because we accepted the POST request
				assert(allDone);
				cb();
			});
		}, function(cb) {
			closeTest(client, server, cb);
		}
	], done);
});
it('should give up after max post retries hit');

it('should deal with a connection drop after receiving partial data');
it('should deal with the case of newlines being split across packets'); // or in unfortunate positions

it('should deal with socket errors');
it('should deal with a socket error during connect');
// TODO: connect() callback shouldn't be called on first error?

// TODO: consider testing recoverability after an error occurrence?

// TODO: test onPostTimeout hacks

});
