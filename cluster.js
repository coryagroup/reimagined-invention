"use strict";

const Discover = require ('node-discover');
const print = require ('./print.js');
const { sleep } = require ('sleepjs');
const EventEmitter = require ('events');
const iprange = require ('iprange');

const rqlite = require ('./rqlite.js');
const rqlited = require ('./rqlited.js');

// default options
const options = {
    // helloInterval: 3 * 1000,
    // checkInterval: 6 * 2000,
    // nodeTimeout: 60 * 1000,
    port: 4000,
};

// maintain a list of Peers external to node-discover nodes
const Peers = new Set ();

// which node is master
var isMaster = false;

// callback on discover creation
async function initialize (error) {

    // catch error with cluster
    if (error) { print (error.name); print (error.message); process.exitCode = 1; };

    // looking for Peers
    print ('Looking for peers...');
    const retries = 3; let attempt = 1;
    while ((Peers.size < 1) && (attempt <= retries)) {
        // backoff
        await sleep ( attempt * 20 * 1000);
        if (Peers.size < 1) {
            if (Peers.size < 1) { print (`No peers found.`); }
            print (`Retrying (${attempt}/${retries})...`);
            attempt++;
        }
    }

    // either move on or quit
    if (Peers.size > 0) {
        // indicates completion status and joinHost
        // if this cluster node is master, "const master"
        // will be undefined here
        const master = Array.from (Peers.values ()).find ((node) => { return node.isMaster; });
        discovery.emit ('complete', master);
    } else {
        // no peers, no run
        if (Peers.size <= 0) { print ('Could not find any peers.'); };
        process.exitCode = 1;
        process.kill (process.pid);
    }
};

const discovery = new EventEmitter ()
.on ('complete', function spawnRqlited (joinHost) {
    rqlited.spawn (joinHost);
});

module.exports = {
    // emits 'ready' when rqlited is ready for connections
    rqlited: rqlited.node,
    
    start: (address, subnet) => {
        rqlited.address = address;
        options.address = address;
        options.unicast = iprange (subnet);

    this.discover = new Discover (options, initialize)
        .on ('promotion', () => {
            isMaster = true;
        })
        .on ('demotion', () => {
            isMaster = false;
        })
        .on ('added', (node) => {
            print (`Found ${node.isMaster ? 'master' : 'node'} ${node.hostName}.`);
            Peers.add (node.hostName);
            // node added to cluster
            if (node.advertisement == 'initialized') {
                // initialize new node in existing cluster
                print (`Joining rqlited cluster via ${node.hostName}...`);
                discovery.emit ('complete', node.hostName);
            }
        })
        .on ('removed', async function removeNode (node) {
            print (`Lost node ${node.hostName}.`);
            Peers.delete (node.hostName);
            // if this node is master, remove the lost node
            if (isMaster) {
                print (`Removing node ${node.hostName}...`);
                await rqlite.cluster.remove (node.hostName);
            }
        });
    },

    isMaster: (hostname) => {
        // check if this node is master by default
        if (!hostname) {
            return isMaster;
        } else {
            // do not error if isMaster is called before discover is defined
            if (this.discover) {
                // iterate each node to find master
                const master = this.discover.eachNode (function findMaster (node) {
                    if (node.isMaster) {
                        return node;
                    }
                });
                // return false if no master found or master.hostName != hostname
                if (master && master.hostName == hostname) {
                    return true;
                } else {
                    return false;
                }
            } else {
                // no discover, no master
                return false;
            }
        }
    },

    stop: () => {
        if (this.discover) {
            this.discover.stop ();
        };
        rqlited.kill ();
    }
}