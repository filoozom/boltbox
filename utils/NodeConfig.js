const { promisify } = require('util')
const assert = require('assert')
const exec = promisify(require('child_process').exec)

/**
 * A class used to create NodeConfigs, useful for spinning up a node or a network of
 * lightning nodes via docker-compose (e.g. for simnet bootstrap)
 * @params {String} name - name of node (e.g. 'alice', 'bob', 'carol')
 * @params {Number} rpc - RPC port that will be exposed and used to communicate via lncli container
 * @params {Boolean} neutrino - whether or not to run as neutrino light client
 * @params {Number} p2p - p2p listening port
 */
class NodeConfig {
  constructor({ name, rpc, neutrino, p2p, rest, network = 'mainnet', lnddir, backend, verbose }) {
    assert(typeof rpc === 'number', 'NodeConfig requires a custom rpc port to create a node')
    assert(typeof p2p === 'number', 'NodeConfig requires a custom p2p listening port to create a node')
    assert(typeof name === 'string', 'NodeConfig requires a string to set the name of the node to')

    this.name = name
    this.rpcPort = rpc
    this.p2pPort = p2p
    if (rest) assert(typeof rest === 'number', 'NodeConfig requires a custom rpc port to create a node')
    this.restPort = rest || 8080
    this.lnddir = lnddir || `/lnd-data/${name}`
    this.network = network
    this.lncli = `docker-compose run --rm -e LND_DIR=${this.lnddir} -e RPCSERVER="${name}:${rpc}" -e NETWORK=${network} lncli`
    this.env = {
      NETWORK: network,
      COMPOSE_INTERACTIVE_NO_CLI: true,
      UID: process.env.UID || '',
      GROUPS: process.env.GID || '',
      TLSEXTRADOMAIN: this.name // adds docker host to be added to tls cert
    }

    if (neutrino) {
      assert(typeof neutrino === 'boolean', 'Must pass a boolean for neutrino option')
      this.neutrino = neutrino
    }

    if (backend) {
      assert(typeof backend === 'string', 'Must pass a string to use as backend connetion information')
      this.backend = backend
    } else if (neutrino && network === 'simnet') {
      this.backend = 'btcd:18555'
    } else if (neutrino && network === 'testnet') {
      this.backend = 'faucet.lightning.community:18333'
    }

    this.verbose = false
    if (verbose) {
      assert(typeof verbose === 'boolean', 'Expected boolean value for verbose option.')
      this.verbose = verbose
    }
  }

  async startNode() {
    let startCmd = `docker-compose run -d \
    -e LND_DIR='${this.lnddir}' \
    -e RPCLISTEN=${this.rpcPort} \
    -e RESTLISTEN=${this.restPort} \
    -e NOSEEDBACKUP='true'\
    -e TLSEXTRADOMAIN='${this.name}' \
    -e MONITORING='true'\
    -e LISTEN='${this.p2pPort}'\
    -e LND_ALIAS='${this.name}'`

    if (this.neutrino) {
      startCmd = `${startCmd} -e NEUTRINO=${this.backend} -e BACKEND=neutrino`
    }

    startCmd = `${startCmd} \
    -p ${this.rpcPort}:${this.rpcPort} \
    -p ${this.p2pPort}:${this.p2pPort} \
    --name ${this.name} lnd_btc`

    startCmd = startCmd.replace(/\s\s+/g, ' ')

    if (this.verbose) console.log(`Starting ${this.name} node: ${startCmd}`)
    try {
      await exec(startCmd, { env: this.env })
    } catch (e) {
      if (e.message.match(/Cannot create container for service lnd_btc: Conflict/g))
        console.warn(`Container for ${this.name} already exists. Skipping startup.`)
      else throw e
    }

    console.log(`Testing connection with ${this.name}...`)

    const { identity_pubkey: identityPubkey } = await this.getInfo()

    this.identityPubkey = identityPubkey

    console.log(`${this.name.toUpperCase()} pubkey: ${this.identityPubkey}\n`)
    return
  }

  async exec(cmd) {
    if (typeof cmd !== 'string') throw new Error('must pass a string for the list of commands to run w/ lncli')

    let counter = 1,
      connection = false,
      tries = 5,
      error
    // only want to return when the node is reachable
    while (!connection && counter < tries) {
      try {
        let { stdout, stderr } = await exec(`${this.lncli} ${cmd}`, { env: this.env })
        if (stdout && stdout.length) {
          connection = true
          return JSON.parse(stdout)
        } else if (stderr && stderr.length) {
          throw new Error('Problem connecting to node:', stderr)
        } else {
          throw new Error('No response from container.')
        }
      } catch (e) {
        // update the error each time one is thrown. We will throw the last one
        // after the loop has run past the counter
        error = `Problem executing command for ${this.name}: ${cmd} \nError: ${e.message}`
        if (this.verbose && counter < tries - 1) {
          console.error(error)
          console.error('Trying again...\n')
        }
      }
      counter++
    }

    if (!connection) throw new Error(error)
  }

  getInfo() {
    return this.exec('getinfo')
  }

  async getAddress() {
    const address = await this.exec('newaddress np2wkh')
    if (!address || !address.address) {
      console.error('Problem with address response:', address)
      return this.getAddress()
    }
    return address.address
  }

  async getBalance() {
    const balance = await this.exec('walletbalance')
    if (!balance) return this.getBalance()
    return balance
  }

  async channelBalance() {
    const balance = await this.exec('channelbalance')
    if (!balance) return this.channelBalance()
    return balance
  }

  async listPeers() {
    const peers = await this.exec('listpeers')
    if (!peers) return this.listPeers()
    return peers.peers
  }

  async listChannels() {
    const channels = await this.exec('listchannels')
    if (!channels) return this.listChannels()
    return channels.channels
  }

  async openChannel(nodeOrIdentity, local, push = 0) {
    let nodeKey = nodeOrIdentity.identityPubkey || nodeOrIdentity
    assert(typeof nodeKey === 'string' && nodeKey.length, 'Expected either a NodeConfig or an identity pubkey string')
    assert(typeof local === 'number', 'Expected an amount of satoshis to open the channel with ')
    assert(typeof push === 'number', 'Push amount for channel open must be an integer (number of satoshis)')

    const resp = await this.exec(`openchannel ${nodeKey} ${local} ${push}`)

    return resp
  }
}

module.exports = NodeConfig
