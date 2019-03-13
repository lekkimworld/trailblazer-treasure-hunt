const {Pool} = require("pg");
const terminateListener = require("./terminate-listener.js");
const path = require("path");
const express = require("express");
const exphbs = require("express-handlebars");
const redis = require("./configure-redis.js")

// load environment variables for localhost
try {
	require('dotenv').config()
} catch (e) {}

// create db pool
const pool = new Pool({
    'connectionString': process.env.DATABASE_URL,
    'ssl': process.env.NODE_ENV === 'production' ? true : false
});

// read data from Salesforce
require("./configure-questionnaire-cache.js")(pool);

// create promisified redis client
const redisClient = redis.promisifiedClient;

// create expres app, add static content and configure sessions
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(require("./configure-session.js")(redis.client));

// configure handlebars for templating
app.engine('handlebars', exphbs({defaultLayout: 'main'}))
app.set('view engine', 'handlebars')

// configure routes
require("./configure-routes.js")(app);

// add error handler
app.use((err, req, res, next) => {
    return res.render("error", {"error": err.message});
})

// listen
app.listen(process.env.PORT || 8080);
console.log(`Listening on port ${process.env.PORT || 8080}`)

// setup termination listener
terminateListener(() => {
	console.log("Terminating services");
    pool.end();
    redisClient.end();
	console.log("Terminated services");
});