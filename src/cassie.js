/**
 * Manages the connection to the Cassandara server
 *
 * @module Cassie
 */

'use strict';

const Deferred = require('./deferred');
const cassandra = require('modified-cassandra-driver');

/**
 * @class Cassie
 * @classdesc Cassie sets up a Cassandra client and manages
 * the connection to the Cassandra server
 */
class Cassie {

  constructor() {
    this.typeMap = new Map([
      ["boolean", "boolean"],
      ["number", "double"],
      ["integer", "int"]
      ]);

    this.count = 0; // used to count notifications sent to web app
    this.requests = [] // used to keep track of incoming http request values
    this.notifications = [] // used to keep track of notifications being sent back to web app
    this.intervals = [] // keeps track of time intervals in which Cassandra updates occur

    this.pending = {}; // keepts track of pending delayed executions
    this.finished = []; // keeps track of delayed executions that have already finished

    this.localDetectionErrors = 0; // count local detection errors
    this.globalDetectionErrors = 0; // count global detection overlapping writes errors
    this.notPersistedErrors = 0; // count global detection update not persisted errors
    this.delayedRequests = 0; // count number of requests delayed
    this.dbWrites = []; // store writes to database
 

    this.client = new cassandra.Client({ 
      contactPoints: ['45.56.103.71', '172.104.25.116', '50.116.63.121', '172.104.9.37', '23.239.10.53'],
      localDataCenter: 'datacenter1',
      keyspace: 'iot'
    });

    this.connect(); // connect to Cassandra server

    // Set up event listener for consistency error from server (detected by Will's work)
    this.client.on('consistencyError', (msg) => {
      if (msg.startsWith('Local Detection'))
        this.localDetectionErrors++;
      else if (msg.startsWith('Global detection concurrent writes'))
        this.globalDetectionErrors++;
      else if (msg.startsWith('Global detection update not persisted'))
        this.notPersistedErrors++;
    })

    // Set up event listener for notification that delayed request has finished executing
    this.client.on('finishedProcessing', (msg) => {
      let ts = msg.slice(msg.indexOf(' ') + 1); // the timestamp sent by the server

      // if we know request is pending, resolve corresponding promise
      if (this.pending[ts]) {
        this.pending[ts].resolve();
        delete this.pending[ts];
      } 
      // if we don't know yet, then store the timestamp# in the finished array
      else {
        this.finished.push(ts);
      }
    })
  }

  // Connect to Cassandra cluster and store Host object representing node 1
  async connect() {
    try {
      await this.client.connect();
      console.log('Connected to Cassandra cluster');
    }
    catch (err) {
      console.error(err);
    }

    // store node 1 Host object, needed to sending requests to single node
    this.nodeOne = this.client.hosts.get('45.56.103.71:9042');
  }

  // Create a table representing the state of a device,
  // and add a row representing the device's initial state
  async initDevice(deviceId, properties) {
    let columnTypes = {}; // a key-value store of <propertyName, CQL type of that property>
    let propValues = {}; // a key-value store of <propertyName, property value>

    deviceId = this.formatId(deviceId.toLowerCase()); // replace dashes with underscores and convert to lowercase

    // fill our data structures with property types and initial values
    for (const propertyName in properties) {
      const propertyDict = properties[propertyName];
      columnTypes[propertyName] = this.typeMap.get(propertyDict.type);
      propValues[propertyName] = propertyDict.value;
    }

    let tableExists;
    try {
      tableExists = (await this.client.metadata.getTable("iot", deviceId)) != null;
    }
    catch(err) {
      console.log(err);
    }

    // Create new table, if necessary
    if (!tableExists) {

      // Create the Cassandra table
      let query = 'CREATE TABLE ' + this.inQuotes(deviceId) + ' ( id text PRIMARY KEY,'

      // Add the column names and types to the query
      for (const property in columnTypes) {
        query += ' ' + this.inQuotes(property.toLowerCase()) + ' ' + columnTypes[property] + ',';
      }

      query = query.slice(0, query.length - 1) + " );"
      await this.execute(query);
    }

    // Add a row to the table, representing the device's initial state
    let props = 'id, '; // the property names
    let values = "'state', "; // the property values

    // Build comma-separated lists of propertyNames and values, necessary for CQL syntax
    for (const property in propValues) {
      props += this.inQuotes(property.toLowerCase()) + ', ' ;
      values += propValues[property] + ', ';
    }

    props = '(' + props.slice(0, props.length - 2) + ')';
    values = '(' + values.slice(0, values.length - 2) + ')';

    // Execute the INSERT query
    let query = 'INSERT INTO ' + this.inQuotes(deviceId) + '' + props + ' VALUES ' + values + ';';
    await this.execute(query);
  }

  // Write a property value to Cassandra
  write(deviceId, propertyName, value) {
    return new Promise((resolve, reject) => {
      // remove dashes and convert to lowercase
      deviceId = this.inQuotes(this.formatId(deviceId.toLowerCase()));
      propertyName = this.inQuotes(propertyName.toLowerCase());

      // Execute UPDATE query    
      let query = 'UPDATE ' + deviceId + ' SET ' + propertyName + '=' + value + ' WHERE id=\'state\';';

      // USED FOR TESTING
      this.dbWrites.push(value); // store all values being written to data
      const interval = {}; // interval in which update to cassandra is in flight
      interval.start = Date.now();

      this.execute(query) // add 'false' as next parameter to only send updates to one node
      .then((result) => {
        if (result.info.warnings && result.info.warnings[0] == "DELAY")
        {
          // console.log("REQUEST DELAYED WITH TIMESTAMP: " + result.info.warnings[1]);
          this.delayedRequests++;
          let ts = result.info.warnings[1]; // the timestamp returned by the server
            
          // if execution finished before we got notification that request was delayed
          if (this.finished.includes(ts)) {

            // delete element from array
            let index = this.finished.indexOf(ts);
            this.finished.splice(index, 1);

            interval.finish = Date.now();
            this.intervals.push(interval);
            resolve();
          } 
          // if execution still pending
          else {
            this.pendingExecution(ts)
            .then(() => {
              interval.finish = Date.now();
              this.intervals.push(interval);
              resolve();
            })
          }
        }
        else {
          interval.finish = Date.now();
          this.intervals.push(interval);
          resolve();
        }
      })
    })
  }

    /**
   * @method pendingExecution
   * @returns a promise which is resoved when a delayed
   * query finishes execution, allows us to wait until we know a Cassandra update has finished
   */
  pendingExecution(ts) {
    const deferred = new Deferred();
    this.pending[ts] = deferred;
    return deferred.promise;
  }

  // Read a property value from Cassandra
  async read(deviceId, propertyName) {

    // remove dashes andconvert lowercase
    deviceId = this.formatId(deviceId.toLowerCase());
    propertyName = propertyName.toLowerCase();

    // execute select query
    let query = 'SELECT ' + this.inQuotes(propertyName) + ' FROM ' + this.inQuotes(deviceId) + ' WHERE id=\'state\';';
    let result = await this.execute(query);

    let row = result.rows[0];
    let value = row[propertyName];
    return value;
  }

  // Execute query and perform error checking
  async execute(query, multiHost = true) {
    try {
      let result;
      if (multiHost)
        result = await this.client.execute(query);
      else
        result = await this.client.execute(query,[],{host: this.nodeOne});
      return result;
    }
    catch(err) {
      console.log("Error with Cassandra query: " + err);
    }
  }

  // return string argument surrounded by quotes
  inQuotes(str) {
    return '"' + str + '"';
  }

  // Replace dashes with underscores, dashes not allowed in Cassandra table names
  formatId(deviceId) {
    return deviceId.replace(/-/g, '_');
  }
}

module.exports = new Cassie();