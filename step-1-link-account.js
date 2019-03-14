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

/**
 * Invoked by Olisto when a new user connects to our channel.
 * The body will contain:
 * - webhookType: String. "account-linked"
 * - channelAccountId: String. Id for the new channelaccount
 * All webhook requests cary authentication for the current user.
 */
app.post('/account-linked', async function(req, res) {
	// Immediately respond with HTTP/OK
	res.send();

	// Retrieve the list of todo-lists from the TODO-API
	const lists = await request.get({
		json: true,
		url: 'http://localhost:4923/api/v1/list',
		headers: {
			// The webook request will bear authorization for the user
			authorization: req.headers['authorization'],
		},
	});

	/**
	 * Create an Olisto unit representation for a todolist.
	 * Olisto units must at least have:
	 * - name: The human-readable name for the unit
	 * - type: Channel-internal identifier
	 * Links the unit to a unit type defined through developer.olisto.com
	 * - internalId: channel-internal identifier for the unit.
	 * Links the unit to the channel-specific entity.
	 * internalId must be unique within the channel.
	 * Optionally a unit can have a 'details' field which should be an Object.
	 * It can be used to keep any information required by the fulfillment API to
	 * interact with this unit. We don't need it in this case.
	 */
	const units = lists.map((list) => ({
		name: list.title,
		type: 'todolist',
		internalId: `${list.owner_id}.${list.id}`,
	}));

	// Push list of units to Olisto API
	await request.put({
		json: true,
		url: `https://connect-dev.olisto.com/api/v1/channelaccounts/` +
			`${req.body.channelAccountId}/units`,
		headers: {authorization: `Bearer BLGirkesSYufhw2nnyi1P50oV1BlhKbq`},
		body: units
	});

	/**
	 * Report initial states to Olisto
	 * We'll report states for all units in one go. Build an array with an
	 * objects for each unit, each containing the internalId for that unit and
	 * a data map that maps every reported state to its value
	 */
	const stateReports = lists.map((list) => ({
		internalId: `${list.owner_id}.${list.id}`,
		states: {
			// Each list has a count of uncompleted items
			uncompletedItemCount:
				list.items.filter((item) => item.state === 'PENDING').length
		}
	}));
	// Push the state report to Olisto API
	await request.put({
		json: true,
		url: `https://connect-dev.olisto.com/api/v1/state/channels` +
		`/X-acme_task_tracker-kBCZuata/units`,
		headers: {authorization: `Bearer BLGirkesSYufhw2nnyi1P50oV1BlhKbq`},
		body: stateReports
	});

	// Register webhook with Todolist API
	// An easy way to be sure that webhook calls are actually comming from
	// your API: Include some part in the URL that could never be guessed
	// Also include the channelAccountId so we can relate webhook calls to
	// the right Olisto user channelAccount
	const webhookUrl = `http://localhost:4924` +
		`/webhooks/VADR2EDDM7oMICE/${req.body.channelAccountId}`
	await request.post({
		json: true,
		url: 'http://localhost:4923/api/v1/webhook',
		headers: {
			authorization: req.headers['authorization'],
		},
		body: {
			url: webhookUrl,
		},
	});
});
