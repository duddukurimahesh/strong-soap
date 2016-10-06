var g = require('../globalize');
var sax = require('sax');
var HttpClient = require('./../http');
var fs = require('fs');
var url = require('url');
var path = require('path');
var assert = require('assert');
var stripBom = require('../strip-bom');
var debug = require('debug')('strong-soap:wsdl');
var _ = require('lodash');
var selectn = require('selectn');
var utils = require('./helper');
var EMPTY_PREFIX = utils.EMPTY_PREFIX;

var QName = require('./qname');
var Definitions = require('./wsdl/definitions');
var Schema = require('./xsd/schema');
var Types = require('./wsdl/types');
var Element = require('./element');

class WSDL {
  constructor(definition, uri, options) {
    this.content = definition;
    assert(this.content != null && (typeof this.content === 'string' ||
      typeof this.content === 'object'),
      'WSDL constructor takes either an XML string or definitions object');
    this.uri = uri;
    this._includesWsdl = [];

    // initialize WSDL cache
    this.WSDL_CACHE = (options || {}).WSDL_CACHE || {};
    this._initializeOptions(options);
  }

  load(callback) {
    var self = this;
    var definition = this.content;
    let fromFunc;
    if (typeof definition === 'string') {
      definition = stripBom(definition);
      fromFunc = this._fromXML;
    }
    else if (typeof definition === 'object') {
      fromFunc = this._fromServices;
    }

    process.nextTick(function() {
      try {
        fromFunc.call(self, definition);
      } catch (e) {
        return callback(e);
      }

      self.processIncludes(function(err) {
        var name;
        if (err) {
          return callback(err);
        }

        var schemas = self.definitions.schemas;
        for (let s in schemas) {
          schemas[s].postProcess(self.definitions);
        }
        var services = self.services = self.definitions.services;
        if (services) {
          for (let s in services) {
            services[s].postProcess(self.definitions);
          }
        }

        // for document style, for every binding, prepare input message
        // element name to (methodName, output message element name) mapping
        var bindings = self.definitions.bindings;
        for (var bindingName in bindings) {
          var binding = bindings[bindingName];
          if (binding.style == null) {
            binding.style = 'document';
          }
          if (binding.style !== 'document')
            continue;
          var operations = binding.operations;
          var topEls = binding.topElements = {};
          for (var methodName in operations) {
            if (operations[methodName].input) {
              var inputName = operations[methodName].input.$name;
              var outputName = "";
              if (operations[methodName].output)
                outputName = operations[methodName].output.$name;
              topEls[inputName] = {
                "methodName": methodName,
                "outputName": outputName
              };
            }
          }
        }

        // prepare soap envelope xmlns definition string
        self.xmlnsInEnvelope = self._xmlnsMap();
        callback(err, self);
      });

    });
  }

  _initializeOptions(options) {
    this._originalIgnoredNamespaces = (options || {}).ignoredNamespaces;
    this.options = {};

    var ignoredNamespaces = options ? options.ignoredNamespaces : null;

    if (ignoredNamespaces &&
      (Array.isArray(ignoredNamespaces.namespaces) ||
      typeof ignoredNamespaces.namespaces === 'string')) {
      if (ignoredNamespaces.override) {
        this.options.ignoredNamespaces = ignoredNamespaces.namespaces;
      } else {
        this.options.ignoredNamespaces =
          this.ignoredNamespaces.concat(ignoredNamespaces.namespaces);
      }
    } else {
      this.options.ignoredNamespaces = this.ignoredNamespaces;
    }

    this.options.valueKey = options.valueKey || this.valueKey;
    this.options.xmlKey = options.xmlKey || this.xmlKey;

    // Allow any request headers to keep passing through
    this.options.wsdl_headers = options.wsdl_headers;
    this.options.wsdl_options = options.wsdl_options;

    if (options.httpClient) {
      this.options.httpClient = options.httpClient;
    }

    var ignoreBaseNameSpaces = options ? options.ignoreBaseNameSpaces : null;
    if (ignoreBaseNameSpaces !== null &&
      typeof ignoreBaseNameSpaces !== 'undefined')
      this.options.ignoreBaseNameSpaces = ignoreBaseNameSpaces;
    else
      this.options.ignoreBaseNameSpaces = this.ignoreBaseNameSpaces;
  }

  _processNextInclude(includes, callback) {
    var self = this,
      include = includes.shift(),
      options;

    if (!include)
      return callback();

    var includePath;
    if (!/^https?:/.test(self.uri) && !/^https?:/.test(include.location)) {
      includePath = path.resolve(path.dirname(self.uri), include.location);
    } else {
      includePath = url.resolve(self.uri, include.location);
    }

    options = _.assign({}, this.options);
    // follow supplied ignoredNamespaces option
    options.ignoredNamespaces = this._originalIgnoredNamespaces || this.options.ignoredNamespaces;
    options.WSDL_CACHE = this.WSDL_CACHE;

    WSDL.load(includePath, options, function(err, wsdl) {
      if (err) {
        return callback(err);
      }

      self._includesWsdl.push(wsdl);

      if (wsdl.definitions instanceof Definitions) {
        _.mergeWith(self.definitions, wsdl.definitions, function(a, b) {
          return (a instanceof Schema) ? a.merge(b) : undefined;
        });
      } else {
        self.definitions.schemas[include.namespace ||
        wsdl.definitions.$targetNamespace] =
          deepMerge(self.definitions.schemas[include.namespace ||
          wsdl.definitions.$targetNamespace], wsdl.definitions);
      }
      self._processNextInclude(includes, function(err) {
        callback(err);
      });
    });
  }

  processIncludes(callback) {
    var schemas = this.definitions.schemas,
      includes = [];

    for (var ns in schemas) {
      var schema = schemas[ns];
      includes = includes.concat(schema.includes || []);
    }

    this._processNextInclude(includes, callback);
  }

  describeServices() {
    var services = {};
    for (var name in this.services) {
      var service = this.services[name];
      services[name] = service.describe(this.definitions);
    }
    return services;
  }

  toXML() {
    return this.xml || '';
  }

  xmlToObject(xml) {
    return root;
  }

  _parse(xml) {
    var self = this,
      p = sax.parser(true),
      stack = [],
      root = null,
      types = null,
      schema = null,
      options = self.options;

    p.onopentag = function(node) {
      debug('Start element: %j', node);
      var nsName = node.name;
      var attrs = node.attributes;

      var top = stack[stack.length - 1];
      var name;
      if (top) {
        try {
          top.startElement(stack, nsName, attrs, options);
        } catch (e) {
          debug("WSDL error: %s ", e.message);
          if (self.options.strict) {
            throw e;
          } else {
            stack.push(new Element(nsName, attrs, options));
          }
        }
      } else {
        name = QName.parse(nsName).name;
        if (name === 'definitions') {
          root = new Definitions(nsName, attrs, options);
          stack.push(root);
        } else if (name === 'schema') {
          // Shim a structure in here to allow the proper objects to be
          // created when merging back.
          root = new Definitions('definitions', {}, {});
          types = new Types('types', {}, {});
          schema = new Schema(nsName, attrs, options);
          types.addChild(schema);
          root.addChild(types);
          stack.push(schema);
        } else {
          throw new Error(g.f('Unexpected root element of {{WSDL}} or include'));
        }
      }
    };

    p.onclosetag = function(name) {
      debug('End element: %s', name);
      var top = stack[stack.length - 1];
      assert(top, 'Unmatched close tag: ' + name);

      top.endElement(stack, name);
    };

    debug('WSDL xml: %s', xml);
    p.write(xml).close();

    return root;
  };

  _fromXML(xml) {
    this.definitions = this._parse(xml);
    this.xml = xml;
  }

  _fromServices(services) {
  }

  _xmlnsMap() {
    var xmlns = this.definitions.xmlns;
    var str = '';
    for (var prefix in xmlns) {
      if (prefix === '' || prefix === EMPTY_PREFIX)
        continue;
      var ns = xmlns[prefix];
      switch (ns) {
        case "http://xml.apache.org/xml-soap" : // apachesoap
        case "http://schemas.xmlsoap.org/wsdl/" : // wsdl
        case "http://schemas.xmlsoap.org/wsdl/soap/" : // wsdlsoap
        case "http://schemas.xmlsoap.org/wsdl/soap12/": // wsdlsoap12
        case "http://schemas.xmlsoap.org/soap/encoding/" : // soapenc
        case "http://www.w3.org/2001/XMLSchema" : // xsd
          continue;
      }
      if (~ns.indexOf('http://schemas.xmlsoap.org/'))
        continue;
      if (~ns.indexOf('http://www.w3.org/'))
        continue;
      if (~ns.indexOf('http://xml.apache.org/'))
        continue;
      str += ' xmlns:' + prefix + '="' + ns + '"';
    }
    return str;
  };

  /*
   * Have another function to load previous WSDLs as we
   * don't want this to be invoked externally (expect for tests)
   * This will attempt to fix circular dependencies with XSD files,
   * Given
   * - file.wsdl
   *   - xs:import namespace="A" schemaLocation: A.xsd
   * - A.xsd
   *   - xs:import namespace="B" schemaLocation: B.xsd
   * - B.xsd
   *   - xs:import namespace="A" schemaLocation: A.xsd
   * file.wsdl will start loading, import A, then A will import B, which will then import A
   * Because A has already started to load previously it will be returned right away and
   * have an internal circular reference
   * B would then complete loading, then A, then file.wsdl
   * By the time file A starts processing its includes its definitions will be already loaded,
   * this is the only thing that B will depend on when "opening" A
   */
  static load(uri, options, callback) {
    var fromCache,
      WSDL_CACHE;

    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    WSDL_CACHE = options.WSDL_CACHE;

    if (fromCache = WSDL_CACHE[uri]) {
      return callback.call(fromCache, null, fromCache);
    }

    return WSDL.open(uri, options, callback);
  }

  static open(uri, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    // initialize cache when calling open directly
    var WSDL_CACHE = options.WSDL_CACHE || {};
    var request_headers = options.wsdl_headers;
    var request_options = options.wsdl_options;

    debug('wsdl open. request_headers: %j request_options: %j', request_headers, request_options);
    var wsdl;
    if (!/^https?:/.test(uri)) {
      debug('Reading file: %s', uri);
      fs.readFile(uri, 'utf8', function(err, definition) {
        if (err) {
          callback(err);
        }
        else {
          wsdl = new WSDL(definition, uri, options);
          WSDL_CACHE[uri] = wsdl;
          wsdl.WSDL_CACHE = WSDL_CACHE;
          wsdl.load(callback);
        }
      });
    }
    else {
      var httpClient = options.httpClient || new HttpClient(options);
      httpClient.request(uri, null /* options */,
        function(err, response, definition) {
          if (err) {
            callback(err);
          } else if (response && response.statusCode === 200) {
            wsdl = new WSDL(definition, uri, options);
            WSDL_CACHE[uri] = wsdl;
            wsdl.WSDL_CACHE = WSDL_CACHE;
            wsdl.load(callback);
          } else {
            callback(new Error(g.f('Invalid {{WSDL URL}}: %s\n\n\r Code: %s' +
              "\n\n\r Response Body: %j", uri, response.statusCode, response.body)));
          }
        }, request_headers, request_options);
    }

    return wsdl;
  }

  static loadSystemSchemas(callback) {
    var xsdDir = path.join(__dirname, '../../xsds/');
    var done = false;
    fs.readdir(xsdDir, function(err, files) {
      if (err) return callback(err);
      var schemas = {};
      var count = files.length;
      files.forEach(function(f) {
        WSDL.open(path.join(xsdDir, f), {}, function(err, wsdl) {
          if (done) return;
          count--;
          if (err) {
            done = true;
            return callback(err);
          }
          for (var s in wsdl.definitions.schemas) {
            schemas[s] = wsdl.definitions.schemas[s];
          }
          if (count === 0) {
            done = true;
            callback(null, schemas);
          }
        });
      });
    });
  }
}

WSDL.prototype.ignoredNamespaces = ['targetNamespace', 'typedNamespace'];
WSDL.prototype.ignoreBaseNameSpaces = false;
WSDL.prototype.valueKey = '$value';
WSDL.prototype.xmlKey = '$xml';

module.exports = WSDL;

function deepMerge(destination, source) {
  return _.mergeWith(destination || {}, source, function(a, b) {
    return _.isArray(a) ? a.concat(b) : undefined;
  });
}
