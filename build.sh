#!/bin/sh

# Build the dist directory

rm -rf dist
mkdir dist

cat <<EOF > dist/package.json
{
  "name": "test",
  "version": "1.0.0",
  "description": "",
  "main": "test.js",
  "dependencies": {
    "bech32": "^1.1.3",
    "bip32": "^2.0.3",
    "bip39": "^3.0.2",
    "crypto-js": "^3.1.9-1",
    "secp256k1": "^3.7.1",
    "websocket": "^1.0.29"
  },
  "devDependencies": {},
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "author": "",
  "license": "ISC"
}
EOF

(cd dist && npm i)

cp client/api.js dist/index.js
cp client/wallet.js dist
cp lib/protocol.js dist