
/**
 * Module dependencies.
 */

var express = require('express')
    , routes = require('./routes');
var data = require("./data");

var app = module.exports = express.createServer();

// Configuration

app.configure(function(){
    app.set('views', __dirname + '/views');
    app.set('view engine', 'jade');
    app.use(express.bodyParser());
    //app.use(express.logger());
    app.use(express.methodOverride());
    app.use(app.router);
    app.use(express.static(__dirname + '/public'));
});

app.configure('development', function(){
    app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function(){
    app.use(express.errorHandler());
});

// Routes

app.get('/', routes.index);
app.get('/content/topic=:topic&type=:type',  function(req, res){
    var paramType = req.params.type;
    var paramTopic = req.params.topic;
    console.log("type=" + paramType + "    topic=" + paramTopic);
    var result = [];
    var allItems = data.getContent();
    var item;
    for (var i  in allItems) {
        item = allItems[i];
        if (item.type != paramType && paramType != "All") {
            continue;
        }
        if (item.topic != paramTopic && paramTopic != "All") {
            continue;
        }
        result.push(item);

    }
    res.send(JSON.stringify(result));
});

var port = process.env.PORT || 5000;
app.listen(port, function(){
    console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
});
