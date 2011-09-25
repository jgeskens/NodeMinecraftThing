var path = require('path'),
    url  = require('url'),
    fs   = require('fs'),
    util = require('util'),
    querystring = require('querystring');

//Default settings
var settings = {

  //Web configuration
  web_domain  : 'localhost',
  web_port    : 8080,
  
  //Session token name
  session_token  : '$SESSION_TOKEN',
  
  //Database configuration
  db_name     : 'test',
  db_server   : 'localhost',
  db_port     : 27017,
  
  //Game config options
  game_dir    : path.join(__dirname, '../game'),
  
  //If this flag is set, then reset the entire game state (useful for testing)
  RESET       : true,
  
  //If this flag is set, don't compress the client
  debug       : true,
  
};

//Parse out arguments from commandline
var argv = require('optimist').argv;
for(var i in argv) {
  if(i in settings) {
    settings[i] = argv[i];
  }
}

//Game server module
var game_module = require(path.join(settings.game_dir, '/server.js')),
    framework   = require('./framework.js');
    
for(var i=0; i<game_module.components.length; ++i) {
  game_module.components[i].registerFramework(framework);
}


//Session handler
var sessions = new (require('./session.js').SessionHandler)();


//Connects to database, adds references for collections
function initializeDB(next) {
  var mongodb   = require('mongodb'),
      db_name   = settings.db_name,
      db_server = settings.db_server,
      db_port   = settings.db_port,
      db = new mongodb.Db(db_name, new mongodb.Server(db_server, db_port, {}), {});

  db.open(function(err, db){

    if(err) {
      util.log("Error connecting to database");
      return;
    }
    
    function addCollection(col, cb) {
      db.collection(col, function(err, collection) {
        if(err) {
          util.log("Error adding collection '" + col + "': " + err);
          return;
        }
        db[col] = collection;
        cb();
      });
    }
    
    addCollection('accounts', function() {
      db.accounts.ensureIndex([['user_id', 1]], true, function() {
        addCollection('entities', function() {
          addCollection('players', function() { 
            db.players.ensureIndex([['user_id', 1]], false, function() {
              db.players.ensureIndex([['player_name',1]], true, function() {
                addCollection('regions', function() {
                  addCollection('chunks', function() {
                    db.chunks.ensureIndex([['region_id',1]], false, function() {
                      next(db);
                    });
                  });
                }); 
              });
            });
          });
        });
      });
    });
  });
}


//Attaches an open ID provider
function attachOpenID(server, login) {

  var openid = require('openid'),
  
      relying_party = new openid.RelyingParty(
        'http://' + settings.web_domain + ':' + settings.web_port + '/verify',
        null,
        false,
        false,
        []),
      
      providers = game_module.openid_providers;

  //Add handler to server      
  server.use(function(req, res, next) {
  
    var parsed_url = url.parse(req.url);
    
    if(parsed_url.pathname === '/authenticate') {
      var query         = querystring.parse(parsed_url.query),
          provider_str  = query.provider;

      if(!provider_str || !(provider_str in providers)) {
        res.writeHead(200);
        res.end('Invalid provider');
        return;
      }
      
      //Authenticate with provider
      var provider = providers[provider_str];
      
      if(provider == "temp") {
      
        //Make a temporary account
        res.writeHead(302, {Location: 'http://' + settings.web_domain + ':' + settings.web_port + '/verify?temp=1'});
      }
      else {
      
        //Otherwise, verify through OpenID
        relying_party.authenticate(provider, false, function(error, auth_url) {
          if(error || !auth_url) {
            res.writeHead(200);
            res.end('Authentication failed');
          }
          else {
          
            res.writeHead(302, {Location: auth_url});
            res.end();
          }
        });
      }
    }
    else if(parsed_url.pathname === '/verify') {

      var query         = querystring.parse(parsed_url.query),
          temporary     = query.temp;
          
      if(temporary) {
        //Create temporary account and add to game
        login(res, "temporary");
      }
      else {
        
        relying_party.verifyAssertion(req, function(error, result) {
        
          //Log in to database, send response
          login(res, result.claimedIdentifier);
        });
      }
    }
    else {
      next();
    }
  });
}


//Create web server
function createServer() {

  var connect     = require('connect'),
      server      = connect.createServer(),
      client_html = fs.readFileSync(game_module.client_html, 'utf-8');
      
  //Parse out client document
  var token_loc     = client_html.indexOf(settings.session_token),
      client_start  = client_html.substr(0, token_loc),
      client_end    = client_html.substr(token_loc + settings.session_token.length);

  //Mount extra, non-browserify files
  server.use(connect.static(path.join(settings.game_dir, './www/')));
  server.use(connect.static(path.join(__dirname, '../client/www/')));
  
  //Mount client files
  var options = {
    require: [  path.join(__dirname, '../client/engine.js'),
                path.join(settings.game_dir, './client.js'),
                'events',
                'dnode' ],
  };
  if(settings.debug) {
    options.watch = true;
    options.filter = function(src) {
      return '"use strict;"\n' + src;
    };
  }
  else {
    options.watch = false;
    options.filter = require("uglify-js");
  }
  server.use(require('browserify')(options));

  //Attach OpenID handler
  attachOpenID(server, function(res, user_id) {
    var now = (new Date()).toGMTString();
  
    res.setHeader('content-type', 'text/html');
    res.setHeader('last-modified', now);
    res.setHeader('date', now);
    res.statusCode = 200;
  
    res.write(client_start);
    res.write(sessions.setToken(user_id));
    res.end(client_end);
  });

  return server;
}

//Starts the game
function startGame(db, server) {
  //Create gateway
  require("./gateway.js").createGateway(db, server, sessions, game_module, function(err, gateway) {
    if(err) {
      throw err;
      return;
    }
    server.listen(settings.web_port);
    util.log("Server initialized!"); 
  });  
}

//Resets the whole database
function resetGame(db, cb) {
  //Only reset if called for
  if(!settings.RESET) {
    cb();
    return;
  }

  var createWorld = function() {
  
    //Create all the regions
    var regions         = game_module.regions,
        pending_regions = regions.length;
    for(var i=0; i<regions.length; ++i) {
    
      //Unpack region for database serialization
      var region = {
        region_name : regions[i].region_name,
        brand_new   : true,
      };
      
      util.log("Creating region: " + JSON.stringify(region));
      
      //Save the region to the database
      db.regions.save(region, function(err) {
        if(err) {
          throw err;
        }
        if(--pending_regions == 0) {
          util.log("GAME DATABASE RESET");
          cb();
        }
      });
    }
  };
  
  //Clear out database and create the world
  util.log("CLEARING GAME DATABASE");
  db.entities.remove({}, function(err0) {
    db.regions.remove({}, function(err1) {
      db.players.remove({}, function(err2) {
        db.chunks.remove({}, function(err3) {
          db.accounts.remove({}, function(err4) {
            var err = err0 || err1 || err2 || err3 || err4;
            if(err) {
              throw err;
            }
            createWorld();
          });
        });
      });
    });
  });
}

//Start the server
function startServer() {

  util.log("Starting server...");
  
  initializeDB(function(db) {
    resetGame(db, function() {
      var server = createServer();
      startGame(db, server);
    });
  });
} 

startServer();

if(settings.debug) {
  var repl = require('repl');
  repl.start('Admin> ');
}
