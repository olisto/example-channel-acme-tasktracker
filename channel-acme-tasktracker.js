const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const request = require("request-promise-native");

const todolistBaseUrl = 'https://todo.olisto.com';
const olistoBaseUrl = 'https://connect.olisto.com';

// These things need to be configured for your situation
const {fulfillmentBaseUrl, todolistWebhookSecret, olistoChannelId, olistoToken} = require('./config');

const webhookPath = `/webhooks/${todolistWebhookSecret}`;

// The only variable parts to these requests are the resource and possible body
function olistoRequest(resource, body) {
	return {
		json: true,
		url: olistoBaseUrl + resource,
		headers: {authorization: `Bearer ${olistoToken}`},
		body,
	};
}

// These need the resource, body and authorization header
function todoRequest(resource, authorization, body) {
	return {
		json: true,
		url: todolistBaseUrl + resource,
		headers: {authorization},
		body,
	};
}

/**
 * Create an Olisto unit representation for a todolist.
 * Olisto units must at least have:
 * - name: String. The human-readable name for the unit
 * - type: String. Channel-internal identifier that links the unit to a unit-type defined through developer.olisto.com
 * - internalId: String. channel-internal identifier that links the unit to the channel-specific entity
 * internalId must be unique within the channel.
 * Optionally a unit can have a 'details' field which should be an Object containing any information required by the
 * fulfillment API to interact with this unit. We don't need it in this case.
 */
function listToUnit(list) {
	return {
		name: list.title,
		type: 'todolist',
		internalId: `${list.owner_id}.${list.id}`,
	};
}

// Create an object with all states for a list
function statesForList(list) {
	return {
		// Each list has a count of uncompleted items
		uncompletedItemCount: list.items.filter((item) => item.state === 'PENDING').length,
	};
}

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

/**
 * Invoked by Olisto when a new user connects to our channel.
 * The body will contain:
 * - webhookType: String. "account-linked"
 * - channelAccountId: String. Id for the new channelaccount
 * All webhook requests cary authentication for the current user.
 */
app.post('/account-linked', async function(req, res) {
	res.send();
	console.log('/account-linked request from Olisto:', req.body);

	// Retrieve the list of todo-lists from the TODO-API
	const lists = await request.get(todoRequest('/api/v1/list', req.headers['authorization']));

	// Convert todo-lists to Olisto units
	const units = lists.map(listToUnit);

	// Push list of units to Olisto API
	await request.put(olistoRequest(`/api/v1/channelaccounts/${req.body.channelAccountId}/units`, units));

	/**
	 * Report initial states to Olisto
	 * We'll report states for all units in one go. Build an array with an
	 * objects for each unit, each containing the internalId for that unit and
	 * a data map that maps every reported state to its value
	 */
	const stateReports = lists.map((list) => ({
		internalId: `${list.owner_id}.${list.id}`,
		states: statesForList(list),
	}));
	// Push the state report to Olisto API
	await request.put(olistoRequest(`/api/v1/state/channels/${olistoChannelId}/units`, stateReports));

	// Register webhook with Todolist API
	await request.post(todoRequest('/api/v1/webhook', req.headers['authorization'], {
		url: `${fulfillmentBaseUrl}${webhookPath}/${req.body.channelAccountId}`,
	}));
});

/**
 * Invoked by Olisto when a user disconnects from our channel.
 * The body will contain:
 * - webhookType: String. "account-unlinked"
 * - channelAccountId: String. Id for the disconnected channelaccount
 */
app.post('/account-unlinked', async function(req, res) {
	res.send();
	console.log('/account-unlinked request from Olisto:', req.body);

	// De-register webhook with Todolist API
	await request.delete(todoRequest('/api/v1/webhook', req.headers['authorization']));
});

/**
 * Invoked by Olisto when an up-to-date list of units is required.
 * The body will contain:
 * - webhookType: String. "refresh"
 * - channelAccountId: String. Id for the channelaccount that needs refreshing
 */
app.post("/refresh", async function(req, res) {
	res.send();
	console.log('/refresh request from Olisto:', req.body);

	// Retrieve list of units from Todolist API
	const lists = await request.get(todoRequest('/api/v1/list', req.headers['authorization']));

	// Convert todo-lists to Olisto units
	const units = lists.map(listToUnit);

	// Push list of units to Olisto API
	await request.put(olistoRequest(`/api/v1/channelaccounts/${req.body.channelAccountId}/units`, units));
});

/**
 * Webhook calls from our own API
 * The body will contain:
 * - entity_type: String. 'refresh' or 'list'
 * - event: String. 'created', 'updated' or 'deleted'
 * - entity: Object. The list or entry that was created, updated or deleted; see below
 * For entity_type = 'item':
 * - id: String. Id of the item
 * - list_id: String. id of the list holding this item
 * - owner_id: String. Owner of the item
 * - title: String. Title of the item
 * - state: String. Current state of the item; 'DONE' or 'PENDING'
 * For entity_type = 'list':
 * - id: String. Id of the list
 * - owner_id: String. Owner of the list
 * - title: String. Title of the list
 * - items: Array. Items in the list; each item is structured as an item entity type
 */
app.post(`${webhookPath}/:caId`, async function(req, res) {
	res.send();
	console.log('webhook request from Todolist service:', req.body);
	switch(req.body.entity_type) {
		case 'item':
			// An item was created, deleted or updated; generate state changes and events
			return await handleItemUpdate(req);
		case 'list':
			// A list was added, deleted or updated; update unit lists.
			return await handleListUpdate(req);
	}
});

// Generate state changes and event for item updates
const eventNames = {created: 'itemCreated', removed: 'itemRemoved', updated: 'itemUpdated'};
async function handleItemUpdate(req) {
	// We'll need the access token to query the number of unchecked items left
	const ca = await request.get(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}?freshTokens=true`));

	// Retrieve the list so that we can count the pending items still on it
	const list = await request.get(todoRequest(`/api/v1/list/${req.body.entity.list_id}`, 'Bearer ' + ca.accessToken));

	// Create the event @ Olisto
	const internalId = `${req.body.entity.owner_id}.${req.body.entity.list_id}`;
	await request.put(olistoRequest(`/api/v1/state/channels/${olistoChannelId}/units/${internalId}`, {
		[eventNames[req.body.event]]: 1,
		listName: list.title,
		itemName: req.body.entity.title,
		...{uncompletedItemCount: list.items.filter((item) => item.state === 'PENDING').length},
	}));
}

// A list was created, updated or removed; create, update or delete Olisto units accordingly
async function handleListUpdate(req) {
	// Create an Olisto unit representation for the list
	const unit = listToUnit(req.body.entity);
	switch(req.body.event) {
		case 'created':
			// Add to the list of units for the given channelAccount
			return await request.post(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}/units`, unit));
		case 'updated':
			// Update in the list of units for the given channelAccount
			// updateOnly or keep or ...
			return await request.patch(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}/units?updateOnly=true`, [unit]));
		case 'removed':
			// Delete all units with in this channelAccount with this internalId (which should be exactly 1 unit)
			const internalId = `${req.body.entity.owner_id}.${req.body.entity.id}`;
			return await request.delete(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}/units/?internalId=${internalId}`));
	}
}

/**
 * Invoked by Olisto when an action should be performed
 * The body will contain:
 * - webhookType: String. "action"
 * - channelAccountId: String. Id for the channelaccount related to the unit from which the action is requested
 * - executionId: String. A unique ID that can be included in logs to track the execution of an action.
 * - initId: String. Internal ID of the unit the action is perfored on.
 * - actionData: Object that describes the action; contains the name of the action and any defined perameters.
 *  - action: String. Name of the action
 *  - [parameter name]: Any. Parameter value; 'itemName' in this example.
 * - unit: Object. The unit object as we've reported it to Olisto, including any details if set
 * The handler should respond with a status code that indicates wheter the action executed successfully:
 * - olisto/ok for successful execution
 * - olisto/unknown-action when the channel was unknown
 * - olisto/unit-not-found when the action was performed on an endpoint that is not known (anymore) by the API
 * - olisto/api-unreachable when the API can not be reached
 * - olisto/caught-exception for any unexpected exception during the execution of the action
 * - channel/your-specific-code for any channel- (or api-) specific errors;
 *   human-readable texts should be added through the channel configuration portal.
 * ...
 */
app.post('/action', async function(req, res) {
	console.log('/action request from Olisto:', req.body);

	switch(req.body.actionData.action) {
		case 'addItem':
			const itemId = req.body.unit.internalId.split('.')[1];
			await request.post(todoRequest(`/api/v1/list/${itemId}/item`, req.headers['authorization'], {
				title: req.body.actionData.itemName,
			}));
			break;
		default: throw new ActionError('olisto/unknown-action');
	}
	res.send('olisto/ok');
});