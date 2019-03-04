const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const request = require("request-promise-native");

const apiBaseUrl = 'http://localhost:4923';
const webhookPath = '/webhooks/VADR2EDDM7oMICE';
const myWebhookBaseUrl = 'http://localhost:4924' + webhookPath;
const olistoBaseUrl = 'https://connect-dev.olisto.com';
const olistoStatePath = '/api/v1/state/channels/X-acme_task_tracker-kBCZuata/units';
const olistoToken = 'BLGirkesSYufhw2nnyi1P50oV1BlhKbq';

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

function olistoRequest(resource, body) {
	return {json: true, url: olistoBaseUrl + resource, headers: {authorization: `Bearer ${olistoToken}`}, body};
}

function todoRequest(resource, authorization, body) {
	return {json: true, url: apiBaseUrl + resource, headers: {authorization}, body};
}

function internalIdForList(entity) {
	return `${entity.owner_id}.${entity.id}`;
}

function internalIdForItem(entity) {
	return `${entity.owner_id}.${entity.list_id}`;
}

function listToUnit(list) {
	return {
		type: 'todolist',
		name: list.title,
		internalId: internalIdForList(list),
	};
}

app.post('/account-linked', async function(req, res) {
	console.log('account-linked body', req.body);
	res.send();
	const lists = await request.get(todoRequest('/api/v1/list', req.headers['authorization']));

	// Convert todo-lists to Olisto units
	const units = lists.map(listToUnit);

	// Push list of units to Olisto API
	await request.put(olistoRequest(`/api/v1/channelaccounts/${req.body.channelAccountId}/units`, units));
	//TODO: Initial state updates

	// Register webhook with Todolist API
	await request.post(todoRequest('/api/v1/webhook', req.headers['authorization'], {
		url: `${myWebhookBaseUrl}/${req.body.channelAccountId}`,
	}));
});

app.post('/account-unlinked', async function(req, res) {
	console.log('account-unlinked body', req.body);
	res.send();
	// De-register webhook with Todolist API
	await request.delete(todoRequest('/api/v1/webhook', req.headers['authorization']));
});

app.post("/refresh", async function(req, res) {
	res.send();
	// TODO: Send unit list with response body?
	// Retrieve list of units from Todolist API
	console.log('req.body', req.body);
	const lists = await request.get(todoRequest('/api/v1/list', req.headers['authorization']));

	// Convert todo-lists to Olisto units
	const units = lists.map(listToUnit);

	// Push list of units to Olisto API
	await request.put(olistoRequest(`/api/v1/channelaccounts/${req.body.channelAccountId}/units`, units));
});

class ActionError extends Error {};

app.post('/action', async function(req, res) {
	console.log('action body', req.body);
	try {
		switch(req.body.actionData.action) {
			case 'addItem':
				const itemId = req.body.unit.internalId.split('.')[1];
				await request.post(todoRequest(`/api/v1/list/${itemId}/item`, req.headers['authorization'], {
					title: req.body.actionData.itemName,
				}));
				break;
			default: throw new ActionError('channel/unknown-action');
		}
		res.send('triggi/ok');
	} catch(e) {
		if (e instanceof ActionError) {
			res.send(e.message);
		} else {
			console.log(e);
			try {
				res.status(500).send('triggi/channel-internal-error');
			} catch(_){}
		}
	}
});

// Generate state changes and event for item updates
const eventNames = {created: 'itemCreated', removed: 'itemRemoved', updated: 'itemUpdated'};
async function handleItemUpdate(req) {
	const eventName = eventNames[req.body.event];

	const internalId = internalIdForItem(req.body.entity);

	// We'll need the access token to query the number of unchecked items left
	const ca = await request.get(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}?freshTokens=true`));

	// Retrieve the list so that we can count the pending items still on it
	const list = await request.get(todoRequest(`/api/v1/list/${req.body.entity.list_id}`, 'Bearer ' + ca.accessToken));

	// Create the event @ Olisto
	await request.put(olistoRequest(`${olistoStatePath}/${internalId}`, {
		[eventName]: 1,
		listName: list.title,
		itemName: req.body.entity.title,
		uncompletedItemCount: list.items.filter((item) => item.state === 'PENDING').length
	}));
}

// Update Olisto's unit representations
async function handleListUpdate(req) {
	// A list was created or removed; create or delete Olisto units accordingly
	// Olisto unit representation for the list
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
			const internalId = internalIdForList(req.body.entity);
			return await request.delete(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}/units/?internalId=${internalId}`));
		default:
			console.log(`unhandled list event ${req.body.event}`);
	}
}

app.post(`${webhookPath}/:caId`, async function(req, res) {
	res.send();
	console.log('webhook for ' + req.params['caId'], req.body);
	try {
		switch(req.body.entity_type) {
			case 'item':
				// An item was created, deleted or updated; generate state changes and events
				return await handleItemUpdate(req);
			case 'list':
				// A list was added or removed; update unit lists.
				return await handleListUpdate(req);
		}
	} catch(e) {
		console.log('error handling webhook: ', req.body, e);
	}
});
