const { WebSocketServer } = require('ws');

// Note: ws is standard, we will install it or use docker node container which can install it.
// To run it easily, we can write a simple native websocket-like server or use the 'ws' library.
// Since Node.js does not have built-in WebSocket server before newer experimental versions,
// we can write a simple HTTP server that handles WebSocket handshakes manually, 
// or write it using 'ws' and install it.
// Let's write a manual simple HTTP/WS server using only node native modules!
// This avoids any dependency installation issues!

const http = require('http');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('NCALayer Mock Server is running\n');
});

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n'
  );

  socket.on('data', (buffer) => {
    // Decode websocket frame (simplified, handles text frames up to 125 chars or extended length)
    let offset = 0;
    const byte1 = buffer[offset++];
    const byte2 = buffer[offset++];
    const isMasked = (byte2 & 0x80) !== 0;
    let payloadLength = byte2 & 0x7F;

    if (payloadLength === 126) {
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      payloadLength = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    let mask = null;
    if (isMasked) {
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    const payload = buffer.subarray(offset, offset + payloadLength);
    if (isMasked) {
      for (let i = 0; i < payloadLength; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    const text = payload.toString('utf8');
    try {
      const data = JSON.parse(text);
      let responseObj = {};

      if (data.method === 'signXml' || data.method === 'signXmls') {
        const xml = data.args[2] || '';
        const iin = '950412345678';
        const bin = '990840001234';
        const name = 'ИВАНОВ ИВАН ИВАНОВИЧ';
        
        // Mock a signed CMS container or simple enveloped signature
        const signedXml = `<signedXml><data>${Buffer.from(xml).toString('base64')}</data><signature iin="${iin}" bin="${bin}" name="${name}">MOCK_SIGNATURE_DATA_CN=SENIM_TEST_CERT_SERIAL_12345678</signature></signedXml>`;
        
        responseObj = {
          code: '200',
          message: 'success',
          responseObject: signedXml
        };
      } else {
        responseObj = {
          code: '200',
          message: 'success',
          responseObject: 'MOCK_OK'
        };
      }

      sendTextFrame(socket, JSON.stringify(responseObj));
    } catch (e) {
      console.error('Error parsing NCALayer message:', e);
    }
  });
});

function sendTextFrame(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;

  if (len <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // Text frame finish
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

const PORT = 13579;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`NCALayer mock running on ws://localhost:${PORT}`);
});
