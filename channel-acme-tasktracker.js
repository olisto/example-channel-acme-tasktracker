const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const request = require("request-promise-native");

const apiBaseUrl = 'http://localhost:4923';
const webhookPath = '/webhooks/VADR2EDDM7oMICE';
const myWebhookBaseUrl = 'http://localhost:4924' + webhookPath;
const olistoBaseUrl = 'https://connect-dev.olisto.com';
const olistoStateUrl = '/api/v1/state/channels/X-acme_task_tracker-kBCZuata/units';
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
	console.log('authorization: ' + authorization);
	return {json: true, url: apiBaseUrl + resource, headers: {authorization}, body};
}

function listToUnit(list) {
	const internalId = `${list.owner_id}.${list.id}`;
	return {
		type: 'todolist',
		name: list.title,
		internalId: internalId,
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
async function handleItemUpdate(req) {
	let eventName = null;
	switch(req.body.event) {
		case 'created':
			eventName = 'itemCreated';
			break;
		case 'removed':
			eventName = 'itemRemoved';
			break;
		case 'updated':
			eventName = 'itemUpdated';
			break;
		default:
			return console.log(`unhandled event ${req.body.event}`);
	}
	const internalId = `${req.body.entity.owner_id}.${req.body.entity.list_id}`;
	console.log('internalId: ' + internalId);

	// We'll need the access token to query the number of unchecked items left
	const ca = await request.get(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}?freshTokens=true`));
	console.log('ca', ca);

	// Retrieve the list so that we can count the pending items still on it
	const list = await request.get(todoRequest(`/api/v1/list/${req.body.entity.list_id}`, 'Bearer ' + ca.accessToken));

	try {
		const url = `${olistoStateUrl}/${internalId}`;
		const res = await request.put(olistoRequest(url,
			{[eventName]: 1, listName: list.title, itemName: req.body.entity.title, uncompletedItemCount: list.items.filter((item)=> item.state === 'PENDING').length}));
	} catch(e) {
		console.log('error on put state', e);
	}
}

// Update Olisto's unit representations
async function handleListUpdate(req) {
	// 2 options: Either just do a full re-sync, which is easy since we already have code for that,
	// or handle the specific change, which is more neat but also more work.
	switch(req.body.event) {
		case 'created':
			request.post(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}/units`, listToUnit(req.body.entity)));
			break;
		case 'removed':
			const internalId = `${req.body.entity.owner_id}.${req.body.entity.id}`;
			request.delete(olistoRequest(`/api/v1/channelaccounts/${req.params['caId']}/units/?internalId=${internalId}`));
			break;
	}
}

app.post(`${webhookPath}/:caId`, async function(req, res) {
	res.send();
	console.log('webhook for ' + req.params['caId'], req.body);
	try {
		switch(req.body.entity_type) {
			case 'item':
				// An item was created, deleted or updated; generate state changes and events
				await handleItemUpdate(req);
				break;
			case 'list':
				// A list was added or removed; update unit lists.
				await handleListUpdate(req);
				break;

			default:
				console.log(`update for unknown entity_type ${req.body.entity_type}`);
		}
	} catch(e) {
		console.log('error handling webhook: ', req.body, e);
	}
});
