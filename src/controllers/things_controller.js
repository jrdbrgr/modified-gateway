/**
 * Things Controller.
 *
 * Manages HTTP requests to /things.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const Action = require('../models/action');
const Actions = require('../models/actions');
const ActionsController = require('./actions_controller');
const AddonManager = require('../addon-manager');
const Constants = require('../constants');
const EventsController = require('./events_controller');
const PromiseRouter = require('express-promise-router');
const Settings = require('../models/settings');
const Things = require('../models/things');
const WebSocket = require('ws');
const cassie = require('../cassie');

const ThingsController = PromiseRouter();

/**
 * Connect to receive messages from a Thing or all Things
 *
 * Note that these must precede the normal routes to allow express-ws to work
 */
ThingsController.ws('/:thingId/', websocketHandler);
ThingsController.ws('/', websocketHandler);

/*
cassie.client.on('consistencyError', (msg) => {
  if (! msg.startsWith('finished'))
    console.log("CONSISTENCY ERROR " + msg) 
});
*/

/**
 * Get a list of Things.
 */
ThingsController.get('/', (request, response) => {
  if (request.jwt.payload.role !== Constants.USER_TOKEN) {
    if (!request.jwt.payload.scope) {
      response.status(400).send('Token must contain scope');
    } else {
      const scope = request.jwt.payload.scope;
      if (!scope.includes(' ') && scope.indexOf('/') == 0 &&
        scope.split('/').length == 2 &&
        scope.split(':')[0] === Constants.THINGS_PATH) {
        Things.getThingDescriptions(request.get('Host'), request.secure)
          .then((things) => {
            response.status(200).json(things);
          });
      } else {
        // Get hrefs of things in scope
        const paths = scope.split(' ');
        const hrefs = new Array(0);
        for (const path of paths) {
          const parts = path.split(':');
          hrefs.push(parts[0]);
        }
        Things.getListThingDescriptions(hrefs,
                                        request.get('Host'),
                                        request.secure)
          .then((things) => {
            response.status(200).json(things);
          });
      }
    }
  } else {
    Things.getThingDescriptions(request.get('Host'), request.secure)
      .then((things) => {
        response.status(200).json(things);
      });
  }
});

ThingsController.patch('/', async (request, response) => {
  if (!request.body ||
      !request.body.hasOwnProperty('thingId') ||
      !request.body.thingId) {
    response.status(400).send('Invalid request');
    return;
  }

  const thingId = request.body.thingId;

  if (request.body.hasOwnProperty('pin') &&
      request.body.pin.length > 0) {
    const pin = request.body.pin;

    try {
      const device = await AddonManager.setPin(thingId, pin);
      response.status(200).json(device);
    } catch (e) {
      console.error(`Failed to set PIN for ${thingId}: ${e}`);
      response.status(400).send(e);
    }
  } else if (request.body.hasOwnProperty('username') &&
             request.body.username.length > 0 &&
             request.body.hasOwnProperty('password') &&
             request.body.password.length > 0) {
    const username = request.body.username;
    const password = request.body.password;

    try {
      const device = await AddonManager.setCredentials(
        thingId,
        username,
        password
      );
      response.status(200).json(device);
    } catch (e) {
      console.error(`Failed to set credentials for ${thingId}: ${e}`);
      response.status(400).send(e);
    }
  } else {
    response.status(400).send('Invalid request');
  }
});

/**
 * Handle creating a new thing.
 */
ThingsController.post('/', async (request, response) => {
  if (!request.body || !request.body.hasOwnProperty('id')) {
    response.status(400).send('No id in thing description');
    return;
  }
  const description = request.body;
  const id = description.id;
  delete description.id;

  try {
    // If the thing already exists, bail out.
    await Things.getThing(id);
    const err = 'Web thing already added';
    console.log(err, id);
    response.status(400).send(err);
    return;
  } catch (_e) {
    // Do nothing, this is what we want.
  }

  // If we're adding a native webthing, we need to update the config for
  // thing-url-adapter so that it knows about it.
  let webthing = false;
  if (description.hasOwnProperty('webthingUrl')) {
    webthing = true;

    const key = 'addons.config.thing-url-adapter';
    try {
      const config = await Settings.get(key);
      if (typeof config === 'undefined') {
        throw new Error('Setting is undefined.');
      }

      config.urls.push(description.webthingUrl);
      await Settings.set(key, config);
    } catch (e) {
      console.error('Failed to update settings for thing-url-adapter');
      console.error(e);
      response.status(400).send(e);
      return;
    }

    delete description.webthingUrl;
  }

  try {
    const thing = await Things.createThing(id, description, webthing);
    console.log(`Successfully created new thing ${thing.title}`);
    response.status(201).send(thing);
  } catch (error) {
    console.error('Error saving new thing', id, description);
    console.error(error);
    response.status(500).send(error);
  }

  // If this is a web thing, we need to restart thing-url-adapter.
  if (webthing) {
    try {
      await AddonManager.unloadAddon('thing-url-adapter', true);
      await AddonManager.loadAddon('thing-url-adapter');
    } catch (e) {
      console.error('Failed to restart thing-url-adapter');
      console.error(e);
    }
  }
});

/**
 * Get a Thing.
 */
ThingsController.get('/:thingId', (request, response) => {
  const id = request.params.thingId;
  Things.getThingDescription(id, request.get('Host'), request.secure)
    .then((thing) => {
      response.status(200).json(thing);
    })
    .catch((error) => {
      console.error(
        `Error getting thing description for thing with id ${id}:`,
        error
      );
      response.status(404).send(error);
    });
});

/**
 * Get the properties of a Thing.
 */
ThingsController.get('/:thingId/properties', async (request, response) => {
  const thingId = request.params.thingId;

  let thing;
  try {
    thing = await Things.getThing(thingId);
  } catch (e) {
    console.error('Failed to get thing:', e);
    response.status(404).send(e);
    return;
  }

  const result = {};
  for (const name in thing.properties) {
    try {
      const value = await AddonManager.getProperty(thingId, name);
      result[name] = value;
    } catch (e) {
      console.error(`Failed to get property ${name}:`, e);
    }
  }

  response.status(200).json(result);
});

/**
 * Get a property of a Thing.
 */
ThingsController.get(
  '/:thingId/properties/:propertyName',
  async (request, response) => {
    const thingId = request.params.thingId;
    const propertyName = request.params.propertyName;
    try {
      const value = await Things.getThingProperty(thingId, propertyName);
      const result = {};
      result[propertyName] = value;
      response.status(200).json(result);
    } catch (err) {
      response.status(err.code).send(err.message);
    }
  });

/**
 * Set a property of a Thing.
 */
ThingsController.put(
  '/:thingId/properties/:propertyName',
  async (request, response) => {

    const thingId = request.params.thingId;
    const propertyName = request.params.propertyName;
    if (!request.body || typeof request.body[propertyName] === 'undefined') {
      response.status(400).send('Invalid property name');
      return;
    }

    // */
    // BEGIN USED FOR TESTING
    const seq  = request.body["sequenceNumber"];

    // Calculate values to be used as summary
    if (seq === -1) {
      let wrong = 0; // counts wrong values sent in notifications
      let str = '';
      let correctnessStr = "";
      let correctReq = 0; // counts correct requests received by gateway
      let incorrectReq = 0; // count incorrect requests received by gateway
      let avgUpdate; // avg time between web app updates
      let avgWrite; // avg time between writes to cassandra
      let dbReadWrongValue = 0; // count number of reads that go awry
      let avgProcessingTime; // average gateway processing time per request

      // count average time between consecutive browser updates
      let timeBetween = []; // time between browser updates
      for (let i = 0; i < cassie.notifications.length; i++) {
        if (i > 0)
          timeBetween.push(cassie.notifications[i].time - cassie.notifications[i-1].time);
      }
      
      // Function to calculate average of numeric values in an array
      const findAvg = (timeBetween) => timeBetween.reduce((a, b) => a + b) / timeBetween.length;
      
      // avg time between consecutive browser updates
      if (timeBetween.length > 0)
        avgUpdate = Math.round(findAvg(timeBetween));
      else 
        avgUpdate = 0;

      // count average time between cassandra writes
      timeBetween = [];
      for (let i = 1; i < cassie.intervals.length; i++)
        timeBetween.push(cassie.intervals[i].start - cassie.intervals[i-1].start);
      
      if(timeBetween.length > 0)
        avgWrite = Math.round(findAvg(timeBetween));
      else avgWrite = 0;

      // pre-process array of database writes to flag updates that were lost entirely, 
      // assumes we are sending 100 unique updates to brigthness of 0-99
      let sortedWrites = cassie.dbWrites.slice().sort((a,b) => a-b);
      let lostUpdates = [];
      if (sortedWrites[0] !== 0) 
        lostUpdates.push(0);

      for (let i = 1; i < sortedWrites.length; i++) {
        let current = sortedWrites[i];
        let prev = sortedWrites[i - 1];

        if (current - prev > 1) {
          for (let j = prev + 1; j < current; j++) {
            lostUpdates.push(j);
          }
        }
      }

      let processingTime = []; // times it took gateway to process each request (browser notification timestamp - arrival at gateway timestamp)
      let length = cassie.requests.length;
      let reqPointer = 0; // used to step through requests
      let notifPointer = 0; // used to step through notifications

        while (reqPointer < length) {
          let request = cassie.requests[reqPointer];
        
          // Determine if requests were received by gateway in correct order (should be number 0-99)
          let correct = reqPointer === request.value;
              
          // Increment count of requests received correctly or incorrectly
          if (correct)
            correctReq++;
          else
            incorrectReq++

          let notification;
          if (notifPointer < cassie.notifications.length) {
            notification = cassie.notifications[notifPointer];
          }
          
          /* 3 cases of errors */

          // CASE 1, update lost entirely
          // if update was entirely lost (not attempted to be written to database), flag as lost
          if(lostUpdates.includes(request.value)) {
            str = str + "Request number: " + reqPointer + " | " + request.value + " | " + "none" + " | " + (notification.time - request.time)  + " ms FLAGGED AS LOST\n";
            reqPointer++; // increment just the request number but not the notification
          } 
          else {
            if(notification !== undefined)
              processingTime.push(notification.time - request.time); // append processing time to array
        
          // if update was not lost, but request and notification values still don't match
          if (notification !== undefined && request.value !== notification.value) {

            // CASE 2, correct update sent to Cassandra but wrong value read from database,
            // read likely was performed after another update had already been sent to Cassandra.
            if (request.value === cassie.dbWrites[notifPointer]) {
              str = str + "Request number: " + reqPointer + " | " + request.value + " | " + notification.value + " | " + (notification.time - request.time)  + " ms WRONG VALUE FROM DATABASE\n";
              dbReadWrongValue++;
              wrong++
            }

            // CASE 3, incorrect/out of order update sent to cassandra
            // ex: we should have sent level = 6 to Cassandra but we instead sent level = 5 or level = 7
            // if the gateway sent updates to cassandra out of order, a gateway side error
            else {
              str = str + "Request number: " + reqPointer + " | " + request.value + " | " + notification.value + " | " + (notification.time - request.time)  + " ms REORDERED BY GATEWAY\n";
              wrong++;
            }
          
            // increment both pointers for next loop iteration
            reqPointer++;
            notifPointer++;
          }

          // update was received from device, state written to and read from cassandra as expected
          else {
            if(notification !== undefined)
              str = str + "Request number: " + reqPointer + " | " + request.value + " | " + notification.value + " | " + (notification.time - request.time)  + " ms\n";
            else
              str = str + "Request number: " + reqPointer + " | " + request.value + " | " + "lost" + "\n";

            reqPointer++;
            notifPointer++;
          }
        }
      }

      correctnessStr = correctReq + " requests received by gateway with correct value, " + incorrectReq + " with incorrect value."

      
      // calculate average processing time for request by gateway
      if (processingTime.length > 0)
        avgProcessingTime = Math.round(findAvg(processingTime));
      else
        avgProcessingTime = 0;

      // calculate average Cassandra response time to update query
      let cassAvg = 0; // average Cassandra response time to update query
      for (let i = 0; i < cassie.intervals.length; i++)
        cassAvg += cassie.intervals[i].finish - cassie.intervals[i].start;

      cassAvg = Math.round(cassAvg / cassie.intervals.length);

      // calculate number of overlapping time intervals
      cassie.intervals.sort((a,b) => a.start - b.start) // sort intervals by start time
      let overlapping = 0;
      
      // count number of overlapping intervals
      for (let i = 0; i < cassie.intervals.length; i++)
        for (let j = 0; j < i; j++)
          if (cassie.intervals[j].finish > cassie.intervals[i].finish) {
            overlapping ++;
            break;
          }
      
      // send big string of data to be evaluated testing scripts
      response.status(400).send(
        correctnessStr + 
        "\nNumber of Updates to Web Browser: " + cassie.count + 
        "\nUpdates to Web Browser with incorrect value: " + wrong + 
        "\nReads of wrong value from database: " + dbReadWrongValue +
        "\nAverage time between Cassandra writes: " + avgWrite + " ms"+
        "\nAverage time between web app updates: " + avgUpdate + " ms"+ 
        "\nAverage gateway processing time for request: " + avgProcessingTime + " ms" + 
        "\nNumber of updates to Cassandra that overlapped with another update: " + overlapping + 
        "\nAverage cassandra response time to update: " + cassAvg + " ms" + 
        "\nNumber of Local Detection Inconsistencies: " + cassie.localDetectionErrors +
        "\nNumber of Global Detection Overlapping Writes: " + cassie.globalDetectionErrors +
        "\nNumber of Global Detection Not Persisted Errors: " + cassie.notPersistedErrors +
        "\nNumber of Requests Delayed: " + cassie.delayedRequests +
        "\n\n" + str);
       
      // make sure property is set to off before next test
      if (propertyName === 'on')
        await Things.setThingProperty(thingId, propertyName,false);
      else if (propertyName === 'level')
        await Things.setThingProperty(thingId, propertyName,0);
      return
    }
    else if (seq === -2) {

      // Reset counters before we begin next test
      cassie.count = 0;
      cassie.requests = [];
      cassie.notifications = [];
      cassie.intervals = [];
      cassie.delayedRequests = 0;
      cassie.localDetectionErrors = 0;
      cassie.globalDetectionErrors = 0;
      cassie.notPersistedErrors = 0;
      cassie.dbWrites = [];

      response.status(200).send("gateway ready to go");

      return
    }
    // */
    // END USED FOR TESTING

    const value = request.body[propertyName];

    let obj = {};
    obj.value = value;
    obj.time = Date.now();
    cassie.requests.push(obj);

    try {
      const updatedValue = await Things.setThingProperty(thingId, propertyName,
                                                          value);
      const result = {
        [propertyName]: updatedValue,
      };
      response.status(200).json(result);
    } catch (e) {
      response.status(e.code).send(e.message);
    }
  });

/**
 * Use an ActionsController to handle each thing's actions.
 */
ThingsController.use(`/:thingId${Constants.ACTIONS_PATH}`, ActionsController);

/**
 * Use an EventsController to handle each thing's events.
 */
ThingsController.use(`/:thingId${Constants.EVENTS_PATH}`, EventsController);

/**
 * Modify a Thing's floorplan position or layout index.
 */
ThingsController.patch('/:thingId', async (request, response) => {
  const thingId = request.params.thingId;
  if (!request.body) {
    response.status(400).send('request body missing');
    return;
  }

  let thing;
  try {
    thing = await Things.getThing(thingId);
  } catch (e) {
    response.status(404).send('thing not found');
    return;
  }

  let description;
  try {
    if (request.body.hasOwnProperty('floorplanX') &&
        request.body.hasOwnProperty('floorplanY')) {
      description = await thing.setCoordinates(
        request.body.floorplanX,
        request.body.floorplanY
      );
    } else if (request.body.hasOwnProperty('layoutIndex')) {
      description = await thing.setLayoutIndex(request.body.layoutIndex);
    } else {
      response.status(400).send('request body missing required parameters');
      return;
    }

    response.status(200).json(description);
  } catch (e) {
    response.status(500).send(`Failed to update thing ${thingId}: ${e}`);
  }
});

/**
 * Modify a Thing.
 */
ThingsController.put('/:thingId', async (request, response) => {
  const thingId = request.params.thingId;
  if (!request.body || !request.body.hasOwnProperty('title')) {
    response.status(400).send('title parameter required');
    return;
  }

  const title = request.body.title.trim();
  if (title.length === 0) {
    response.status(400).send('Invalid title');
    return;
  }

  let thing;
  try {
    thing = await Things.getThing(thingId);
  } catch (e) {
    response.status(500).send(`Failed to retrieve thing ${thingId}: ${e}`);
    return;
  }

  if (request.body.selectedCapability) {
    try {
      await thing.setSelectedCapability(request.body.selectedCapability);
    } catch (e) {
      response.status(500).send(`Failed to update thing ${thingId}: ${e}`);
      return;
    }
  }

  if (request.body.iconData) {
    try {
      await thing.setIcon(request.body.iconData, true);
    } catch (e) {
      response.status(500).send(`Failed to update thing ${thingId}: ${e}`);
      return;
    }
  }

  let description;
  try {
    description = await thing.setTitle(title);
  } catch (e) {
    response.status(500).send(`Failed to update thing ${thingId}: ${e}`);
    return;
  }

  response.status(200).json(description);
});

/**
 * Remove a Thing.
 */
ThingsController.delete('/:thingId', (request, response) => {
  const thingId = request.params.thingId;

  const _finally = () => {
    Things.removeThing(thingId).then(() => {
      console.log(`Successfully deleted ${thingId} from database.`);
      response.sendStatus(204);
    }).catch((e) => {
      response.status(500).send(`Failed to remove thing ${thingId}: ${e}`);
    });
  };

  AddonManager.removeThing(thingId).then(_finally, _finally);
});

function websocketHandler(websocket, request) {
  // Since the Gateway have the asynchronous express middlewares, there is a
  // possibility that the WebSocket have been closed.
  if (websocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const thingId = request.params.thingId;
  const subscribedEventNames = {};

  async function sendMessage(message) {
    websocket.send(JSON.stringify(message), (err) => {
      if (err) {
        console.error(`WebSocket sendMessage failed: ${err}`);
      }
    });
  }

  async function onPropertyChanged(property) {
    if (typeof thingId !== 'undefined' && property.device.id !== thingId) {
      return;
    }

    cassie.count++;
    let value = await property.getValue();

    let obj = {};
    obj.value = value;
    obj.time = Date.now();
    cassie.notifications.push(obj);
    sendMessage({
      id: property.device.id,
      messageType: Constants.PROPERTY_STATUS,
      data: {
        [property.name]: value,
      },
    });
  }

  function onActionStatus(action) {
    if (action.hasOwnProperty('thingId') &&
        typeof thingId !== 'undefined' &&
        action.thingId !== thingId) {
      return;
    }

    const message = {
      messageType: Constants.ACTION_STATUS,
      data: {
        [action.name]: action.getDescription(),
      },
    };

    if (action.hasOwnProperty('thingId')) {
      message.id = action.thingId;
    }

    sendMessage(message);
  }

  function onEvent(event) {
    if (typeof thingId !== 'undefined' && event.thingId !== thingId) {
      return;
    }

    if (!subscribedEventNames[event.name]) {
      return;
    }

    sendMessage({
      id: event.thingId,
      messageType: Constants.EVENT,
      data: {
        [event.name]: event.getDescription(),
      },
    });
  }

  let thingCleanups = {};
  function addThing(thing) {
    thing.addEventSubscription(onEvent);

    function onConnected(connected) {
      sendMessage({
        id: thing.id,
        messageType: Constants.CONNECTED,
        data: connected,
      });
    }
    thing.addConnectedSubscription(onConnected);

    const onRemoved = () => {
      if (thingCleanups[thing.id]) {
        thingCleanups[thing.id]();
        delete thingCleanups[thing.id];
      }

      if (typeof thingId !== 'undefined' &&
          (websocket.readyState === WebSocket.OPEN ||
           websocket.readyState === WebSocket.CONNECTING)) {
        websocket.close();
      } else {
        sendMessage({
          id: thing.id,
          messageType: Constants.THING_REMOVED,
          data: {},
        });
      }
    };
    thing.addRemovedSubscription(onRemoved);

    const onModified = () => {
      sendMessage({
        id: thing.id,
        messageType: Constants.THING_MODIFIED,
        data: {},
      });
    };
    thing.addModifiedSubscription(onModified);

    const thingCleanup = () => {
      thing.removeEventSubscription(onEvent);
      thing.removeConnectedSubscription(onConnected);
      thing.removeRemovedSubscription(onRemoved);
      thing.removeModifiedSubscription(onModified);
    };
    thingCleanups[thing.id] = thingCleanup;

    // send initial property values
    for (const name in thing.properties) {
      AddonManager.getProperty(thing.id, name).then((value) => {
        sendMessage({
          id: thing.id,
          messageType: Constants.PROPERTY_STATUS,
          data: {
            [name]: value,
          },
        });
      }).catch((e) => {
        console.error(`Failed to get property ${name}:`, e);
      });
    }
  }

  function onThingAdded(thing) {
    sendMessage({
      id: thing.id,
      messageType: Constants.THING_ADDED,
      data: {},
    });

    addThing(thing);
  }

  if (typeof thingId !== 'undefined') {
    Things.getThing(thingId).then((thing) => {
      addThing(thing);
    }).catch(() => {
      console.error('WebSocket opened on nonexistent thing', thingId);
      sendMessage({
        messageType: Constants.ERROR,
        data: {
          code: 404,
          status: '404 Not Found',
          message: `Thing ${thingId} not found`,
        },
      });
      websocket.close();
    });
  } else {
    Things.getThings().then((things) => {
      things.forEach(addThing);
    });
    Things.on(Constants.THING_ADDED, onThingAdded);
  }

  AddonManager.on(Constants.PROPERTY_CHANGED, onPropertyChanged);
  Actions.on(Constants.ACTION_STATUS, onActionStatus);

  const heartbeatInterval = setInterval(() => {
    try {
      websocket.ping();
    } catch (e) {
      // Do nothing. Let cleanup() handle things if necessary.
      websocket.terminate();
    }
  }, 30 * 1000);

  const cleanup = () => {
    Things.removeListener(Constants.THING_ADDED, onThingAdded);
    AddonManager.removeListener(Constants.PROPERTY_CHANGED, onPropertyChanged);
    Actions.removeListener(Constants.ACTION_STATUS, onActionStatus);
    for (const id in thingCleanups) {
      thingCleanups[id]();
    }
    thingCleanups = {};
    clearInterval(heartbeatInterval);
  };

  websocket.on('error', cleanup);
  websocket.on('close', cleanup);

  websocket.on('message', (requestText) => {
    let request = null;
    try {
      request = JSON.parse(requestText);
    } catch (e) {
      sendMessage({
        messageType: Constants.ERROR,
        data: {
          code: 400,
          status: '400 Bad Request',
          message: 'Parsing request failed',
        },
      });
      return;
    }

    const id = request.id || thingId;
    if (typeof id === 'undefined') {
      sendMessage({
        messageType: Constants.ERROR,
        data: {
          code: 400,
          status: '400 Bad Request',
          message: 'Missing thing id',
          request,
        },
      });
      return;
    }

    const device = AddonManager.getDevice(id);
    if (!device) {
      sendMessage({
        messageType: Constants.ERROR,
        data: {
          code: 400,
          status: '400 Bad Request',
          message: `Thing ${id} not found`,
          request,
        },
      });
      return;
    }

    switch (request.messageType) {
      case Constants.SET_PROPERTY: {
        const setRequests = Object.keys(request.data).map((property) => {
          const value = request.data[property];
          return device.setProperty(property, value);
        });
        Promise.all(setRequests).catch((err) => {
          // If any set fails, send an error
          sendMessage({
            messageType: Constants.ERROR,
            data: {
              code: 400,
              status: '400 Bad Request',
              message: err,
              request,
            },
          });
        });
        break;
      }

      case Constants.ADD_EVENT_SUBSCRIPTION: {
        for (const eventName in request.data) {
          subscribedEventNames[eventName] = true;
        }
        break;
      }

      case Constants.REQUEST_ACTION: {
        for (const actionName in request.data) {
          const actionParams = request.data[actionName].input;
          Things.getThing(id).then((thing) => {
            const action = new Action(actionName, actionParams, thing);
            return Actions.add(action).then(() => {
              return AddonManager.requestAction(
                id, action.id, actionName, actionParams);
            });
          }).catch((err) => {
            sendMessage({
              messageType: Constants.ERROR,
              data: {
                code: 400,
                status: '400 Bad Request',
                message: err.message,
                request,
              },
            });
          });
        }
        break;
      }

      default: {
        sendMessage({
          messageType: Constants.ERROR,
          data: {
            code: 400,
            status: '400 Bad Request',
            message: `Unknown messageType: ${request.messageType}`,
            request,
          },
        });
        break;
      }
    }
  });
}

module.exports = ThingsController;