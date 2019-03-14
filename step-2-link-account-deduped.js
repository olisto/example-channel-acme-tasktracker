const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const request = require("request-promise-native");

const todolistBaseUrl = 'http://localhost:4923';
const fulfillmentBaseUrl = 'http://localhost:4924';
const webhookPath = '/webhooks/VADR2EDDM7oMICE';
const olistoBaseUrl = 'https://connect-dev.olisto.com';
const olistoChannelId = 'X-acme_task_tracker-kBCZuata';
const olistoToken = 'BLGirkesSYufhw2nnyi1P50oV1BlhKbq';

// The only variable parts to these requests are the resource and possible body
function olistoRequest(resource, body) {
    const opts = {
        json: true,
        url: olistoBaseUrl + resource,
        headers: {authorization: `Bearer ${olistoToken}`},
        body,
    };
    console.log('olistoRequest', opts);
    return opts;
}

// These need the resource, body and authorization header
function todoRequest(resource, authorization, body) {
    const opts = {
        json: true,
        url: todolistBaseUrl + resource,
        headers: {authorization},
        body,
    };
    console.log('todoRequest', opts);
    return opts;
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
 * - webhookType: "account-unlinked"
 * - channelAccountId: Id for the disconnected channelaccount
 */
app.post('/account-unlinked', async function(req, res) {
    res.send();
    // De-register webhook with Todolist API
    await request.delete(todoRequest('/api/v1/webhook', req.headers['authorization']));
});
