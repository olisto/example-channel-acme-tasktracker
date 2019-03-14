const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const request = require("request-promise-native");

const app = express();

// Some standard security checks
app.use(helmet());
// Parse request bodies
app.use(require('body-parser').json());
// Request logging
app.use(morgan("common"));

// Start the server on port 4924
app.listen(4924, function() {
	console.log("channel-acme-tasktracker running.");
});

app.get("/", function(req, res) {
	res.send({
		status: "Channel is alive!"
	});
});