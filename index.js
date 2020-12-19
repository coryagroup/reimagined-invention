"use strict";
require ('dotenv').config ();

// dependencies
const print = require ('./print.js');

const os = require ('os');
const fs = require ('fs');

const acme = require ('acme-client');
const dateDiff = require ('date-range-diff');

const Docker = require ('dockerode'); const docker = new Docker ();
const DockerEvents = require ('docker-events');
const dockerEvents = new DockerEvents ({docker: docker});

const httpProxy = require ('http-proxy');
const http = require ('http');
const https = require ('https');
const tls = require ('tls');
const rateLimit = require ('http-ratelimit');

const memoize = require ('nano-memoize');
const bcrypt = require ('bcryptjs');
const compare = require ('tsscmp');

print (`starting process with hostname ${os.hostname()}...`);

// load keys for HTTPS server and Let's Encrypt
print (`loading keys and email address...`);
const defaultKey = fs.readFileSync (process.env.DEFAULT_KEY, 'utf-8');
const defaultCert = fs.readFileSync (process.env.DEFAULT_CRT, 'utf-8');
const acmeKey = fs.readFileSync (process.env.ACME_KEY, 'utf-8');
const email = ((fs.readFileSync (process.env.EMAIL, 'utf-8')).trim()).startsWith('mailto:') ?
    (fs.readFileSync (process.env.EMAIL, 'utf-8')).trim() :
    'mailto:' + (fs.readFileSync (process.env.EMAIL, 'utf-8')).trim();
print (`using email ${email}...`);

// acme client
const client = new acme.Client({
    directoryUrl: process.env.STAGING == 'true' ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey: acmeKey
});
print (`${ process.env.STAGING == 'true' ? 'using staging environment...':'using production environment...'}`);

// parse etcd hosts
print (`parsing etcd hosts...`);
const etcdHosts = process.env.ETCD.split (',');
for (let i = 0; i < etcdHosts.length; i++) {
    etcdHosts[i] = etcdHosts[i].trim();
};
print (`connecting to etcd...`);
const etcd = new Etcd (etcdHosts);

// create requisite directories for watchers
const challengeDir = typeof process.env.CHALLENGE_DIR === 'string' ? process.env.CHALLENGE_DIR : '/challenges';
etcd.mkdirSync (challengeDir);
const certDir = typeof process.env.CERT_DIR === 'string' ? process.env.CERT_DIR : '/certs';
etcd.mkdirSync (certDir);
const vHostDir = typeof process.env.VHOST_DIR === 'string' ? process.env.VHOST_DIR : '/virtual-hosts';
etcd.mkdirSync (vHostDir);

// initialize caches of virtual hosts, current certificates, and basic authentication
const certs = new Map ();
const vHosts = new Map ();
const dockerServices = new Map ();
const compareHash = memoize (bcrypt.compare, {maxAge: 1000 * 60 * 5}); // locally cache authentication(s)
// cache availability of certs
const isIterable = object =>
  object != null && object != undefined && typeof object[Symbol.iterator] === 'function'

const certNodes = etcd.getSync (`${certDir}`, {recursive: true});
if (certNodes &&
    certNodes.body &&
    certNodes.body.node &&
    certNodes.body.node.nodes && 
    isIterable (certNodes.body.node.nodes) ) {
    for (let certNode of certNodes.body.node.nodes) {
        certs.set (certNode.key.replace (`${certDir}/`, ''), certNode.value);
    };
};
// cache existing virtual hosts
const virtualHostNodes = etcd.getSync (`${vHostDir}`, {recursive: true});
if (virtualHostNodes &&
    virtualHostNodes.body &&
    virtualHostNodes.body.node &&
    virtualHostNodes.body.node.nodes && 
    isIterable (virtualHostNodes.body.node.nodes) ) {
    for (let virtualHostNode of virtualHostNodes.body.node.nodes) {
        const vHostDomain = virtualHostNode.key.replace (`${vHostDir}/`, '');
        const vHost = JSON.parse(virtualHostNode.value);
        vHosts.set (vHostDomain, vHost);
        dockerServices.set (vHost.serviceID, vHostDomain);
    };
};

// elect and monitor proxy leader
const electionDir = typeof process.env.ELECTION_DIR === 'string' ? process.env.ELECTION_DIR : '/leader';
print (`electing leader using key ${electionDir}...`);
const election = etcdLeader(etcd, electionDir, uuid, 10).start();
var isLeader = false;
election.on ('elected', async () => {
    isLeader = true;
    print (`this node ${uuid} elected as leader`);
    print (`initializing Let's Encrypt account...`);
    await client.createAccount({
        termsOfServiceAgreed: true,
        contact: [email]
    });
});
election.on ('unelected', () => {
    isLeader = false;
    print (`this node ${uuid} is no longer leader`);
});
election.on ('leader', (node) => {
    print (`node ${node} elected as leader`);
})
election.on ('error', (error) => {
    print (error.name);
    print (error.message);
    process.exitCode = 1;
});

// listen to docker socket for new services
dockerEvents.start ();
dockerEvents.on ('_message', async (event) => {
    // on service creation or update
    if (event.Type === 'service') {
        if (event.Action === 'update' || event.Action === 'create') {
            print (`detected updated docker service ${event.Actor.ID}`);
            const service = await docker.getService (event.Actor.ID).inspect();
            // check that the service has the requisite label(s)
            if (service.Spec.Labels.VIRTUAL_HOST) {
                await addService (service);
            };
        };

        if (event.Action === 'remove') {
            print (`detected removed docker service ${event.Actor.ID}`);
            await removeService (event.Actor.ID);
        };
    };
});

// poll docker periodically in case of missed eventns
const dockerPoll = setInterval (async () => {
    print ('polling docker services...');
    const allServices = await docker.listServices ();
    // for every service
    for await (let service_ of allServices) {
        const ID = service_.ID;
        // get all service details
        const service = await docker.getService (ID).inspect ();
        // docker has valid service but it is not in agassi
        if (service.Spec.Labels.VIRTUAL_HOST && !dockerServices.has (ID)) {
            print (`found previously unknown service ${ID}`);
            await addService (service);
        };
    };

    // agassi has service that is no longer in docker
    for await (let knownService of Array.from (dockerServices.keys())) {
        if (!allServices.find ((service) => { knownService == service.ID; })) {
            print ('removing dangling service');
            await removeService (knownService);
        };
    };
}, 60 * 1000);

// watch for new ACME challenges
const challengeWatcher = etcd.watcher (challengeDir, null, {recursive: true})
.on ('set', async (event) => {

    // only the leader communicates that a challenge is ready
    print (`found new ACME challenge`);
    if (isLeader) {
        // queue the completion on the remote ACME server and wait
        print (`completing challenge and awaiting validation...`);
        const value = JSON.parse (event.node.value);
        await client.completeChallenge (value.challenge);
        await client.waitForValidStatus(value.challenge);

        // remove completed challeng
        print (`removing completed challenge...`);
        await etcd.delAsync (event.node.key);

        // challenge is complete and valid, send cert-signing request
        print (`creating CSR for ${value.domain} ...`);
        const [key, csr] = await acme.forge.createCsr({
            commonName: value.domain
        }, defaultKey);

        // finalize the order and pull the cert
        print (`finalizing order and downloading cert for ${value.domain} ...`);
        await client.finalizeOrder(value.order, csr);
        const cert = await client.getCertificate(value.order);

        // add cert to etcd with expiration
        print (`adding cert to etcd...`);
        await etcd.setAsync (`${certDir}/${value.domain}`, cert, {ttl: 7776000}); // 90-day ttl
    };
})
.on ('error', (error) => {
    print (error.name);
    print (error.message);
});

// watch for new certs
const certWatcher = etcd.watcher (certDir, null, {recursive: true})
.on ('set', (event) => {
    const domain = event.node.key.replace (`${certDir}/`, '');
    print (`found new cert for ${domain} in etcd`);
    certs.set (domain, event.node.value);
})
.on ('expire', (event) => {
    const domain = event.node.key.replace (`${certDir}/`, '');
    print (`cert for ${domain} expired`);
    certs.delete (domain);
})
.on ('error', (error) => {
    print (error.name);
    print (error.message);
});

// watch for new and/or removed virtual hosts
const vHostWatcher = etcd.watcher (vHostDir, null, {recursive: true})
.on ('set', (event) => {
    print (`found new virtual host in etcd`);
    const vHostDomain = event.node.key.replace (`${vHostDir}/`, '');
    const vHost = JSON.parse (event.node.value);
    print (`caching virtual host for ${vHostDomain} ...`);
    vHosts.set (vHostDomain, vHost);
})
.on ('delete', (event) => {
    print (`virtual host deleted in etcd`);
    const vHostDomain = event.node.key.replace (`${vHostDir}/`, '');
    print (`removing virtual host ${vHostDomain} from cache...`);
    vHosts.delete (vHostDomain);
})
.on ('error', (error) => {
    print (error.name);
    print (error.message);
});

// create proxy server
const proxy = httpProxy.createProxyServer({
    secure: false,
    followRedirects: true,
})
.on ('proxyReq', (proxyRequest, request) => {
    if (request.host != null) {
        proxyRequest.setHeader ('host', request.host);
    };
})
.on ('error', (error) => {
    print (error.name);
    print (error.message);
    process.exitCode = 1;
});

// create HTTP server to answer challenges and redirect
http.createServer (async (request, response) => {
    // check request path
    const requestURL = new URL(request.url, `http://${request.headers.host}`);
    // if request is for ACME challenge
    if (requestURL.pathname && requestURL.pathname.startsWith('/.well-known/acme-challenge/')) {

        // pull challenge response from etcd
        const token = requestURL.pathname.replace('/.well-known/acme-challenge/', '');
        const value = (await etcd.getAsync (`${challengeDir}/${token}`)).node.value;
        const challengeResponse = JSON.parse (value).response;

        // write challenge response to request
        print (`responding to challenge request...`);
        response.writeHead(200, {
            'Content-Type': 'text/plain'
        });
        response.write (challengeResponse);
        response.end();

    } else {

        // redirect to https
        const redirectLocation = "https://" + request.headers['host'] + request.url;
        response.writeHead(301, {
            "Location": redirectLocation
        });
        response.end();

    };
})
.on ('error', (error) => {
    print (error.name);
    print (error.message);
    process.exitCode = 1;
})
.listen (80, null, (error) => {
    if (error) {
        print (error.name);
        print (error.message);
        process.exitCode = 1;
    } else {
        print (`listening on port 80...`);
    };
});

// display realm on basic auth prompt
const realm = typeof process.env.REALM === 'string' ? process.env.REALM : 'Agassi';

// create HTTPS server 
https.createServer ({
    SNICallback: (domain, callback) => {
        if (certs.has(domain)) {
            return callback (null, tls.createSecureContext({
                key: defaultKey,
                cert: certs.get(domain)
            }));
        } else {
            process.exitCode = 1;
            return callback (null, false);
        };
    },
    key: defaultKey,
    cert: defaultCert
}, async (request, response) => {
    const requestURL = new URL(request.url, `https://${request.headers.host}`);
    let virtualHost = vHosts.get (requestURL.hostname);
    // if virtual host is not in cache
    if (!virtualHost) {
        try {
            // check for virtual host in etcd
            let vHost = await etcd.getAsync (`${vHostDir}/${requestURL.hostname}`);
            vHosts.set (requestURL.hostname, JSON.parse (vHost.value));
            virtualHost = vHosts.get (requestURL.hostname);
        } catch (error) {
            print (error.name);
            print (error.message);
        };
    };
    // if virtual host exists in cache or etcd
    if (virtualHost) {
        // basic auth protected host
        if (virtualHost.auth) {
            // auth required but not provided
            if (!request.headers.authorization) {
                // prompt for password in browser
                response.writeHead(401, { 'WWW-Authenticate': `Basic realm="${realm}"`});
                response.end ('Authorization is required.');
                return;  
            };
            // failure rate limit reached
            if (rateLimit.isRateLimited(request, 2)) {
                response.writeHead(429, {
                    'Content-Type': 'text/plain'
                });
                response.end ('Authorization failed.');
                return;
            };

            // parse authentication header
            const requestAuth = (Buffer.from (request.headers.authorization.replace(/^Basic/, ''), 'base64')).toString('utf-8');
            const [requestUser, requestPassword] = requestAuth.split (':');

            // parse vHost auth parameter
            const [virtualUser, virtualHash] = virtualHost.auth.split (':');

            // compare provided header with expected values
            if ((compare(requestUser, virtualUser)) && (await compareHash (requestPassword, virtualHash))) {
                proxy.web (request, response, virtualHost.options);
            } else {
                // rate limit failed authentication
                rateLimit.inboundRequest(request);
                // prompt for password in browser
                response.writeHead(401, { 'WWW-Authenticate': `Basic realm="${realm}"`});
                response.end ('Authorization is required.');
            };

        } else {
            // basic auth not required 
            proxy.web (request, response, virtualHost.options);
        };
    };
})
.on ('error', (error) => {
    print (error.name);
    print (error.message);
    process.exitCode = 1;
})
.listen (443, null, (error) => {
    if (error) {
        print (error.name);
        print (error.message);
        process.exitCode = 1;
    } else {
        rateLimit.init ();
        print (`listening on port 443...`);
    };
});

// periodically check for expriring certificates
const renewInterval = process.env.RENEW_INTERVAL ? parseInt (process.env.RENEW_INTERVAL) * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
const renewPoll = setInterval (async () => {
    try {
        // only leader runs renewals
        if (isLeader) {
            // fetch all certificates
            const allCerts_ = await etcd.getAsync (certDir, {recursive: true});
            const allCerts = allCerts_.node.nodes;

            // check if each cert is approaching expiration
            for await (let cert of allCerts) {
                const domain = cert.key.replace (`${certDir}/`, '');
                const daysUntilExpiration = dateDiff (new Date (cert.expiration), new Date ());
                print (`certificate for ${domain} expires in ${daysUntilExpiration} days`);
                // only renew certs for domains with virtual hosts
                if (vHosts.has (domain) && daysUntilExpiration < 45) {
                    // place order for signed certificate
                    print (`renewing Let's Encrypt certificate for ${domain} ...`);
                    await placeCertOrder (domain);
                };
            };
        };
    } catch (error) {
        print (error.name);
        print (error.message);
    };
        
}, renewInterval); // run once per set interval

// graceful exit
process.once ('SIGTERM', () => {
    print (`SIGTERM received...`);
    print (`Shutting down...`);

    // stop docker listener
    dockerEvents.stop ();

    // close servers
    http.close ();
    https.close ();
    proxy.close ();

    // stop etcd watchers
    challengeWatcher.stop ();
    certWatcher.stop ();
    vHostWatcher.stop ();

    // stop periodic events
    clearInterval (dockerPoll);
    clearInterval (renewPoll);

    // shutdown election
    election.stop ();
});

/*-----------------------------------------------------------------------------------------------\
|----------------------------------- helper functions -------------------------------------------|
\-----------------------------------------------------------------------------------------------*/

// add a new docker service to agassi
async function addService (service) {
    // parse virtual host
    const virtualURL = new URL (service.Spec.Labels.VIRTUAL_HOST);

    // map docker service ID to hostname
    dockerServices.set (service.ID, virtualURL.hostname);
    // only the leader creates new hosts
    if (isLeader) {
        const virtualHost = {};
        virtualHost.serviceID = service.ID;
        // this is where default options are set
        virtualHost.options = {};
        // virtualHost.options.secure = false; // do not check other ssl certs
        virtualHost.options.target = `${virtualURL.protocol}//${service.Spec.Name}:${virtualURL.port}`;
        print (`target set to ${virtualURL.protocol}//${service.Spec.Name}:${virtualURL.port}`);
        // check if auth is required
        if (service.Spec.Labels.VIRTUAL_AUTH) {
            // decode base64
            virtualHost.auth = ((Buffer.from (service.Spec.Labels.VIRTUAL_AUTH, 'base64')).toString('utf-8')).trim();
            print (`virtual auth read as ${virtualHost.auth}`);
        };
        // check if etcd already has a cert for this domain
        if (certs.has (virtualURL.hostname)) {
            print (`using existing cert for ${virtualURL.hostname}`);
        };
        print (`adding virtual host to etcd...`);
        await etcd.setAsync (`${vHostDir}/${virtualURL.hostname}`,
            JSON.stringify (virtualHost)
        );

        // if domain does not already have a cert && only the leader
        if (!certs.has (virtualURL.hostname)) {
            // place order for signed certificate
            print (`ordering Let's Encrypt certificate for ${virtualURL.hostname} ...`);
            await placeCertOrder (virtualURL.hostname);
        };
    };
};

async function removeService (serviceID) {

    if (dockerServices.has (serviceID)) {
        // only leader handles etcd hosts
        if (isLeader) {
            print (`removing virtual host ${dockerServices.get (serviceID)} from etcd and cache...`);
            await etcd.delAsync (`${vHostDir}/${dockerServices.get (serviceID)}`);
        };
        dockerServices.delete (serviceID);
    } else {
        print (`docker service ${serviceID} has no virtual host`);
    };
}

// create a new certificate order and add response to etcd 
async function placeCertOrder (domain) {

    const order = await client.createOrder({
        identifiers: [
            { type: 'dns', value: domain },
        ]
    });

    // get http authorization token and response
    print (`getting authorization token for ${domain} ...`);
    const authorizations = await client.getAuthorizations(order);
    const httpChallenge = authorizations[0]['challenges'].find (
        (element) => element.type === 'http-01');
    const httpAuthorizationToken = httpChallenge.token;
    const httpAuthorizationResponse = await client.getChallengeKeyAuthorization(httpChallenge);

    // add challenge and response to etcd
    print (`setting token and response for ${domain} in etcd...`);
    await etcd.setAsync (`${challengeDir}/${httpAuthorizationToken}`, // key
        JSON.stringify({ // etcd value
            domain: domain,
            order: order,
            challenge: httpChallenge,
            response: httpAuthorizationResponse
        }
    ), { ttl: 864000 }); // 10-day expiration
};