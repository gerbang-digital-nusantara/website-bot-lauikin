const { connectLambda } = require('@netlify/blobs');

function connectBlobs(event) {
  if (!event?.blobs) return;
  connectLambda(event);
}

module.exports = {
  connectBlobs
};
