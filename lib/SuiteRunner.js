/*global output console require exports*/

require('./array.js');
require('./string.js');
var p_req = require('../modules/request');
var p_assert = require('../modules/assert-extras');
var p_url = require('./url.js');
var p_u = require('./util.js');
var p_log = require('./Logger.js');

/********************************************************************************
 * Suite Runner
 *
 * Options passed on construct can be:
 *
 * verbose                  Display verbose output
 * host                     Default host to use if not specified
 * port                     Default port to use if not specified
 * log                      An optional Logger object to use for logging
 * loadTest                 LoadTester object if there is one available
 *
 * Each object in the suite can have the following properties:
 *
 * test                     Name for the test if it is a test
 *
 * template                 Name for the template if it is a template
 *
 * dependsOn                Name or array of test names that this test is dependent on finishing first
 *
 * get/post/put/del         Issue http request, either get, post, put, del
 *                          If a function is specified it is evaluated and return value used as url, just prior to invocation
 *
 * data                     Body to send with the request, can be a function
 *
 * expectCode               The http response code expected
 *
 * expectJSON               The body of the response is parsed as JSON, if an object is specified, they are compared, if a function is specied
 *                          the function is called with (obj) where obj is the response body JSON object
 *
 * setup                    A function, if specified, that will be run on start of the test
 *
 * teardown                 A function, if specified, that will be run on end of the test
 *
 * expect                   Called for any usage of this.callback.  Can be a function or an object.  If an object then
 *                          each property is a text description of the case being checked and the value is a function
 *                          to call.
 *
 * wait                     Number of milliseconds to wait before starting (after dependencies execute)
 *
 ******* All callbacks are called with the this reference set to an object with the following properties:
 *
 * responses                An object, each property name is the name of a test, the value is an array of API responses
 *
 * log                      A logging object whose methods are:
 *                          error, info, warning, good - pass a message as parameter
 *                          output(type, msg) - type is a string for type of message, and msg is some object
 *
 * callback                 A function that returns a callback to be used as where needed, see the 'expect' property above
 *
 * assert                   An object with the standard ASSERT methods:
 *                          assert.isNull(value, message)
 *                          assert.isNotNull(value, message)
 *                          assert.isTypeOf(value, type, message)
 *                          assert.isNotTypeOf(value, type, message)
 *                          assert.isObject(value, message)
 *                          assert.isFunction(value, message)
 *                          assert.isString(value, message)
 *                          assert.isNumber(value, message)
 *                          assert.isBoolean(value, message)
 *                          assert.isUndefined(value, message)
 *                          assert.isNotUndefined(value, message)
 *                          assert.isArray(value, message)
 *                          assert.isNaN(value, message)
 *                          assert.isNotNaN(value, message)
 *                          assert.match(value, pattern, message)
 *                          assert.noMatch(value, pattern, message)
 *                          assert.isPrototypeOf(proto, object, message)
 *                          assert.isNotPrototypeOf(proto, object, message)
 *
 * loadTest                 Reference to the LoadRunner object in context if available
 */
function SuiteRunner(suite, options)
{
    var self = this;
    var _log = (options && options.log) || new p_log.Logger();

    var _responses = {};
    var _suite = suite;
    var _options = p_u.clone(options) || {};

    self.responses = _responses;
    self.assert = p_assert;
    self.log = _log;
    self.loadTest = _options.loadTest;
    self.params = _options.params || {};


    // Maps a test name to an object which has properties:
    //
    // test         The user specified test object
    // deps         Current list of tests that are dependant on this test
    // depcount     The current count of tests that this test is dependant on
    // repeat       The current number of times to repeat the test
    // started      Whether the test has been started at least once

    var _testdata = {};

    // Maps a template name to a template object
    var _tempmap = {};

    var _completed = 0;
    var _success = 0;
    var _testcount = 0;
    var _requests = [];
    var _quitting = false;

    /********************************************************************************
     * helpers
     */
    function info(msg)
    {
        if (!isVerbose())
        {
            return;
        }

        _log.info(msg);
    }

    function error(msg)
    {
        _log.error(msg);
    }

    function success(msg)
    {
        _log.good(msg);
    }

    function isVerbose()
    {
        return hasProp(_options, 'verbose') && _options['verbose'];
    }

    function prop(o, name, def)
    {
        if (name in o)
            return o[name];
        else
            return def;
    }

    function propOrFunc(t, name, def)
    {
        var p = prop(t, name, def);
        if (p)
        {
            if (p_u.isFunction(p))
                return callfunc(p, t);
            else
                return p;
        }

        return null;
    }

    function hasProp(o, name)
    {
        return name in o;
    }


    function init()
    {
        var nondep = [];

        // Build test map
        _suite.forEach(function(o)
        {
            var testname = prop(o, 'test');
            var tempname = prop(o, 'template');
            var dep = p_u.toArray(prop(o, 'dependsOn'));

            if (tempname)
            {
                _tempmap[tempname] = o;
            } else if (testname)
            {
                _testdata[testname] = {test:o, deps:[], depcount:0, started:false, callbackCount:0,isJSON:false};
                _testcount++;

                if (dep.length > 0)
                {
                    _testdata[testname].depcount = dep.length;
                    dep.forEach(function(d)
                    {
                        _testdata[d].deps.push(o);
                    });
                }
                else
                    nondep.push(o);
            }
        });
        // return all with no dep
        return nondep;
    }

    function genHttpFunc(t, f)
    {
        return genCallback(f, t);
    }

    function genCallback(f)
    {
        var fnc = f;
        var args = [];
        for (var i = 1; i < arguments.length; i++)
            args.push(arguments[i]);
        return function()
        {
            for (var i = 0; i < arguments.length; i++)
                args.push(arguments[i]);

            fnc.apply(null, args);
        };
    }

    function testExcMsg(e)
    {
        if (e.name && e.name.match(/AssertionError/))
            return e.toString();
        else
            return e.message;
    }

    // checks test against criteria taking into account inheritance
    // returns null on success or the error message if fail
    function checkTest(t, codeRes, args)
    {
        var isa = p_u.toArray(prop(t, 'isA'));

        for (var i = 0; i < isa.length; i++)
        {
            var temp = isa[i];

            if (!( temp in _tempmap))
                return 'Unknown template \'' + temp + '\'';

            var tmp = _tempmap[temp];

            var res = checkTest(tmp, codeRes, args);

            if (res != null)
                return res;
        }

        var code = prop(t, 'expectCode');
        var jsono = prop(t, 'expectJSON');
        var exp = prop(t, 'expect');

        if (code)
        {
            if (codeRes != code)
            {
                return 'Result was ' + codeRes + ', expected ' + code;
            }
        }
        if (jsono)
        {
            try
            {
                p_assert.deepEqual(jsono, args[0]);
            } catch(e)
            {
                return testExcMsg(e);
            }
        }
        if (exp)
        {
            if (p_u.isFunction(exp))
            {
                try
                {
                    callfuncA(exp, t, args);
                }
                catch(e)
                {
                    return testExcMsg(e);
                }
            }
            else if (p_u.isObject(exp))
            {
                for(var p in exp)
                {
                    try
                    {
                        callfuncA(exp[p], t, args);
                    }
                    catch(e)
                    {
                        return p + ', ' + testExcMsg(e);
                    }
                }
            }
        }

        return null;
    }

    function responseIsJSON(res)
    {
        if (!('content-type' in res.headers))
            return false;

        var type = res.headers['content-type'].split(';')[0];

        return type == 'application/json' || 'text/javascript';
    }

    function handleHttp(t, err, res, body)
    {
        // Requests not aborting?
        if (_quitting)
            return;

        if (err)
        {
            finishTest(t, 'Unexpected error making request: ' + err.message);
            return;
        }

        var obj;
        if (responseIsJSON(res) && p_u.isString(body) && t.isJSON)
            obj = JSON.parse(body);
        else
            obj = body;

        if (!(t.test in _responses))
            _responses[t.test] = [];

        _responses[t.test].push(obj);

        finishTest(t, checkTest(t, res.statusCode, [obj]));
    }

    function abortRequests()
    {
        // todo, remove finished requests as they stop so this is less brutal
        while (_requests.length > 0)
        {
            var req = _requests.pop();

            try
            {
                req.abort();
            } catch(e)
            {

            }
        }
    }

    function parseUrl(str)
    {
        var u = new p_url.URL(str);
        if (!u.host)
            u.host = _options.host;
        if (!u.port)
            u.port = _options.port;

        return u.toString();
    }

    function handleCallbacks(t)
    {
        t.callbackCount--;

        // Check result, if a failure or this is the last callback then finish
        var err = checkTest(t, null, null, Array.prototype.slice.call(arguments, 1));
        if (err || !t.callbackCount)
            finishTest(t, err);
    }


    function callfunc(f, t)
    {
        var a = [];
        for(var i=2;i<arguments.length;i++)
            a.push(arguments[i]);

        return callfuncA(f, t, a);
    }

    function callfuncA(f, t, a)
    {
        if (!f)
            return;

        var thistest = t;

        // Set up callback
        self.__defineGetter__('callback', function()
        {
            _testdata[thistest.test].callbackCount++;

            return genCallback(handleCallbacks, thistest);
        });

        return f.apply(self, a);
    }

    function startTest(t)
    {
        info('starting: ' + t.test);

        try
        {
            var url;
            var meth;
            var td = _testdata[t.test];
            var start = prop(t, 'setup');
            var data = propOrFunc(t, 'data');

            if (!td.started)
            {
                var count = propOrFunc(t, 'repeat', 1);
                td.repeat = count;
                td.started = true;
            }

            callfunc(start, t);

            ['put', 'post', 'get', 'del', 'putJSON', 'postJSON', 'getJSON', 'delJSON'].first(function(el)
            {
                var u = propOrFunc(t, el);
                if (u)
                {
                    url = u;
                    if (el.endsWith('JSON'))
                    {
                        t.isJSON = true;
                        meth = el.substr(0, el.length - 4).toUpperCase();
                    }
                    else
                        meth = el.toUpperCase();

                    return true;
                }
            });
            if (url)
            {
                url = parseUrl(url);
                info(meth + ' ' + url.toString());
                var params = {
                    uri : url, method : meth
                };
                if (data)
                {
                    if (p_u.isObject(data))
                        params.json = data;
                    else
                        params.body = data;
                }
                _requests.push(p_req(params, genHttpFunc(t, handleHttp)));
            }
            else if (td.callbackCount == 0)
                finishTest(t);

        } catch(e)
        {
            finishTest(t, testExcMsg(e));
        }
    }


    function finishSuite()
    {
        self._quitting = true;

        abortRequests();

        if (self._fncComplete)
            self._fncComplete(_success, _testcount - _success, _testcount - _completed, self.log);
    }

    function finishTest(t, failmsg)
    {
        var name = prop(t, 'test');
        var td = _testdata[name];

        var res = {
            test : name
        };
        if (failmsg)
        {
            res.err = failmsg;
            error('✗ ' + name + ' failed, ' + failmsg);
        }
        else
        {
            _success++;
            success('✓ ' + name);
        }

        callfunc(t.teardown, t);

        // Repeat if needed
        if (--td.repeat)
        {
            startTest(t);
        }
        else
        {
            _completed++;

            if (_completed == _testcount)
            {
                finishSuite();
            } else if (_testdata[name].deps.length > 0)
            {
                // We have dependencies, if this test failed then abort suite (todo: continue parallel tests)
                if (failmsg)
                    finishSuite();

                var deps = _testdata[name].deps;

                var ready = [];
                // For each dependent test, decrement its dep count
                deps.forEach(function(d)
                {
                    if (--_testdata[d.test].depcount == 0)
                        ready.push(d);
                });

                // Get rid of us from the deps
                _testdata[name].deps = [];

                // signal waiting
                startBatch(ready);
            }
        }
    }

    function startBatch(batch)
    {
        batch.forEach(function(t)
        {
            if (t.wait)
                setTimeout(genCallback(startTest, t), t.wait);
            else
                startTest(t);
        });
    }


    this.run = function(fnc)
    {
        self._fncComplete = fnc;

        try
        {
            var tests = init();
            if (!tests.length)
                throw 'No tests without dependencies exist';

            startBatch(tests);
        } catch(e)
        {
            if (e.message)
            {
                error(e.message);
                error(e.stack);
            }
            else
                error(e);
        }

    };

    // Copy context if specified
    if ('context' in  _options)
    {
        p_u.copyPrototype(this, _options.context);
    }

}

exports.SuiteRunner = SuiteRunner;

