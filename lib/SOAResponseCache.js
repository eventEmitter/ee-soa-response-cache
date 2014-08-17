!function(){
    'use strict';

    var   Class         = require('ee-class')
        , type          = require('ee-types')
        , log           = require('ee-log')
        , crypto        = require('crypto')
        , LRUCache      = require('ee-lru-cache')
        , Memcached     = require('memcached');



    module.exports = new Class({

        // header that must not be stored in the cache
        _nonCacheableHeaders: {
              'content-length': true
            , date: true
            , server: true
        }

        , init: function(options) {
            this._filter = {};

            if (options.servers) {
                this._memcached = new Memcached(options.servers, {
                      timeout   : 500
                    , idle      : 60000
                    , retries   : 1
                    , failures  : 20
                    , reconnect : 60000
                });
            }
            else log.warn('The soa-request cache didn\'t get any memcached servers to work on :(');

            // local cache
            this._lru = new LRUCache({
                  limit     : 10000
                , ttl       : 60000
                , forceTtl  : true
            });
        }


        , cache: function(method, path, options) {
            method = method.trim().toLowerCase();

            if (!this._filter[method]) {
                this._filter[method] = {
                      reg:  []
                    , path: {}
                };
            }

            if (type.string(path)) this._filter[method].path[path.toLowerCase()] = options;
            else if (type.regexp(path)) {
                this._filter[method].reg.push({
                      reg       : path
                    , options   : options
                });
            }
            else throw new Error('Path must be typeof regexp or string, got «'+type(path)+'»!');
        }



        , request: function(request, response, next) {
            var   method = request.method
                , options;

            if (this._filter[method]) {
                if (this._filter[method].path[request.pathname]) {
                    // path match, test headers
                    this._testOptions(request, response, next, this._filter[method].path[request.pathname]);
                }
                else if(this._filter[method].reg.some(function(config) {
                    if (config.reg.test(request.pathname)) {
                        options = config.options;
                        return true;
                    }
                    else return false;
                }.bind(this))) {
                    // regexp matched, test headers
                    this._testOptions(request, response, next, options);
                }
                else next();
            }
            else next();
        }



        , _testOptions: function(request, response, next, options) { //log.info('testing options for %s', request.pathname);
            var   headers
                , cacheKeyObject
                , cacheKey;

            if (options.headers) {
                headers = request.getHeaders();
                cacheKeyObject = {};

                if (Object.keys(options.headers).some(function(headerName) {
                    var header = options.headers[headerName];

                    if (header === true) {
                        // has to be the same as the cached one
                        cacheKeyObject[headerName] = headers[headerName];
                        return false;
                    }
                    else if (header === false) {
                        // header must not be present!
                        return !!headers[headerName];
                    }
                    else if (type.string(header)) {
                        // has to match exactly, must be added to the cache key
                        cacheKeyObject[headerName] = headers[headerName];
                        return header.trim().toLowerCase() != headers[headerName].trim().toLowerCase();
                    }
                    else if (header.test) {
                        // must pass the regexp test, must be added to the cache key
                        cacheKeyObject[headerName] = headers[headerName];
                        return !header.test(headers[headerName]);
                    }
                    else {
                        throw new Error('Invalid header matcher! must be false, true or regexp. is typeof «'+type(header)+'»!');
                    }
                })) {
                    // mismatch, skip
                    //log.warn('mismatch');
                    next();
                }
                else { //log.info('match');
                    /* 
                     * the request qualifies for caching
                     * build the cache key, check if there is somthing in the cache, 
                     * else fetch from the server, store in cache
                     */ 

                    //log(cacheKeyObject);

                    cacheKey = request.method + (options.language ? request.language : '') + request.pathname + Object.keys(cacheKeyObject).sort().reduce(function(previous, key) {return previous+cacheKeyObject[key];});

                    // need a short representation
                    cacheKey = crypto.createHash('sha1').update(cacheKey).digest('HEX');

                    //log.info('cacheKey', cacheKey);
                    var start = Date.now();

                    // check th elocal cache
                    if (this._lru.has(cacheKey)) { 
                        //log.info('returned after %s ms ...', Date.now()-start);
                        //log.info('cache hit on %s :)', request.pathname);
                        // cache hit :)
                        this._sendResponse(response, this._lru.get(cacheKey));
                    }
                    else {
                        // lookup, if servers are present
                        if (this._memcached) {
                            this._memcached.get(cacheKey, function(err, data) { //log.info('returned after %s ms ...', Date.now()-start);
                                if (err) {
                                    log.warn('memcached failed: '+err.message);
                                    next();
                                }
                                else if ( data) { //log.info('cache hit on %s :)', request.pathname);  
                                    this._lru.set(cacheKey, data);

                                    this._sendResponse(response, data);
                                }
                                else { //log.info('cache miss, collecting data');
                                    // cache miss
                                    response.once('send', function(status, compressedData, isCompressed) {
                                        if (options.status && status == options.status) return;
                                        else {
                                            var   headers = response.getHeaders()
                                                , cacheObject;

                                            Object.keys(headers).forEach(function(name) {
                                                if (this._nonCacheableHeaders[name.toLowerCase()]) delete headers[name];                                    
                                            }.bind(this));

                                            // format data as required
                                            cacheObject = {
                                                  data          : compressedData
                                                , headers       : response.getHeaders()
                                                , isCompressed  : isCompressed
                                                , status        : status
                                            };

                                            // store locally
                                            this._lru.set(cacheKey, cacheObject);


                                            // store in cache
                                            this._memcached.set(cacheKey, cacheObject, (options.ttl || 300), function(err) {
                                                if (err) log.warn('memcached failed: '+err.message);
                                            }.bind(this));                                    
                                        }
                                    }.bind(this));

                                    // pass through, we're waiting for the response to arrive
                                    next();
                                }
                            }.bind(this));
                        }
                        else next();
                    }   
                }
            }
            else next();
        }




        , _sendResponse: function(response, data) {
            var responseData = Buffer.isBuffer(data.data) ? data.data : new Buffer(data.data);

            if (data.isCompressed) response.sendCompressed(responseData, data.headers, data.status);
            else response.sendUncompressed(responseData, data.headers, data.status);
        }
    });
}();