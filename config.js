// Change the values in this file to match your setup.
// I like to use this site for generating random secrets:
// https://www.random.org/strings/?num=1&len=20&digits=on&upperalpha=on&loweralpha=on&unique=on&format=html&rnd=new
module.exports = {
	// Displayed as 'Channel Id' on the channel configuration page on developer.olisto.com
	"olistoChannelId": "XXXXXXX",
	// Displayed as 'Access token' on the channel configuration page on developer.olisto.com
	"olistoToken": "XXXXXXX",
	// The public URL at which the Todolist API and Olisto can reach your fulfillment API.
    // This is the URL Reported by ngrok or whatever tool you use for tunneling.
	// Should match the 'Callback URL' setting on the channel configuration page on developer.olisto.com
	"fulfillmentBaseUrl": "https://XXXXXXX.ngrok.io",
    // Some secret random string we include in the URL for webhooks from the Todolist API
    // Only accepting requests that include this in the URL helps us to be sort of sure they are authentic.
	"todolistWebhookSecret": "XXXXXXXXXXXXXXXXXXXXX",
}
