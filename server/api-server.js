const ws = require('ws')
const protocol = require('../lib/protocol.js')
const axios = require('axios')
const objecthash = require('object-hash')
const crypto = require('crypto')
const { marshalTx, unmarshalTx } = require('./amino.js')
const format = require('./format.js')
const config = require('./config.js')

// Set to true if you want blocks and events stored in mongo
const USE_DATABASE = config.use_database 

// This seems to work regardless so disabling with default to true
const PRUNING_OFF = true

const LOG_API = false
const LOG_TX = false

if (USE_DATABASE) {
  var db = require('./database.js')
}

process.on('unhandledRejection', error => {
  if (error !== undefined) {
    console.log('unhandled promise rejection: ', error.message);
    console.log(error.stack)
  } else {
    console.log("promise rejection")
  }
  //process.exit(-1)
});

// Subscriptions (websocket)
const tendermint = config.tendermint

// Transactions
const NEWBLOCK = "tm.event='NewBlock'"
const TXTIMEOUT = config.timeout
const pending = {}

// REST calls to Tendermint and Cosmos through ABCI

const queryTendermint = async url => {
  const query = "http://" + tendermint + url
  const res = await axios.get(query)
  return res.data.result
}

const queryCosmos = async (path, height) => {
  var query = "http://" + tendermint + '/abci_query?path="/custom' + path + '"'
  if (height !== undefined) {
    query = query + "&height=" + height
  }
  const res = await axios.get(query)
  if (res.data.result.response.code !== 0) {
    //console.log("query=" + query)
    //console.log(JSON.stringify(res.data, null, 2))
    const obj = JSON.parse(res.data.result.response.log)
    throw new Error(obj.message)
  }
  if (res.data.result.response.value === null) {
    throw new Error("Received null response")
  } else {
    const data = Buffer.from(res.data.result.response.value, 'base64')
    return JSON.parse(data.toString())
  }
}

const queryHistBalance = async (acct, height) => {
  if (USE_DATABASE) {
    const balance = await queryCosmos("/microtick/account/" + acct, height)
    return parseFloat(balance.balance.amount)
  } else {
    return 0
  }
}

// API query caching
var cache = {}
var txcounter = 0
var curheight = 0

const shortHash = hash => {
  // uncomment this for shorthand hashes in logs
  //return hash.slice(0,6)
  return "'" + hash + "'"
}

// Tx sequencing

const nextSequenceNumber = (acct, res) => {
  if (cache.accounts === undefined) {
    cache.accounts = {}
  }
  if (cache.accounts[acct] === undefined) {
    cache.accounts[acct] = {}
  }
  if (cache.accounts[acct].nextSequenceNumber === undefined) {
    cache.accounts[acct].pendingSequenceNumber = parseInt(res.sequence, 10)
    cache.accounts[acct].queue = {}
  } else {
    res.sequence = cache.accounts[acct].nextSequenceNumber.toString()
  }
  cache.accounts[acct].nextSequenceNumber = parseInt(res.sequence, 10) + 1
}

setInterval(async () => {
  if (cache === undefined || cache.accounts === undefined) {
    return
  }
  const accts = Object.keys(cache.accounts)
  accts.map(async acct => {
    const pool = cache.accounts[acct]
    if (pool.queue === undefined || pool.pendingSequenceNumber === undefined) return
    if (pool.queue[pool.pendingSequenceNumber] !== undefined) {
      await pool.queue[pool.pendingSequenceNumber].submit(acct, pool.pendingSequenceNumber)
      delete pool.queue[pool.pendingSequenceNumber]
      pool.pendingSequenceNumber++
    }
  })
}, 100)

// Tendermint websocket (single connection for new blocks)

// Added at subsciption time: mapping market -> []id
const marketSubscriptions = {}
// Maintained at connection: id -> client
const clients = {}
const ids = {}

const connect = async () => {
    
  const tmclient = new ws("ws://" + tendermint + "/websocket")
  
  tmclient.on('open', () => {
    console.log("Tendermint connected")
    
    const req = {
      "jsonrpc": "2.0",
      "method": "subscribe",
      "id": "0",
      "params": {
        "query": NEWBLOCK
      }
    }
    tmclient.send(JSON.stringify(req))
  })

  tmclient.on('message', msg => {
    const obj = JSON.parse(msg)
    if (obj.result === undefined) {
      console.log("Tendermint message error: " + JSON.stringify(obj, null, 2))
      tmclient.close()
      return
    }
    if (obj.result.data !== undefined) {
      handleNewBlock(obj)
    }
  })

  tmclient.on('close', () => {
    console.log("Tendermint disconnected")
    console.log("Attempting to reconnect")
    setTimeout(connect, 1000)
  })

  tmclient.on('error', err => {
    this.err = err
    console.log("Tendermint error: " + err.message)
  })
}

connect()

const dump_subscriptions = () => {
  console.log("Active Connections:")
  const accts = Object.keys(ids)
  if (accts.length > 0) {
    accts.map(acct => {
      ids[acct].map(id => {
        console.log("  Connection ID: [" + id + "] account: " + acct)
      })
    })
  }
  console.log("Active Market Subscriptions:")
  const keys = Object.keys(marketSubscriptions)
  if (keys.length > 0) {
    keys.map(key => {
      if (marketSubscriptions[key].length > 0) {
        console.log("  " + key + " => " + JSON.stringify(marketSubscriptions[key]))
      }
    })
  }
}

// Connected API clients

const subscribeMarket = (id, event) => {
  console.log("Subscribe: connection " + id + " => " + event)
  if (marketSubscriptions[event] === undefined) {
    marketSubscriptions[event] = [id]
  } else if (!marketSubscriptions[event].includes(id)) {
    marketSubscriptions[event].push(id)
  }
}
  
const unsubscribeMarket = (id, event) => {
  console.log("Unsubscribe: connection " + id + " => " + event)
  if (marketSubscriptions[event] === undefined) return
  marketSubscriptions[event] = marketSubscriptions[event].reduce((acc, thisid) => {
    if (thisid !== id) {
      acc.push(thisid)
    }
    return acc
  }, [])
}

var syncing = false
var chainHeight = 0

const broadcastBlock = block => {
  if (syncing) return
  const msg = apiProtocol.createEvent('block', block.height, block)
  Object.keys(clients).map(id => {
    const client = clients[id] 
    if (client !== undefined) {
      console.log("  Event New Block => [" + id + "]")
      client.send(msg)
    }
  })
}

const broadcastTick = (market, consensus) => {
  if (syncing) return
  if (marketSubscriptions[market] === undefined) return
  const msg = apiProtocol.createEvent('tick', market, consensus)
  //console.log("marketSubscriptions:[" + event + "] " + marketSubscriptions[event])
  marketSubscriptions[market].map(id => {
    const client = clients[id]
    if (client !== undefined) {
      console.log("  Event Market Tick: " + market + " => ["+ id + "]")
      client.send(msg)
    }
  })
}

const sendAccountEvent = (acct, event, payload) => {
  if (syncing) return
  if (format.fullTx[event] === undefined) return
  const formatted = format.fullTx[event](payload)
  const msg = apiProtocol.createEvent('account', event, formatted)
  if (ids[acct] !== undefined) {
    ids[acct].map(id => {
      const client = clients[id]
      if (client !== undefined) {
        console.log("  Account Event: " + event + " => [" + id + "]")
        client.send(msg)
      }
    })
  }
}

const handleNewBlock = async obj => {
  chainHeight = parseInt(obj.result.data.value.block.header.height, 10)
  const chainid = obj.result.data.value.block.header.chain_id
  if (USE_DATABASE) {
    if (syncing) return
    await db.init(config.mongo, chainid)
    const dbHeight = await db.height()
    if (dbHeight < chainHeight - 1) {
      //console.log("dbHeight=" + dbHeight)
      //console.log("chainHeight=" + chainHeight)
      console.log("Syncing...")
      syncing = true
      for (var i=dbHeight + 1; i < chainHeight; i++) {
        await processBlock(chainid, i)
      }
      console.log("Done syncing...")
      syncing = false
    }
  }
    
  cache = {
    accounts: {}
  }
  
  await processBlock(chainid, chainHeight)
    
  // Check pending Tx hashes
  const hashes = Object.keys(pending)
  if (hashes.length > 50) {
    console.log("Warning: " + hashes.length + " pending Txs")
  }
  hashes.map(async hash => {
    const url = "http://" + tendermint + "/tx?hash=0x" + hash
    const res = await axios.get(url)
    if (res.data.error !== undefined) {
      pending[hash].tries++
      if (pending[hash].tries > 2) {
        console.log("TX error: " + hash + " " + JSON.stringify(res.data.error))
        pending[hash].failure(res.data.error)
        pending[hash].timedout = true
      }
    } else if (res.data.result !== undefined) {
      const result = res.data.result
      if (result.tx_result.code !== 0) {
        //console.log(JSON.stringify(result), null, 2)
        const log = JSON.parse(result.tx_result.log)
        //console.log(JSON.stringify(log))
        if (log.length > 0) {
          const log2 = JSON.parse(log[0].log)
          console.log("TX failure: hash=" + shortHash(hash))
          pending[hash].failure(log2)
        } else {
          console.log("TX failure")
          pending[hash].failure(new Error("TX failed"))
        }
      } else {
        if (LOG_TX) console.log("TX success: hash=" + shortHash(hash))
        pending[hash].success(res.data.result)
      }
      pending[hash].timedout = true
    }
    if (pending[hash].timedout) {
      //console.log("Deleting pending TX: " + hash)
      delete pending[hash]
    }
  })
}

const processBlock = async (chainid, height) => {
  curheight = height
  //console.log(JSON.stringify(obj, null, 2))
  const block = await queryTendermint('/block?height=' + height)
  const results = await queryTendermint('/block_results?height=' + height)
  block.height = height // replace string with int 
  block.time = Date.parse(block.block.header.time)
  
  const num_txs = parseInt(block.block.header.num_txs, 10)
  if (!syncing) {
    console.log()
  }
  console.log("Block " + block.height + ": txs=" + num_txs)
  if (!syncing) {
    dump_subscriptions()
  }
  if (!syncing) console.log("Events:")
  broadcastBlock({
    height: block.height,
    time: block.time,
    hash: block.block.header.last_block_id.hash,
    chainid: chainid
  })
  if (num_txs > 0) {
    const txs = block.block.data.txs
    for (var i=0; i<txs.length; i++) {
      //console.log("TX #" + i)
      const txb64 = txs[i]
      var bytes = Buffer.from(txb64, 'base64')
      var hash = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase()
      const res64 = results.results.deliver_tx[i]
      if (res64.code === 0) {
        // Tx successful
        const bytes = new Buffer(txb64, 'base64')
        const baseTx = unmarshalTx(bytes)
        const txstruct = {
          events: {}
        }
        if (res64.data !== null) {
          txstruct.result = JSON.parse(Buffer.from(res64.data, 'base64').toString())
          //console.log(JSON.stringify(result, null, 2))
        }
        for (var j=0; j<res64.events.length; j++) {
          const event = res64.events[j]
          for (var attr = 0; attr < event.attributes.length; attr++) {
            const a = event.attributes[attr]
            const key = Buffer.from(a.key, 'base64').toString()
            if (a.value !== undefined) {
              const value = Buffer.from(a.value, 'base64').toString()
              txstruct.events[key] = value
              //await processEvent(block, result, key, value)
            }
          }
        }
        //console.log("Result " + txstruct.module + " / " + txstruct.action + ": hash=" + shortHash(hash))
        if (txstruct.events.module === "microtick") {
          await processMicrotickTx(block, txstruct)
        } 
        if (txstruct.events.module === "bank" && txstruct.events.action === "send") {
          const depositPayload = {
            type: "deposit",
            from: txstruct.events.sender,
            account: txstruct.events.recipient,
            height: block.height,
            amount: parseFloat(txstruct.events.amount) / 1000000.0,
            time: block.time,
            memo: baseTx.value.memo
          }
          if (PRUNING_OFF) {
            depositPayload.balance = await queryHistBalance(txstruct.events.recipient, block.height)
          }
          const withdrawPayload = {
            type: "withdraw",
            account: txstruct.events.sender,
            to: txstruct.events.recipient,
            height: block.height,
            amount: parseFloat(txstruct.events.amount) / 1000000.0,
            time: block.time,
            memo: baseTx.value.memo
          }
          if (PRUNING_OFF) {
            withdrawPayload.balance = await queryHistBalance(txstruct.events.sender, block.height)
          }
          sendAccountEvent(txstruct.events.recipient, "deposit", depositPayload)
          sendAccountEvent(txstruct.events.sender, "withdraw", withdrawPayload)
          if (USE_DATABASE) {
            db.insertAccountEvent(block.height, txstruct.events.recipient, "deposit", depositPayload)
            db.insertAccountEvent(block.height, txstruct.events.sender, "withdraw", withdrawPayload)
          }
        }
      }
    }
  }
  if (USE_DATABASE) {
    await db.insertBlock(block.height, block.time)
  }
}

const processMicrotickTx = async (block, tx) => {
  if (tx.result !== undefined) {
    tx.result.height = block.height
    tx.result.balance = {}
  }
  if (tx.events['mtm.MarketTick'] !== undefined) {
    const market = tx.events['mtm.MarketTick']
    const consensus = parseFloat(tx.result.consensus.amount)
    if (USE_DATABASE) {
      await db.insertMarketTick(block.height, block.time, market, consensus)
    }
    broadcastTick(market, {
      height: block.height,
      time: block.time,
      consensus: consensus
    })
  }
  Promise.all(Object.keys(tx.events).map(async e => {
    if (e.startsWith("acct.")) {
      const account = e.slice(5)
      if (PRUNING_OFF) {
        tx.result.balance[account] = await queryHistBalance(account, block.height)
      }
      if (USE_DATABASE) {
        await db.insertAccountEvent(block.height, account, tx.events[e], tx.result)
      }
      sendAccountEvent(account, tx.events[e], tx.result)
    }
  }))
  Promise.all(Object.keys(tx.events).map(async e => {
    if (e.startsWith("quote.")) {
      const id = parseInt(e.slice(6), 10)
      if (USE_DATABASE) {
        await db.insertQuoteEvent(block.height, id, tx.events[e], tx.result)
      }
    }
    if (e.startsWith("trade.")) {
      const id = parseInt(e.slice(6), 10)
      if (USE_DATABASE) {
        await db.insertTradeEvent(block.height, id, tx.events[e], tx.result)
      }
    }
  }))
}

// API Server Listener

var connectionId = 1

const server = new ws.Server({
  host: config.host,
  port: config.port,
})

server.on('connection', async client => {
  
  const env = {
    id: connectionId++
  }
  
  clients[env.id] = client
  
  client.on('message', async msg => {
    const response = await apiProtocol.process(env, msg)
    if (response !== undefined) {
      client.send(response)
    }
  })
  
  client.on('close', () => {
    console.log("Disconnect " + env.id)
    const id = env.id
    delete clients[id]
    ids[env.acct] = ids[env.acct].reduce((acc, arrid) => {
      if (arrid !== id) {
        acc.push(arrid)
      }
      return acc
    }, [])
    Object.keys(marketSubscriptions).map(key => {
      marketSubscriptions[key] = marketSubscriptions[key].reduce((acc, subid) => {
        if (subid != id) acc.push(subid)
        return acc
      }, [])
    })
    //const acct = env.acct
  })
  
})

const apiProtocol = new protocol(10000, async (env, name, payload) => {
  return await handleMessage(env, name, payload)
})

const handleMessage = async (env, name, payload) => {
  if (name !== "posttx") {
    var hash = objecthash({
      name: name,
      payload: payload
    }) 
  
    if (cache[hash] !== undefined) {
      if (LOG_API) console.log("Responding from cache: [" + env.id + "] " + name + " " + JSON.stringify(payload))
      return cache[hash]
    } else {
      if (LOG_API) console.log("API call: [" + env.id + "] " + name + " " + JSON.stringify(payload))
    }
  }
  
  var returnObj
  var res
  try {
    switch (name) {
      case 'connect':
        env.acct = payload.acct
        console.log("Incoming connection [" + env.id + "] account=" + env.acct + "'")
        if (ids[env.acct] === undefined) {
          ids[env.acct] = []
        }
        ids[env.acct].push(env.id)
        return {
          status: true
        }
      case 'subscribe':
        subscribeMarket(env.id, payload.key)
        return {
          status: true
        }
      case 'unsubscribe':
        unsubscribeMarket(env.id, payload.key)
        return {
          status: true
        }
      case 'blockinfo':
        res = await queryTendermint('/status')
        returnObj = {
          status: true,
          chainid: res.node_info.network,
          block: parseInt(res.sync_info.latest_block_height, 10),
          timestamp: Math.floor(new Date(res.sync_info.latest_block_time).getTime() / 1000)
        }
        break
      case 'getacctinfo':
        res = await queryCosmos('/microtick/account/' + payload.acct)
        returnObj = {
          status: true,
          info: {
            account: res.account,
            balance: parseFloat(res.balance.amount),
            numquotes: res.numQuotes,
            numtrades: res.numTrades,
            activeQuotes: res.activeQuotes,
            activeTrades: res.activeTrades,
            quoteBacking: parseFloat(res.quoteBacking.amount),
            tradeBacking: parseFloat(res.tradeBacking.amount),
            settleBacking: parseFloat(res.settleBacking.amount)
          }
        }
        break
      case 'getmarketinfo':
        res = await queryCosmos('/microtick/market/' + payload.market)
        returnObj = {
          status: true,
          info: {
            market: res.market,
            consensus: parseFloat(res.consensus.amount),
            sumBacking: parseFloat(res.sumBacking.amount),
            sumWeight: parseFloat(res.sumWeight.amount),
            orderBooks: res.orderBooks.map(ob => {
              return {
                sumBacking: parseFloat(ob.sumBacking.amount),
                sumWeight: parseFloat(ob.sumWeight.amount),
                insideCall: parseFloat(ob.insideCall.amount),
                insidePut: parseFloat(ob.insidePut.amount)
              }
            })
          }
        }
        break
      case 'getorderbookinfo':
        res = await queryCosmos('/microtick/orderbook/' + payload.market + "/" + 
          payload.duration)
        returnObj = {
          status: true,
          info: {
            sumBacking: parseFloat(res.sumBacking.amount),
            sumWeight: parseFloat(res.sumWeight.amount),
            calls: res.calls,
            puts: res.puts
          }
        }
        break
      case 'getmarketspot':
        res = await queryCosmos('/microtick/consensus/' + payload.market)
        returnObj = {
          status: true,
          info: {
            market: res.market,
            consensus: parseFloat(res.consensus.amount),
            sumbacking: parseFloat(res.sumBacking.amount),
            sumweight: parseFloat(res.sumWeight.amount)
          }
        }
        break
      case 'getlivequote':
        res = await queryCosmos('/microtick/quote/' + payload.id)
        returnObj = {
          status: true,
          info: {
            id: res.id,
            market: res.market,
            duration: res.duration,
            provider: res.provider,
            backing: parseFloat(res.backing.amount),
            spot: parseFloat(res.spot.amount),
            premium: parseFloat(res.premium.amount),
            quantity: parseFloat(res.quantity.amount),
            premiumAsCall: parseFloat(res.premiumAsCall.amount),
            premiumAsPut: parseFloat(res.premiumAsPut.amount),
            modified: Date.parse(res.modified),
            canModify: Date.parse(res.canModify)
          }
        }
        break
      case 'getlivetrade':
        res = await queryCosmos('/microtick/trade/' + payload.id)
        returnObj = {
          status: true,
          info: {
            id: res.id,
            market: res.market,
            duration: res.duration,
            option: res.type,
            long: res.long,
            start: Date.parse(res.start),
            expiration: Date.parse(res.expiration),
            backing: parseFloat(res.backing.amount),
            premium: parseFloat(res.premium.amount),
            quantity: parseFloat(res.quantity.amount),
            strike: parseFloat(res.strike.amount),
            currentSpot: parseFloat(res.currentSpot.amount),
            currentValue: parseFloat(res.currentValue.amount),
            commission: parseFloat(res.commission.amount),
            settleIncentive: parseFloat(res.settleIncentive.amount),
            counterparties: res.counterparties.map(cp => {
              return {
                backing: parseFloat(cp.backing.amount),
                premium: parseFloat(cp.premium.amount),
                quantity: parseFloat(cp.quantity.amount),
                final: cp.final,
                short: cp.short,
                quoted: {
                  id: cp.quoted.id,
                  premium: parseFloat(cp.quoted.premium.amount),
                  quantity: parseFloat(cp.quoted.quantity.amount),
                  spot: parseFloat(cp.quoted.spot.amount)
                }
              }
            })
          }
        }
        break
      case 'gethistquote':
        res = await db.queryHistQuote(payload.id, payload.startBlock, payload.endBlock)
        returnObj = {
          status: true,
          info: res
        }
        break
      case 'gethisttrade':
        res = await db.queryHistTrade(payload.id)
        res.curheight = curheight
        returnObj = {
          status: true,
          info: res
        }
        break
      case 'accountsync':
        console.log("Sync requested: " + env.acct + " " + payload.startblock + ":" + payload.endblock)
        res = await db.queryAccountHistory(env.acct, payload.startblock, payload.endblock)
        res.map(ev => {
          sendAccountEvent(env.acct, ev.type, ev.data)
        })
        returnObj = {
          status: true
        }
        break
      case 'accountledgersize':
        res = await db.queryAccountTotalEvents(env.acct)
        returnObj = {
          status: true,
          total: res
        }
        break
      case 'accountledger':
        res = await db.queryAccountLedger(env.acct, payload.page, payload.perPage)
        returnObj = {
          status: true,
          page: res.map(el => {
            return format.ledgerTx[el.type](env.acct, el.data)
          })
        }
        break
      case 'markethistory':
        if (!USE_DATABASE) throw new Error('No market tick DB')
        res = await db.queryMarketHistory(payload.market, payload.startblock,
          payload.endblock, payload.target)
        return {
          status: true,
          history: res
        }
      case 'createmarket':
        res = await queryCosmos("/microtick/generate/createmarket/" + 
          env.acct + "/" + payload.market)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'createquote':
        res = await queryCosmos("/microtick/generate/createquote/" +
          env.acct + "/" + 
          payload.market + "/" +
          payload.duration + "/" +
          payload.backing + "/" + 
          payload.spot + "/" +
          payload.premium)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'cancelquote':
        res = await queryCosmos("/microtick/generate/cancelquote/" +
          env.acct + "/" + 
          payload.id)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'depositquote':
        res = await queryCosmos("/microtick/generate/depositquote/" +
          env.acct + "/" +
          payload.id + "/" + 
          payload.deposit)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'withdrawquote':
        res = await queryCosmos("/microtick/generate/withdrawquote/" +
          env.acct + "/" +
          payload.id + "/" + 
          payload.withdraw)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: {
            height: curheight,
            hash: res.hash
          }
        }
      case 'updatequote':
        res = await queryCosmos("/microtick/generate/updatequote/" + 
          env.acct + "/" +
          payload.id + "/" + 
          payload.newspot + "/" +
          payload.newpremium)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'markettrade':
        res = await queryCosmos("/microtick/generate/markettrade/" + 
          env.acct + "/" +
          payload.market + "/" + 
          payload.duration + "/" +
          payload.tradetype + "/" + 
          payload.quantity)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'limittrade':
        res = await queryCosmos("/microtick/generate/limittrade/" +
          env.acct +"/" +
          payload.market + "/" +
          payload.duration + "/" +
          payload.tradetype + "/" + 
          payload.limit + "/" +
          payload.maxcost)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'settletrade':
        res = await queryCosmos("/microtick/generate/settletrade/" +
          env.acct + "/" +
          payload.id)
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: res
        }
      case 'postenvelope':
        // generate dummy create market tx to get the account number, sequence number and chain id
        res = await queryCosmos("/microtick/generate/createmarket/" + 
          env.acct + "/dmmmy")
        nextSequenceNumber(env.acct, res)
        return {
          status: true,
          msg: {
            accountNumber: res.accountNumber,
            chainId: res.chainId,
            sequence: res.sequence
          }
        }
      case 'posttx':
        res = await new Promise(async (outerResolve, outerReject) => {
          const pendingTx = {
            submitted: false,
            txid: txcounter++,
            submit: async (acct, sequence) => {
              if (pendingTx.submitted) return
              const txtype = payload.tx.value.msg[0].type
              console.log("Posting [" + env.id + "] TX " + txtype + ": sequence=" + sequence) 
              //console.log(JSON.stringify(payload, null, 2))
              pendingTx.submitted = true
              
              const bytes = marshalTx(payload.tx)
              //console.log(JSON.stringify(bytes))
              const hex = Buffer.from(bytes).toString('hex')
              //console.log("bytes=" + hex)
              res = await queryTendermint('/broadcast_tx_sync?tx=0x' + hex)
              if (res.code !== 0) {
                // error
                const log = JSON.parse(res.log)
                outerReject(log.message)
                console.log("  failed: " + log.message)
                return
              } else {
                if (LOG_TX) console.log("  hash=" + shortHash(res.hash))
              }
              try {
                const txres = await new Promise((resolve, reject) => {
                  const obj = {
                    success: txres => {
                      resolve(txres)
                    },
                    failure: err => {
                      reject(err)
                    },
                    timedout: false,
                    tries: 0
                  }
                  setTimeout(() => {obj.timedout = true}, TXTIMEOUT)
                  pending[res.hash] = obj
                })
                if (txres.tx_result.data !== null) {
                  txres.tx_result.data = JSON.parse(Buffer.from(txres.tx_result.data, 'base64').toString())
                }
                if (txres.tx_result.events !== undefined) {
                  for (var i=0; i<txres.tx_result.events.length; i++) {
                    var t = txres.tx_result.events[i]
                    if (t.type === "message") {
                      t.attributes = t.attributes.map(a => {
                        return {
                          key: Buffer.from(a.key, 'base64').toString(),
                          value: Buffer.from(a.value, 'base64').toString()
                        }
                      })
                    }
                  }
                }
                outerResolve(txres)
              } catch (err) {
                console.log("TX failed: " + acct + ": sequence=" + sequence)
                outerReject(err)
              }
            }
          }
          if (cache.accounts === undefined) {
            cache.accounts = {}
          }
          if (cache.accounts[env.acct] === undefined) {
            cache.accounts[env.acct] = {
              queue: {}
            }
          }
          const seq = parseInt(payload.sequence, 10)
          cache.accounts[env.acct].queue[seq] = pendingTx
          if (cache.accounts[env.acct].pendingSequenceNumber === undefined) {
            cache.accounts[env.acct].pendingSequenceNumber = seq
          }
          if (cache.accounts[env.acct].nextSequenceNumber === undefined) {
            cache.accounts[env.acct].pendingSequenceNumber + 1
          }
        })
        return {
          status: true,
          info: {
            height: res.height,
            hash: res.hash
          }
        }
    }
    
    // Save in cache
    if (name !== "posttx") {
      cache[hash] = returnObj
    }
    
    return returnObj
    
  } catch (err) {
    console.log("API error: " + name + ": " + err.message)
    //if (err !== undefined) console.log(err)
    return {
      status: false,
      error: err.message
    }
  }
}
