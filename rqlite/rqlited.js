"use strict";

const log = require ('../logger.js');
const { spawn, execFileSync } = require ('child_process');
const EventEmitter = require ('events');
const axios = require ('axios');
const fs = require ('fs');
const { v4: uuidv4 } = require ('uuid');

// create the self-owned data directory
try {
    execFileSync ('rqmkown');
} catch (error) {
    log.error ('Error running native initialization binary rqmkown.');
    throw error;
}

// fetch existing uuid or create a new one
const id = (function getUUID () {
    const idPath = '/data/rqlited.uuid';
    let uuid = undefined;
    if (fs.existsSync (idPath)) {
        log.debug (`Reading rqlited node id from path ${idPath}...`);
        uuid = fs.readFileSync (idPath, 'utf-8');
    } else {
        log.debug ('Generating new rqlited id...');
        uuid = uuidv4 ();
        fs.writeFileSync (idPath, uuid);
    }
    log.debug (`Got UUID ${uuid}.`);
    return uuid;
}) ();

// status of the rqlited child process
var statusCheck = undefined;
var isConnected = undefined;
var wasConnected = undefined;
var isLeader = undefined;

async function pollStatus (listenAddress) {
    try {
        const response = await axios.request ({
            url: `http://${listenAddress}:4001/status`,
            method: 'get',
            timeout: 500
        });
        return [
            // check for connection
            new Boolean (response.data.store.raft.state).valueOf (),
            // check for leadership
            new Boolean (response.data.store.raft.state == 'Leader').valueOf ()
        ];
    } catch {
        return [false, false];
    }
}

// emits ['spawned', 'ready', 'disconnected', 'reconnected']
const dStatus = new EventEmitter ();
// start check for readiness
dStatus.once ('spawned', (listenAddress, standalone) => {
    log.debug (`Starting status poll for rqlited node on ${listenAddress}...`);
    // periodicall poll status
    statusCheck = setInterval (async function checkReadiness () {
        [isConnected, isLeader] = await pollStatus (listenAddress);
        if (isConnected) {
            dStatus.emit ('ready', listenAddress, standalone);
            process.nextTick (clearInterval (statusCheck))
        }
    }, 1000);
});
// start regular status check
dStatus.once ('ready', (listenAddress, standalone) => {
    // do not poll connection status if not in cluster
    if (standalone !== true) {
        // poll daemon for connection status
        statusCheck = setInterval (async function checkStatus () {
            // remember the last connection status
            wasConnected = isConnected;
            [isConnected, isLeader] = await pollConnection (listenAddress);

            // if connection status change
            if (isConnected != wasConnected) {
                // reconnection
                if (isConnected) {
                    dStatus.emit ('reconnected');
                } 
                // disconnection
                else {
                    dStatus.emit ('disconnected');
                }
            }
        }, 1000);
    }
});
// debug logging
dStatus.on ('reconnected', () => log.debug ('Rqlited reconnected.'));
dStatus.on ('disconnected', () => log.debug ('Rqlited disconnected.'));

module.exports = {
    uuid: id,
    // status of this node/instance/process of rqlited
    status: dStatus,

    isLeader: () => {
        if (typeof isLeader == 'boolean') {
            return isLeader;
        } else {
            return false;
        }
    },

    spawn: (listenAddress, joinAddress, standalone) => {
        // concat the arguments with defaults
        const dArgs = [
            '-node-id', id,
            '-http-addr', `${listenAddress}:4001`,
            '-raft-addr', `${listenAddress}:4002`,
            '/data/rqlited'
        ];
        // add host to join if there is one
        if (joinAddress) {
            dArgs.unshift ('-join', `http://${joinAddress}:4001`);
        }
        // make sure there is no spawn error
        let spawnError = null;
        
    this.d = spawn ('rqlited', dArgs, {
            stdio: ['ignore', 'inherit', 'inherit']
        })
        .on ('error', (error) => {
            spawnError = error;
            process.exitCode = 1;
            throw error;
        });

        setImmediate ((spawnError) => {
            if (!spawnError) {
                dStatus.emit ('spawned', listenAddress, standalone);
            }
        });
    },

    kill: () => {
        // stop any and all status checks
        if (statusCheck && statusCheck instanceof Timeout) {
            clearInterval (statusCheck);
        }
        // kill child process
        if (this.d && this.d instanceof ChildProcess) {
            log.debug ('Stopping rqlited process...');
            this.d.kill ('SIGINT');
        }
    }
};