const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const request = require("request-promise-native");

const apiUrl = 'http://localhost:4923';
const webhookPath = '/webhooks/VADR2EDDM7oMICE';
const myWebhookBaseUrl = 'http://localhost:4924' + webhookPath;
const olistoToken = 'bibWDo2x7Mxkb5NHBzbvIvVtvuPaMGVw';
const olistoStateUrl = 'https://connect.olisto.com/api/v1/state/channels/acme_task_tracker-1gHu4Mdk/units';

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

function itemToUnit(item) {
	const internalId = `${item.owner_id}.${item.id}`;
	return {
		type: 'todolist',
		name: item.title,
		internalId: internalId,
		endpoint: 'acme_task_tracker-1gHu4Mdk.' + internalId,
	};
}

app.post("/refresh", async function(req, res) {
	res.send();
	console.log('req.body', req.body);
	const list = await request.get({
		json: true,
		url: `${apiUrl}/api/v1/list`,
		headers: {authorization: `Bearer ${req.body.authDetails.accessToken}`}
	});
	console.log('list', list);
	const units = list.map(itemToUnit);
	console.log('units', units);
	console.log('url', `https://connect.olisto.com/api/v1/channelaccounts/${req.body.channelAccountId}/units`);
	const response = await request.patch({
		json: true,
		uri: `https://connect.olisto.com/api/v1/channelaccounts/${req.body.channelAccountId}/units`,
		headers: {authorization: `Bearer ${olistoToken}`},
		body: units,
	});
	console.log('response', response);

	await request.post({
		json: true,
		url: `${apiUrl}/api/v1/webhook`,
		headers: {authorization: `Bearer ${req.body.authDetails.accessToken}`},
		body: {
			url: `${myWebhookBaseUrl}/${req.body.channelAccountId}`,
		}
	});

});

class ActionError extends Error {};

app.post('/action', async function(req, res) {
	/*
	 {
	 "webhookType": "action",
	 "executionId": "UFyCWGIp8",
	 "channelAccountId": "5c65e011df25562ba4fff032",
	 "actionData": {
	 "action": "addItem",
	 "isChecked": "0",
	 "itemName": "New item"
	 },
	 "unitId": "5c65e05368423645f5e47062"
	 }
	 */
	try {
		const ca = await request.get({
			json: true,
			uri: `https://connect.olisto.com/api/v1/channelaccounts/${req.body.channelAccountId}`,
			headers: {authorization: `Bearer ${olistoToken}`},
		});
		console.log('ca', ca);
		const unit = await request.get({
			json: true,
			uri: `https://connect.olisto.com/api/v1/channelaccounts/${req.body.channelAccountId}/units/${req.body.unitId}`,
			headers: {authorization: `Bearer ${olistoToken}`},
		});
		console.log('unit', unit);
		switch(req.body.actionData.action) {
			case 'addItem':
				await request.post({
					json: true,
					url: `${apiUrl}/api/v1/list/${unit.internalId.split('.')[1]}/item`,
					headers: {authorization: `Bearer ${ca.accessToken}`},
					body: {
						title: req.body.actionData.itemName,
					}
				});
				break;
			default: throw new ActionError('channel/unknown-action');
		}
		res.send();
	} catch(e) {
		if (e instanceof ActionError) {
			res.send(e.message);
		} else {
			console.log(e);
			try {
				res.status(500).send();
			} catch(_){}
		}
	}
});

async function handleItemUpdate(req) {
	const ca = await request.get({
		json: true,
		uri: `https://connect.olisto.com/api/v1/channelaccounts/${req.params['caId']}`,
		headers: {authorization: `Bearer ${olistoToken}`},
	});

	const list = await request.get({
		json: true,
		url: `${apiUrl}/api/v1/list/${req.body.entity.list_id}`,
		headers: {authorization: `Bearer ${ca.accessToken}`},
	});
	console.log('list', list);

	let eventName = null;
	switch(req.body.event) {
		case 'created':
			eventName = 'itemCreatedEvent';
			break;
		default:
			console.log(`unhandled event ${req.body.event}`);
	}
	if (eventName) {
		await request.put({
			json: true,
			url: `${olistoStateUrl}/${req.body.entity.owner_id}.${req.body.entity.list_id}`,
			headers: {authorization: `Bearer ${olistoToken}`},
			body: {[eventName]: 1, listName: list.title, itemName: req.body.entity.title, uncompletedItemCount: list.items.filter((item)=> item.state === 'PENDING').length},
		});
	}
}

app.post(`${webhookPath}/:caId`, async function(req, res) {
	res.send();
	console.log('webhook for ' + req.params['caId'], req.body);
	try {
		switch(req.body.entity_type) {
			case 'item':
				await handleItemUpdate(req);
				break;
			default:
				console.log(`update for unknown entity_type ${req.body.entity_type}`);
		}
	} catch(e) {
		console.log('error handling webhook: ', req.body, e);
	}
});


// {"affectedTriggs":[],"timeTakenMs":21,"stateUpdate":{"rk":"events.acme_task_tracker-1gHu4Mdk.testuser1.1","msg":{"itemCreatedEvent":1,"listName":"Shopping list","itemName":"Blub","uncompletedItemCount":15}}}